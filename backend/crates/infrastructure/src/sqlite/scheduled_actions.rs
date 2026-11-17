use application::ports::{Page, RepoError, RepoResult, ScheduledActionRepository};
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use domain::ids::ScheduledActionId;
use domain::scheduled_action::{ActionTarget, ScheduledAction, ScheduledActionStatus};
use sqlx::sqlite::SqliteRow;
use sqlx::{SqliteConnection, SqlitePool};

use super::{RowExt, db_err, opt_ts, ts};

#[derive(Clone)]
pub struct SqliteScheduledActions {
    pool: SqlitePool,
}

impl SqliteScheduledActions {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }
}

fn corrupt(detail: impl std::fmt::Display) -> RepoError {
    RepoError::Database(format!("ação agendada inválida no banco: {detail}"))
}

async fn ids<T: std::str::FromStr>(
    conn: &mut SqliteConnection,
    sql: &'static str,
    action: &str,
) -> RepoResult<Vec<T>>
where
    T::Err: std::fmt::Display,
{
    let raw: Vec<String> = sqlx::query_scalar(sql)
        .bind(action)
        .fetch_all(&mut *conn)
        .await
        .map_err(db_err)?;
    raw.iter().map(|i| i.parse().map_err(corrupt)).collect()
}

async fn load(conn: &mut SqliteConnection, row: &SqliteRow) -> RepoResult<ScheduledAction> {
    let id: String = row.text("id")?;
    let environment_name = row.opt_text("environment_name")?;
    let target = match row.text("target_kind")?.as_str() {
        "all" => ActionTarget::All { environment_name },
        "projects" => ActionTarget::Projects {
            project_ids: ids(
                conn,
                "SELECT project_id FROM scheduled_action_projects WHERE action_id = ? ORDER BY rowid",
                &id,
            )
            .await?,
            environment_name,
        },
        "instances" => ActionTarget::Instances {
            instance_ids: ids(
                conn,
                "SELECT service_instance_id FROM scheduled_action_instances WHERE action_id = ? ORDER BY rowid",
                &id,
            )
            .await?,
        },
        other => return Err(corrupt(other)),
    };
    Ok(ScheduledAction {
        id: id.parse().map_err(corrupt)?,
        kind: row.parse("kind")?,
        run_at: row.time("run_at")?,
        target,
        note: row.opt_text("note")?,
        label: row.text("label")?,
        status: row.parse("status")?,
        message: row.opt_text("message")?,
        operation_id: row.opt_parse("operation_id")?,
        created_at: row.time("created_at")?,
        processed_at: row.opt_time("processed_at")?,
    })
}

impl SqliteScheduledActions {
    async fn load_all(&self, rows: Vec<SqliteRow>) -> RepoResult<Vec<ScheduledAction>> {
        let mut conn = self.pool.acquire().await.map_err(db_err)?;
        let mut out = Vec::with_capacity(rows.len());
        for row in &rows {
            out.push(load(&mut conn, row).await?);
        }
        Ok(out)
    }
}

#[async_trait]
impl ScheduledActionRepository for SqliteScheduledActions {
    async fn insert(&self, a: &ScheduledAction) -> RepoResult<()> {
        let mut tx = self.pool.begin().await.map_err(db_err)?;
        sqlx::query(
            "INSERT INTO scheduled_actions (id, kind, run_at, target_kind, environment_name, note,
                                            label, status, message, operation_id, created_at,
                                            processed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(a.id.to_string())
        .bind(a.kind.as_str())
        .bind(ts(a.run_at))
        .bind(a.target.kind())
        .bind(a.target.environment_name())
        .bind(&a.note)
        .bind(&a.label)
        .bind(a.status.as_str())
        .bind(&a.message)
        .bind(a.operation_id.map(|o| o.to_string()))
        .bind(ts(a.created_at))
        .bind(opt_ts(a.processed_at))
        .execute(&mut *tx)
        .await
        .map_err(db_err)?;
        match &a.target {
            ActionTarget::All { .. } => {}
            ActionTarget::Projects { project_ids, .. } => {
                for p in project_ids {
                    sqlx::query(
                        "INSERT INTO scheduled_action_projects (action_id, project_id) VALUES (?, ?)",
                    )
                    .bind(a.id.to_string())
                    .bind(p.to_string())
                    .execute(&mut *tx)
                    .await
                    .map_err(db_err)?;
                }
            }
            ActionTarget::Instances { instance_ids } => {
                for i in instance_ids {
                    sqlx::query(
                        "INSERT INTO scheduled_action_instances (action_id, service_instance_id)
                         VALUES (?, ?)",
                    )
                    .bind(a.id.to_string())
                    .bind(i.to_string())
                    .execute(&mut *tx)
                    .await
                    .map_err(db_err)?;
                }
            }
        }
        tx.commit().await.map_err(db_err)
    }

    async fn get(&self, id: ScheduledActionId) -> RepoResult<Option<ScheduledAction>> {
        let row = sqlx::query("SELECT * FROM scheduled_actions WHERE id = ?")
            .bind(id.to_string())
            .fetch_optional(&self.pool)
            .await
            .map_err(db_err)?;
        Ok(self.load_all(row.into_iter().collect()).await?.pop())
    }

    async fn list(
        &self,
        status: Option<ScheduledActionStatus>,
        page: u32,
        per_page: u32,
    ) -> RepoResult<Page<ScheduledAction>> {
        let page = page.max(1);
        let per_page = per_page.clamp(1, 200);
        let status = status.map(|s| s.as_str());
        let total: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM scheduled_actions WHERE ?1 IS NULL OR status = ?1",
        )
        .bind(status)
        .fetch_one(&self.pool)
        .await
        .map_err(db_err)?;
        let rows = sqlx::query(
            "SELECT * FROM scheduled_actions WHERE ?1 IS NULL OR status = ?1
              ORDER BY status IN ('pending', 'processing') DESC,
                       CASE WHEN status IN ('pending', 'processing') THEN run_at END ASC,
                       run_at DESC
              LIMIT ?2 OFFSET ?3",
        )
        .bind(status)
        .bind(i64::from(per_page))
        .bind(i64::from((page - 1) * per_page))
        .fetch_all(&self.pool)
        .await
        .map_err(db_err)?;
        Ok(Page {
            items: self.load_all(rows).await?,
            total: total as u64,
            page,
            per_page,
        })
    }

    async fn due(&self, now: DateTime<Utc>) -> RepoResult<Vec<ScheduledAction>> {
        let rows = sqlx::query(
            "SELECT * FROM scheduled_actions WHERE status = 'pending' AND run_at <= ?
              ORDER BY run_at, created_at",
        )
        .bind(ts(now))
        .fetch_all(&self.pool)
        .await
        .map_err(db_err)?;
        self.load_all(rows).await
    }

    async fn claim(&self, id: ScheduledActionId) -> RepoResult<bool> {
        let result = sqlx::query(
            "UPDATE scheduled_actions SET status = 'processing' WHERE id = ? AND status = 'pending'",
        )
        .bind(id.to_string())
        .execute(&self.pool)
        .await
        .map_err(db_err)?;
        Ok(result.rows_affected() == 1)
    }

    async fn finish(&self, a: &ScheduledAction) -> RepoResult<()> {
        let result = sqlx::query(
            "UPDATE scheduled_actions
                SET status = ?, message = ?, operation_id = ?, processed_at = ?
              WHERE id = ? AND status = 'processing'",
        )
        .bind(a.status.as_str())
        .bind(&a.message)
        .bind(a.operation_id.map(|o| o.to_string()))
        .bind(opt_ts(a.processed_at))
        .bind(a.id.to_string())
        .execute(&self.pool)
        .await
        .map_err(db_err)?;
        if result.rows_affected() == 0 {
            Err(RepoError::NotFound)
        } else {
            Ok(())
        }
    }

    async fn cancel(
        &self,
        id: ScheduledActionId,
        now: DateTime<Utc>,
    ) -> RepoResult<Result<ScheduledAction, ScheduledActionStatus>> {
        let changed = sqlx::query(
            "UPDATE scheduled_actions SET status = 'cancelled', processed_at = ?
              WHERE id = ? AND status = 'pending'",
        )
        .bind(ts(now))
        .bind(id.to_string())
        .execute(&self.pool)
        .await
        .map_err(db_err)?
        .rows_affected();
        let action = self.get(id).await?.ok_or(RepoError::NotFound)?;
        Ok(if changed == 1 {
            Ok(action)
        } else {
            Err(action.status)
        })
    }

    async fn fail_processing(&self, message: &str, now: DateTime<Utc>) -> RepoResult<u64> {
        let result = sqlx::query(
            "UPDATE scheduled_actions SET status = 'failed', message = COALESCE(message, ?), processed_at = ?
              WHERE status = 'processing'",
        )
        .bind(message)
        .bind(ts(now))
        .execute(&self.pool)
        .await
        .map_err(db_err)?;
        Ok(result.rows_affected())
    }
}
