use application::ports::{RepoResult, SessionOwner, SessionRepository};
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use domain::ids::UserId;
use domain::user::Role;
use sqlx::{Row, SqlitePool};

use super::{db_err, ts};

#[derive(Clone)]
pub struct SqliteSessions {
    pool: SqlitePool,
}

impl SqliteSessions {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl SessionRepository for SqliteSessions {
    async fn create(
        &self,
        id_hash: &str,
        user_id: Option<UserId>,
        created_at: DateTime<Utc>,
        expires_at: DateTime<Utc>,
    ) -> RepoResult<()> {
        sqlx::query(
            "INSERT INTO sessions (id_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
        )
        .bind(id_hash)
        .bind(user_id.map(|id| id.to_string()))
        .bind(ts(created_at))
        .bind(ts(expires_at))
        .execute(&self.pool)
        .await
        .map_err(db_err)?;
        Ok(())
    }

    async fn resolve(&self, id_hash: &str, now: DateTime<Utc>) -> RepoResult<Option<SessionOwner>> {
        let row = sqlx::query(
            "SELECT s.user_id, u.username, u.role, u.is_active
               FROM sessions s LEFT JOIN users u ON u.id = s.user_id
              WHERE s.id_hash = ? AND s.expires_at > ?",
        )
        .bind(id_hash)
        .bind(ts(now))
        .fetch_optional(&self.pool)
        .await
        .map_err(db_err)?;
        let Some(row) = row else { return Ok(None) };
        let user_id: Option<String> = row.try_get("user_id").map_err(db_err)?;
        if user_id.is_none() {
            return Ok(Some(SessionOwner::Master));
        }
        let username: Option<String> = row.try_get("username").map_err(db_err)?;
        let role: Option<String> = row.try_get("role").map_err(db_err)?;
        let active: Option<i64> = row.try_get("is_active").map_err(db_err)?;
        match (username, role.and_then(|r| r.parse::<Role>().ok()), active) {
            (Some(username), Some(role), Some(1)) => {
                Ok(Some(SessionOwner::User { username, role }))
            }
            _ => Ok(None),
        }
    }

    async fn delete(&self, id_hash: &str) -> RepoResult<()> {
        sqlx::query("DELETE FROM sessions WHERE id_hash = ?")
            .bind(id_hash)
            .execute(&self.pool)
            .await
            .map_err(db_err)?;
        Ok(())
    }

    async fn delete_for_user(&self, user_id: UserId) -> RepoResult<()> {
        sqlx::query("DELETE FROM sessions WHERE user_id = ?")
            .bind(user_id.to_string())
            .execute(&self.pool)
            .await
            .map_err(db_err)?;
        Ok(())
    }

    async fn purge_expired(&self, now: DateTime<Utc>) -> RepoResult<u64> {
        let result = sqlx::query("DELETE FROM sessions WHERE expires_at <= ?")
            .bind(ts(now))
            .execute(&self.pool)
            .await
            .map_err(db_err)?;
        Ok(result.rows_affected())
    }
}
