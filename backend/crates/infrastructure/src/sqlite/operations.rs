use application::ports::{
    HistoryEntry, HistoryFilter, OperationRepository, Page, RepoError, RepoResult,
};
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use domain::ids::{OperationId, PlanId, ServiceInstanceId};
use domain::operation::{InstanceLabel, Operation, OperationItem, OperationStatus};
use sqlx::AssertSqlSafe;
use sqlx::sqlite::SqliteRow;
use sqlx::{QueryBuilder, Sqlite, SqlitePool};

use super::{ACTIVE_RESULTS, RowExt, db_err, opt_ts, ts};

#[derive(Clone)]
pub struct SqliteOperations {
    pool: SqlitePool,
}

impl SqliteOperations {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }
}

fn operation_from_row(row: &SqliteRow, prefix: &str) -> RepoResult<Operation> {
    let col = |name: &str| format!("{prefix}{name}");
    Ok(Operation {
        id: row.parse(&col("id"))?,
        kind: row.parse(&col("kind"))?,
        scope: row.parse(&col("scope"))?,
        trigger: row.parse(&col("trigger"))?,
        schedule_id: row.opt_parse(&col("schedule_id"))?,
        schedule_name: row.opt_text(&col("schedule_name"))?,
        requested_by: row.text(&col("requested_by"))?,
        plan_id: row.parse(&col("plan_id"))?,
        status: row.parse(&col("status"))?,
        created_at: row.time(&col("created_at"))?,
        started_at: row.opt_time(&col("started_at"))?,
        finished_at: row.opt_time(&col("finished_at"))?,
    })
}

fn item_from_row(row: &SqliteRow) -> RepoResult<OperationItem> {
    Ok(OperationItem {
        id: row.parse("id")?,
        operation_id: row.parse("operation_id")?,
        service_instance_id: row.opt_parse("service_instance_id")?,
        label: InstanceLabel {
            project_id: row.parse("project_id")?,
            project_name: row.text("project_name")?,
            railway_project_id: row.parse("railway_project_id")?,
            service_name: row.text("service_name")?,
            railway_service_id: row.parse("railway_service_id")?,
            environment_name: row.text("environment_name")?,
            railway_environment_id: row.parse("railway_environment_id")?,
        },
        previous_state: row.parse("previous_state")?,
        desired_state: row.parse("desired_state")?,
        final_state: row.opt_parse("final_state")?,
        deployment_id: row.opt_parse("deployment_id")?,
        result: row.parse("result")?,
        error_message: row.opt_text("error_message")?,
        started_at: row.opt_time("started_at")?,
        finished_at: row.opt_time("finished_at")?,
        duration_ms: row.opt_int("duration_ms")?,
    })
}

impl SqliteOperations {
    async fn items(&self, operation: OperationId) -> RepoResult<Vec<OperationItem>> {
        sqlx::query(
            "SELECT * FROM operation_items WHERE operation_id = ?
              ORDER BY project_name COLLATE NOCASE, environment_name COLLATE NOCASE,
                       service_name COLLATE NOCASE",
        )
        .bind(operation.to_string())
        .fetch_all(&self.pool)
        .await
        .map_err(db_err)?
        .iter()
        .map(item_from_row)
        .collect()
    }
}

fn push_filters(query: &mut QueryBuilder<Sqlite>, f: &HistoryFilter) {
    query.push(" WHERE 1 = 1");
    if let Some(v) = &f.railway_project_id {
        query
            .push(" AND oi.railway_project_id = ")
            .push_bind(v.to_string());
    }
    if let Some(v) = &f.railway_service_id {
        query
            .push(" AND oi.railway_service_id = ")
            .push_bind(v.to_string());
    }
    if let Some(v) = &f.environment_name {
        query
            .push(" AND oi.environment_name = ")
            .push_bind(v.clone())
            .push(" COLLATE NOCASE");
    }
    if let Some(v) = f.kind {
        query.push(" AND o.kind = ").push_bind(v.as_str());
    }
    if let Some(v) = f.result {
        query.push(" AND oi.result = ").push_bind(v.as_str());
    }
    if let Some(v) = f.trigger {
        query.push(" AND o.trigger = ").push_bind(v.as_str());
    }
    if let Some(v) = f.from {
        query.push(" AND o.created_at >= ").push_bind(ts(v));
    }
    if let Some(v) = f.to {
        query.push(" AND o.created_at <= ").push_bind(ts(v));
    }
}

#[async_trait]
impl OperationRepository for SqliteOperations {
    async fn get(&self, id: OperationId) -> RepoResult<Option<(Operation, Vec<OperationItem>)>> {
        let Some(row) = sqlx::query("SELECT * FROM operations WHERE id = ?")
            .bind(id.to_string())
            .fetch_optional(&self.pool)
            .await
            .map_err(db_err)?
        else {
            return Ok(None);
        };
        Ok(Some((operation_from_row(&row, "")?, self.items(id).await?)))
    }

    async fn find_by_plan(&self, plan: PlanId) -> RepoResult<Option<OperationId>> {
        let id: Option<String> = sqlx::query_scalar("SELECT id FROM operations WHERE plan_id = ?")
            .bind(plan.to_string())
            .fetch_optional(&self.pool)
            .await
            .map_err(db_err)?;
        id.map(|id| id.parse().map_err(|e| RepoError::Database(format!("{e}"))))
            .transpose()
    }

    async fn update_item(&self, i: &OperationItem) -> RepoResult<()> {
        let result = sqlx::query(
            "UPDATE operation_items
                SET final_state = ?, deployment_id = ?, result = ?, error_message = ?,
                    started_at = ?, finished_at = ?, duration_ms = ?
              WHERE id = ?",
        )
        .bind(i.final_state.map(|s| s.as_str()))
        .bind(i.deployment_id.as_ref().map(|d| d.to_string()))
        .bind(i.result.as_str())
        .bind(&i.error_message)
        .bind(opt_ts(i.started_at))
        .bind(opt_ts(i.finished_at))
        .bind(i.duration_ms)
        .bind(i.id.to_string())
        .execute(&self.pool)
        .await
        .map_err(db_err)?;
        if result.rows_affected() == 0 {
            Err(RepoError::NotFound)
        } else {
            Ok(())
        }
    }

    async fn update_status(
        &self,
        id: OperationId,
        status: OperationStatus,
        started_at: Option<DateTime<Utc>>,
        finished_at: Option<DateTime<Utc>>,
    ) -> RepoResult<()> {
        sqlx::query(
            "UPDATE operations
                SET status = ?, started_at = COALESCE(?, started_at),
                    finished_at = COALESCE(?, finished_at)
              WHERE id = ?",
        )
        .bind(status.as_str())
        .bind(opt_ts(started_at))
        .bind(opt_ts(finished_at))
        .bind(id.to_string())
        .execute(&self.pool)
        .await
        .map_err(db_err)?;
        Ok(())
    }

    async fn interrupt_unfinished(&self, now: DateTime<Utc>) -> RepoResult<u64> {
        let mut tx = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(db_err)?;
        let now = ts(now);
        let interrupted = sqlx::query(AssertSqlSafe(format!(
            "UPDATE operation_items
                SET result = 'interrupted', finished_at = ?,
                    error_message = COALESCE(error_message, 'interrompido por reinício do servidor')
              WHERE result IN {ACTIVE_RESULTS}"
        )))
        .bind(&now)
        .execute(&mut *tx)
        .await
        .map_err(db_err)?
        .rows_affected();

        // Finaliza operações sem itens ativos com o agregado dos resultados.
        let open: Vec<String> =
            sqlx::query_scalar("SELECT id FROM operations WHERE status IN ('pending', 'running')")
                .fetch_all(&mut *tx)
                .await
                .map_err(db_err)?;
        for id in open {
            let results: Vec<String> =
                sqlx::query_scalar("SELECT result FROM operation_items WHERE operation_id = ?")
                    .bind(&id)
                    .fetch_all(&mut *tx)
                    .await
                    .map_err(db_err)?;
            let parsed = results
                .iter()
                .map(|r| r.parse().map_err(|e: String| RepoError::Database(e)))
                .collect::<RepoResult<Vec<_>>>()?;
            let status = OperationStatus::aggregate(parsed).unwrap_or(OperationStatus::Failed);
            sqlx::query("UPDATE operations SET status = ?, finished_at = ? WHERE id = ?")
                .bind(status.as_str())
                .bind(&now)
                .bind(&id)
                .execute(&mut *tx)
                .await
                .map_err(db_err)?;
        }
        tx.commit().await.map_err(db_err)?;
        Ok(interrupted)
    }

    async fn history(
        &self,
        filter: &HistoryFilter,
        page: u32,
        per_page: u32,
    ) -> RepoResult<Page<HistoryEntry>> {
        let page = page.max(1);
        let per_page = per_page.clamp(1, 200);

        let mut count = QueryBuilder::<Sqlite>::new(
            "SELECT COUNT(*) FROM operation_items oi JOIN operations o ON o.id = oi.operation_id",
        );
        push_filters(&mut count, filter);
        let total: i64 = count
            .build_query_scalar()
            .fetch_one(&self.pool)
            .await
            .map_err(db_err)?;

        let mut query = QueryBuilder::<Sqlite>::new(
            "SELECT oi.*, o.kind AS o_kind, o.scope AS o_scope, o.requested_by AS o_requested_by, o.trigger AS o_trigger,
                    o.schedule_name AS o_schedule_name, o.status AS o_status, o.created_at AS o_created_at
               FROM operation_items oi JOIN operations o ON o.id = oi.operation_id",
        );
        push_filters(&mut query, filter);
        query
            .push(" ORDER BY o.created_at DESC, oi.project_name, oi.service_name LIMIT ")
            .push_bind(i64::from(per_page))
            .push(" OFFSET ")
            .push_bind(i64::from((page - 1) * per_page));

        let items = query
            .build()
            .fetch_all(&self.pool)
            .await
            .map_err(db_err)?
            .iter()
            .map(|row| {
                Ok(HistoryEntry {
                    item: item_from_row(row)?,
                    kind: row.parse("o_kind")?,
                    scope: row.parse("o_scope")?,
                    requested_by: row.text("o_requested_by")?,
                    trigger: row.parse("o_trigger")?,
                    schedule_name: row.opt_text("o_schedule_name")?,
                    operation_status: row.parse("o_status")?,
                    created_at: row.time("o_created_at")?,
                })
            })
            .collect::<RepoResult<_>>()?;
        Ok(Page {
            items,
            total: total as u64,
            page,
            per_page,
        })
    }

    async fn recent(&self, limit: u32) -> RepoResult<Vec<(Operation, Vec<OperationItem>)>> {
        let rows = sqlx::query("SELECT * FROM operations ORDER BY created_at DESC LIMIT ?")
            .bind(i64::from(limit))
            .fetch_all(&self.pool)
            .await
            .map_err(db_err)?;
        let mut out = Vec::with_capacity(rows.len());
        for row in &rows {
            let op = operation_from_row(row, "")?;
            let items = self.items(op.id).await?;
            out.push((op, items));
        }
        Ok(out)
    }

    async fn active_instance_ids(&self) -> RepoResult<Vec<ServiceInstanceId>> {
        let ids: Vec<String> = sqlx::query_scalar(AssertSqlSafe(format!(
            "SELECT service_instance_id FROM operation_items
              WHERE service_instance_id IS NOT NULL AND result IN {ACTIVE_RESULTS}"
        )))
        .fetch_all(&self.pool)
        .await
        .map_err(db_err)?;
        ids.iter()
            .map(|id| id.parse().map_err(|e| RepoError::Database(format!("{e}"))))
            .collect()
    }
}
