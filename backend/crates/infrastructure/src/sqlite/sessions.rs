use application::ports::{RepoResult, SessionRepository};
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use sqlx::SqlitePool;

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
        created_at: DateTime<Utc>,
        expires_at: DateTime<Utc>,
    ) -> RepoResult<()> {
        sqlx::query("INSERT INTO sessions (id_hash, created_at, expires_at) VALUES (?, ?, ?)")
            .bind(id_hash)
            .bind(ts(created_at))
            .bind(ts(expires_at))
            .execute(&self.pool)
            .await
            .map_err(db_err)?;
        Ok(())
    }

    async fn is_valid(&self, id_hash: &str, now: DateTime<Utc>) -> RepoResult<bool> {
        let found: Option<i64> =
            sqlx::query_scalar("SELECT 1 FROM sessions WHERE id_hash = ? AND expires_at > ?")
                .bind(id_hash)
                .bind(ts(now))
                .fetch_optional(&self.pool)
                .await
                .map_err(db_err)?;
        Ok(found.is_some())
    }

    async fn delete(&self, id_hash: &str) -> RepoResult<()> {
        sqlx::query("DELETE FROM sessions WHERE id_hash = ?")
            .bind(id_hash)
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
