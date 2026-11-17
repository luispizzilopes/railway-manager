use application::ports::{ProjectRepository, RepoError, RepoResult};
use async_trait::async_trait;
use domain::catalog::Project;
use domain::ids::{ProjectId, RailwayProjectId};
use sqlx::AssertSqlSafe;
use sqlx::SqlitePool;
use sqlx::sqlite::SqliteRow;

use super::{ACTIVE_RESULTS, RowExt, db_err, opt_ts, ts};

#[derive(Clone)]
pub struct SqliteProjects {
    pool: SqlitePool,
}

impl SqliteProjects {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }
}

pub(crate) fn project_from_row(row: &SqliteRow, prefix: &str) -> RepoResult<Project> {
    let col = |name: &str| format!("{prefix}{name}");
    Ok(Project {
        id: row.parse(&col("id"))?,
        credential_id: row.opt_parse(&col("credential_id"))?,
        railway_project_id: row.parse(&col("railway_project_id"))?,
        name: row.text(&col("name"))?,
        display_name: row.opt_text(&col("display_name"))?,
        description: row.opt_text(&col("description"))?,
        created_at: row.time(&col("created_at"))?,
        last_synced_at: row.opt_time(&col("last_synced_at"))?,
        sync_status: row.parse(&col("sync_status"))?,
    })
}

#[async_trait]
impl ProjectRepository for SqliteProjects {
    async fn insert(&self, p: &Project) -> RepoResult<()> {
        sqlx::query(
            "INSERT INTO projects (id, credential_id, railway_project_id, name, display_name,
                                   description, created_at, last_synced_at, sync_status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(p.id.to_string())
        .bind(p.credential_id.map(|c| c.to_string()))
        .bind(p.railway_project_id.as_str())
        .bind(&p.name)
        .bind(&p.display_name)
        .bind(&p.description)
        .bind(ts(p.created_at))
        .bind(opt_ts(p.last_synced_at))
        .bind(p.sync_status.as_str())
        .execute(&self.pool)
        .await
        .map_err(|e| match db_err(e) {
            RepoError::Conflict(_) => {
                RepoError::Conflict(format!("projeto {} já cadastrado", p.railway_project_id))
            }
            other => other,
        })?;
        Ok(())
    }

    async fn get(&self, id: ProjectId) -> RepoResult<Option<Project>> {
        sqlx::query("SELECT * FROM projects WHERE id = ?")
            .bind(id.to_string())
            .fetch_optional(&self.pool)
            .await
            .map_err(db_err)?
            .map(|r| project_from_row(&r, ""))
            .transpose()
    }

    async fn find_by_railway_id(&self, id: &RailwayProjectId) -> RepoResult<Option<Project>> {
        sqlx::query("SELECT * FROM projects WHERE railway_project_id = ?")
            .bind(id.as_str())
            .fetch_optional(&self.pool)
            .await
            .map_err(db_err)?
            .map(|r| project_from_row(&r, ""))
            .transpose()
    }

    async fn list(&self) -> RepoResult<Vec<Project>> {
        sqlx::query("SELECT * FROM projects ORDER BY COALESCE(display_name, name) COLLATE NOCASE")
            .fetch_all(&self.pool)
            .await
            .map_err(db_err)?
            .iter()
            .map(|r| project_from_row(r, ""))
            .collect()
    }

    async fn update(&self, p: &Project) -> RepoResult<()> {
        let result = sqlx::query(
            "UPDATE projects SET credential_id = ?, name = ?, display_name = ?, description = ?,
                                 last_synced_at = ?, sync_status = ?
             WHERE id = ?",
        )
        .bind(p.credential_id.map(|c| c.to_string()))
        .bind(&p.name)
        .bind(&p.display_name)
        .bind(&p.description)
        .bind(opt_ts(p.last_synced_at))
        .bind(p.sync_status.as_str())
        .bind(p.id.to_string())
        .execute(&self.pool)
        .await
        .map_err(db_err)?;
        if result.rows_affected() == 0 {
            Err(RepoError::NotFound)
        } else {
            Ok(())
        }
    }

    async fn delete(&self, id: ProjectId) -> RepoResult<()> {
        let mut tx = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(db_err)?;
        let exists: Option<i64> = sqlx::query_scalar("SELECT 1 FROM projects WHERE id = ?")
            .bind(id.to_string())
            .fetch_optional(&mut *tx)
            .await
            .map_err(db_err)?;
        if exists.is_none() {
            return Err(RepoError::NotFound);
        }
        let busy: i64 = sqlx::query_scalar(AssertSqlSafe(format!(
            "SELECT COUNT(*) FROM operation_items oi
               JOIN service_instances si ON si.id = oi.service_instance_id
              WHERE si.project_id = ? AND oi.result IN {ACTIVE_RESULTS}"
        )))
        .bind(id.to_string())
        .fetch_one(&mut *tx)
        .await
        .map_err(db_err)?;
        if busy > 0 {
            return Err(RepoError::Conflict(
                "há operação em andamento no projeto".into(),
            ));
        }
        sqlx::query("DELETE FROM projects WHERE id = ?")
            .bind(id.to_string())
            .execute(&mut *tx)
            .await
            .map_err(db_err)?;
        tx.commit().await.map_err(db_err)
    }
}
