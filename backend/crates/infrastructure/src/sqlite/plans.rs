use application::ports::{ConsumeOutcome, PlanRepository, RepoError, RepoResult};
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use domain::ids::{OperationId, PlanId};
use domain::operation::{ItemResult, Operation, OperationItem, OperationScope, Plan};
use domain::power::SkipReason;
use sqlx::{SqliteConnection, SqlitePool};

use super::{RowExt, db_err, opt_ts, ts};

#[derive(Clone)]
pub struct SqlitePlans {
    pool: SqlitePool,
}

impl SqlitePlans {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }
}

pub(crate) async fn insert_item(conn: &mut SqliteConnection, i: &OperationItem) -> RepoResult<()> {
    let l = &i.label;
    sqlx::query(
        "INSERT INTO operation_items (id, operation_id, service_instance_id, project_id,
            project_name, railway_project_id, service_name, railway_service_id,
            environment_name, railway_environment_id, previous_state, desired_state,
            final_state, deployment_id, result, error_message, started_at, finished_at,
            duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(i.id.to_string())
    .bind(i.operation_id.to_string())
    .bind(i.service_instance_id.map(|s| s.to_string()))
    .bind(l.project_id.to_string())
    .bind(&l.project_name)
    .bind(l.railway_project_id.as_str())
    .bind(&l.service_name)
    .bind(l.railway_service_id.as_str())
    .bind(&l.environment_name)
    .bind(l.railway_environment_id.as_str())
    .bind(i.previous_state.as_str())
    .bind(i.desired_state.as_str())
    .bind(i.final_state.map(|s| s.as_str()))
    .bind(i.deployment_id.as_ref().map(|d| d.to_string()))
    .bind(i.result.as_str())
    .bind(&i.error_message)
    .bind(opt_ts(i.started_at))
    .bind(opt_ts(i.finished_at))
    .bind(i.duration_ms)
    .execute(conn)
    .await
    .map_err(db_err)?;
    Ok(())
}

async fn operation_for_plan(
    conn: &mut SqliteConnection,
    plan: PlanId,
) -> RepoResult<Option<OperationId>> {
    let id: Option<String> = sqlx::query_scalar("SELECT id FROM operations WHERE plan_id = ?")
        .bind(plan.to_string())
        .fetch_optional(conn)
        .await
        .map_err(db_err)?;
    id.map(|id| id.parse().map_err(|e| RepoError::Database(format!("{e}"))))
        .transpose()
}

#[async_trait]
impl PlanRepository for SqlitePlans {
    async fn save(&self, plan: &Plan) -> RepoResult<()> {
        let payload =
            serde_json::to_string(plan).map_err(|e| RepoError::Database(e.to_string()))?;
        sqlx::query(
            "INSERT INTO operation_plans (id, payload_json, created_at, expires_at)
             VALUES (?, ?, ?, ?)",
        )
        .bind(plan.id.to_string())
        .bind(payload)
        .bind(ts(plan.created_at))
        .bind(ts(plan.expires_at))
        .execute(&self.pool)
        .await
        .map_err(db_err)?;
        Ok(())
    }

    async fn get(&self, id: PlanId) -> RepoResult<Option<Plan>> {
        let payload: Option<String> =
            sqlx::query_scalar("SELECT payload_json FROM operation_plans WHERE id = ?")
                .bind(id.to_string())
                .fetch_optional(&self.pool)
                .await
                .map_err(db_err)?;
        payload
            .map(|p| serde_json::from_str(&p).map_err(|e| RepoError::Database(e.to_string())))
            .transpose()
    }

    async fn consume(
        &self,
        plan_id: PlanId,
        now: DateTime<Utc>,
        operation: &Operation,
        items: &[OperationItem],
    ) -> RepoResult<ConsumeOutcome> {
        // BEGIN IMMEDIATE serializa consumidores concorrentes do mesmo plano.
        let mut tx = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(db_err)?;

        let row = sqlx::query("SELECT expires_at, consumed_at FROM operation_plans WHERE id = ?")
            .bind(plan_id.to_string())
            .fetch_optional(&mut *tx)
            .await
            .map_err(db_err)?;
        let Some(row) = row else {
            return Ok(ConsumeOutcome::NotFound);
        };
        if row.opt_text("consumed_at")?.is_some() {
            let operation_id = operation_for_plan(&mut tx, plan_id).await?;
            return Ok(ConsumeOutcome::AlreadyConsumed { operation_id });
        }
        if row.time("expires_at")? <= now {
            return Ok(ConsumeOutcome::Expired);
        }

        sqlx::query("UPDATE operation_plans SET consumed_at = ? WHERE id = ?")
            .bind(ts(now))
            .bind(plan_id.to_string())
            .execute(&mut *tx)
            .await
            .map_err(db_err)?;

        sqlx::query(
            "INSERT INTO operations (id, kind, scope, trigger, schedule_id, schedule_name,
                                     requested_by, plan_id, status, created_at, started_at,
                                     finished_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(operation.id.to_string())
        .bind(operation.kind.as_str())
        .bind(operation.scope.as_str())
        .bind(operation.trigger.as_str())
        .bind(operation.schedule_id.map(|id| id.to_string()))
        .bind(&operation.schedule_name)
        .bind(&operation.requested_by)
        .bind(plan_id.to_string())
        .bind(operation.status.as_str())
        .bind(ts(operation.created_at))
        .bind(opt_ts(operation.started_at))
        .bind(opt_ts(operation.finished_at))
        .execute(&mut *tx)
        .await
        .map_err(db_err)?;

        let mut conflicts = Vec::new();
        for item in items {
            match insert_item(&mut tx, item).await {
                Ok(()) => {}
                Err(RepoError::Conflict(_)) if item.result.is_active() => {
                    if operation.scope == OperationScope::Instance {
                        // Sem commit: o plano continua não consumido e nada é criado.
                        return Ok(ConsumeOutcome::Conflict);
                    }
                    let mut skipped = item.clone();
                    skipped.result = ItemResult::Skipped;
                    skipped.error_message = Some(SkipReason::OperationInProgress.message());
                    skipped.finished_at = Some(now);
                    insert_item(&mut tx, &skipped).await?;
                    conflicts.extend(item.service_instance_id);
                }
                Err(err) => return Err(err),
            }
        }

        tx.commit().await.map_err(db_err)?;
        Ok(ConsumeOutcome::Created {
            operation_id: operation.id,
            conflicts,
        })
    }
}
