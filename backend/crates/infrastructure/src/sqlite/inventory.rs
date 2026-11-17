use application::ports::{
    InstanceObservation, InstanceView, InventoryRepository, RepoError, RepoResult,
};
use async_trait::async_trait;
use domain::catalog::{Environment, Service, ServiceInstance};
use domain::ids::{
    EnvironmentId, ProjectId, RailwayEnvironmentId, RailwayServiceId, ServiceId, ServiceInstanceId,
};
use sqlx::AssertSqlSafe;
use sqlx::sqlite::SqliteRow;
use sqlx::{QueryBuilder, Sqlite, SqlitePool};

use super::projects::project_from_row;
use super::{ACTIVE_RESULTS, RowExt, db_err, opt_ts, ts};

#[derive(Clone)]
pub struct SqliteInventory {
    pool: SqlitePool,
}

impl SqliteInventory {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }
}

fn environment_from_row(row: &SqliteRow, prefix: &str) -> RepoResult<Environment> {
    let col = |name: &str| format!("{prefix}{name}");
    Ok(Environment {
        id: row.parse(&col("id"))?,
        project_id: row.parse(&col("project_id"))?,
        railway_environment_id: row.parse(&col("railway_environment_id"))?,
        name: row.text(&col("name"))?,
        is_ephemeral: row.flag(&col("is_ephemeral"))?,
    })
}

fn service_from_row(row: &SqliteRow, prefix: &str) -> RepoResult<Service> {
    let col = |name: &str| format!("{prefix}{name}");
    Ok(Service {
        id: row.parse(&col("id"))?,
        project_id: row.parse(&col("project_id"))?,
        railway_service_id: row.parse(&col("railway_service_id"))?,
        name: row.text(&col("name"))?,
    })
}

fn view_from_row(row: &SqliteRow) -> RepoResult<InstanceView> {
    Ok(InstanceView {
        instance: ServiceInstance {
            id: row.parse("id")?,
            service_id: row.parse("service_id")?,
            environment_id: row.parse("environment_id")?,
            observed_state: row.parse("observed_state")?,
            not_found: row.flag("not_found")?,
            latest_deployment_id: row.opt_parse("latest_deployment_id")?,
            latest_deployment_status: row.opt_parse("latest_deployment_status")?,
            last_observed_at: row.opt_time("last_observed_at")?,
            last_sync_error: row.opt_text("last_sync_error")?,
        },
        project: project_from_row(row, "p_")?,
        service: service_from_row(row, "s_")?,
        environment: environment_from_row(row, "e_")?,
    })
}

const VIEW_SELECT: &str = "
    SELECT si.*,
           p.id AS p_id, p.credential_id AS p_credential_id,
           p.railway_project_id AS p_railway_project_id, p.name AS p_name,
           p.display_name AS p_display_name, p.description AS p_description,
           p.created_at AS p_created_at, p.last_synced_at AS p_last_synced_at,
           p.sync_status AS p_sync_status,
           s.id AS s_id, s.project_id AS s_project_id,
           s.railway_service_id AS s_railway_service_id, s.name AS s_name,
           e.id AS e_id, e.project_id AS e_project_id,
           e.railway_environment_id AS e_railway_environment_id, e.name AS e_name,
           e.is_ephemeral AS e_is_ephemeral
      FROM service_instances si
      JOIN services s ON s.id = si.service_id
      JOIN environments e ON e.id = si.environment_id
      JOIN projects p ON p.id = si.project_id";

const VIEW_ORDER: &str = " ORDER BY COALESCE(p.display_name, p.name) COLLATE NOCASE, e.name COLLATE NOCASE, s.name COLLATE NOCASE";

async fn has_active(pool: &SqlitePool, filter_sql: &str, id: String) -> RepoResult<bool> {
    let count: i64 = sqlx::query_scalar(AssertSqlSafe(format!(
        "SELECT COUNT(*) FROM operation_items oi
           JOIN service_instances si ON si.id = oi.service_instance_id
          WHERE {filter_sql} AND oi.result IN {ACTIVE_RESULTS}"
    )))
    .bind(id)
    .fetch_one(pool)
    .await
    .map_err(db_err)?;
    Ok(count > 0)
}

#[async_trait]
impl InventoryRepository for SqliteInventory {
    async fn upsert_environment(&self, env: &Environment) -> RepoResult<Environment> {
        let row = sqlx::query(
            "INSERT INTO environments (id, project_id, railway_environment_id, name, is_ephemeral)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (railway_environment_id)
             DO UPDATE SET name = excluded.name, is_ephemeral = excluded.is_ephemeral
             WHERE environments.project_id = excluded.project_id
             RETURNING *",
        )
        .bind(env.id.to_string())
        .bind(env.project_id.to_string())
        .bind(env.railway_environment_id.as_str())
        .bind(&env.name)
        .bind(env.is_ephemeral)
        .fetch_optional(&self.pool)
        .await
        .map_err(db_err)?
        .ok_or_else(|| RepoError::Conflict("ambiente pertence a outro projeto".into()))?;
        environment_from_row(&row, "")
    }

    async fn upsert_service(&self, service: &Service) -> RepoResult<Service> {
        let row = sqlx::query(
            "INSERT INTO services (id, project_id, railway_service_id, name)
             VALUES (?, ?, ?, ?)
             ON CONFLICT (project_id, railway_service_id) DO UPDATE SET name = excluded.name
             RETURNING *",
        )
        .bind(service.id.to_string())
        .bind(service.project_id.to_string())
        .bind(service.railway_service_id.as_str())
        .bind(&service.name)
        .fetch_one(&self.pool)
        .await
        .map_err(db_err)?;
        service_from_row(&row, "")
    }

    async fn insert_instance(&self, i: &ServiceInstance) -> RepoResult<()> {
        let project: Option<String> =
            sqlx::query_scalar("SELECT project_id FROM services WHERE id = ?")
                .bind(i.service_id.to_string())
                .fetch_optional(&self.pool)
                .await
                .map_err(db_err)?;
        let project = project.ok_or(RepoError::NotFound)?;
        sqlx::query(
            "INSERT INTO service_instances (id, project_id, service_id, environment_id,
                observed_state, not_found, latest_deployment_id, latest_deployment_status,
                last_observed_at, last_sync_error)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(i.id.to_string())
        .bind(project)
        .bind(i.service_id.to_string())
        .bind(i.environment_id.to_string())
        .bind(i.observed_state.as_str())
        .bind(i.not_found)
        .bind(i.latest_deployment_id.as_ref().map(|d| d.to_string()))
        .bind(i.latest_deployment_status.map(|s| s.as_str()))
        .bind(opt_ts(i.last_observed_at))
        .bind(&i.last_sync_error)
        .execute(&self.pool)
        .await
        .map_err(|e| match db_err(e) {
            RepoError::Conflict(_) => {
                RepoError::Conflict("o serviço já está associado a este ambiente".into())
            }
            // FK composta: ambiente de outro projeto.
            RepoError::Database(msg) if msg.contains("FOREIGN KEY") => {
                RepoError::Conflict("serviço e ambiente pertencem a projetos diferentes".into())
            }
            other => other,
        })?;
        Ok(())
    }

    async fn list_environments(&self, project: ProjectId) -> RepoResult<Vec<Environment>> {
        sqlx::query("SELECT * FROM environments WHERE project_id = ? ORDER BY name COLLATE NOCASE")
            .bind(project.to_string())
            .fetch_all(&self.pool)
            .await
            .map_err(db_err)?
            .iter()
            .map(|r| environment_from_row(r, ""))
            .collect()
    }

    async fn list_services(&self, project: ProjectId) -> RepoResult<Vec<Service>> {
        sqlx::query("SELECT * FROM services WHERE project_id = ? ORDER BY name COLLATE NOCASE")
            .bind(project.to_string())
            .fetch_all(&self.pool)
            .await
            .map_err(db_err)?
            .iter()
            .map(|r| service_from_row(r, ""))
            .collect()
    }

    async fn find_environment(
        &self,
        project: ProjectId,
        id: &RailwayEnvironmentId,
    ) -> RepoResult<Option<Environment>> {
        sqlx::query(
            "SELECT * FROM environments WHERE project_id = ? AND railway_environment_id = ?",
        )
        .bind(project.to_string())
        .bind(id.as_str())
        .fetch_optional(&self.pool)
        .await
        .map_err(db_err)?
        .map(|r| environment_from_row(&r, ""))
        .transpose()
    }

    async fn find_service(
        &self,
        project: ProjectId,
        id: &RailwayServiceId,
    ) -> RepoResult<Option<Service>> {
        sqlx::query("SELECT * FROM services WHERE project_id = ? AND railway_service_id = ?")
            .bind(project.to_string())
            .bind(id.as_str())
            .fetch_optional(&self.pool)
            .await
            .map_err(db_err)?
            .map(|r| service_from_row(&r, ""))
            .transpose()
    }

    async fn list_instances(&self, project: Option<ProjectId>) -> RepoResult<Vec<InstanceView>> {
        let mut query = QueryBuilder::<Sqlite>::new(VIEW_SELECT);
        if let Some(project) = project {
            query
                .push(" WHERE si.project_id = ")
                .push_bind(project.to_string());
        }
        query.push(VIEW_ORDER);
        query
            .build()
            .fetch_all(&self.pool)
            .await
            .map_err(db_err)?
            .iter()
            .map(view_from_row)
            .collect()
    }

    async fn get_instance(&self, id: ServiceInstanceId) -> RepoResult<Option<InstanceView>> {
        sqlx::query(AssertSqlSafe(format!("{VIEW_SELECT} WHERE si.id = ?")))
            .bind(id.to_string())
            .fetch_optional(&self.pool)
            .await
            .map_err(db_err)?
            .map(|r| view_from_row(&r))
            .transpose()
    }

    async fn delete_instance(&self, id: ServiceInstanceId) -> RepoResult<()> {
        if has_active(&self.pool, "si.id = ?", id.to_string()).await? {
            return Err(RepoError::Conflict(
                "operação em andamento sobre a instância".into(),
            ));
        }
        let result = sqlx::query("DELETE FROM service_instances WHERE id = ?")
            .bind(id.to_string())
            .execute(&self.pool)
            .await
            .map_err(db_err)?;
        if result.rows_affected() == 0 {
            Err(RepoError::NotFound)
        } else {
            Ok(())
        }
    }

    async fn delete_service(&self, id: ServiceId) -> RepoResult<()> {
        if has_active(&self.pool, "si.service_id = ?", id.to_string()).await? {
            return Err(RepoError::Conflict(
                "operação em andamento sobre o serviço".into(),
            ));
        }
        let result = sqlx::query("DELETE FROM services WHERE id = ?")
            .bind(id.to_string())
            .execute(&self.pool)
            .await
            .map_err(db_err)?;
        if result.rows_affected() == 0 {
            Err(RepoError::NotFound)
        } else {
            Ok(())
        }
    }

    async fn rename_environment(&self, id: EnvironmentId, name: &str) -> RepoResult<()> {
        sqlx::query("UPDATE environments SET name = ? WHERE id = ?")
            .bind(name)
            .bind(id.to_string())
            .execute(&self.pool)
            .await
            .map_err(db_err)?;
        Ok(())
    }

    async fn rename_service(&self, id: ServiceId, name: &str) -> RepoResult<()> {
        sqlx::query("UPDATE services SET name = ? WHERE id = ?")
            .bind(name)
            .bind(id.to_string())
            .execute(&self.pool)
            .await
            .map_err(db_err)?;
        Ok(())
    }

    async fn record_observation(
        &self,
        id: ServiceInstanceId,
        o: &InstanceObservation,
    ) -> RepoResult<()> {
        sqlx::query(
            "UPDATE service_instances
                SET observed_state = ?, not_found = ?, latest_deployment_id = ?,
                    latest_deployment_status = ?, last_observed_at = ?, last_sync_error = NULL
              WHERE id = ?",
        )
        .bind(o.state.as_str())
        .bind(o.not_found)
        .bind(o.latest_deployment_id.as_ref().map(|d| d.to_string()))
        .bind(o.latest_deployment_status.map(|s| s.as_str()))
        .bind(ts(o.observed_at))
        .bind(id.to_string())
        .execute(&self.pool)
        .await
        .map_err(db_err)?;
        Ok(())
    }

    async fn record_sync_error(&self, ids: &[ServiceInstanceId], error: &str) -> RepoResult<()> {
        if ids.is_empty() {
            return Ok(());
        }
        let mut query =
            QueryBuilder::<Sqlite>::new("UPDATE service_instances SET last_sync_error = ");
        query.push_bind(error).push(" WHERE id IN (");
        let mut separated = query.separated(", ");
        for id in ids {
            separated.push_bind(id.to_string());
        }
        query.push(")");
        query.build().execute(&self.pool).await.map_err(db_err)?;
        Ok(())
    }
}
