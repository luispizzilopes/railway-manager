use application::ports::{RepoError, RepoResult, UserCredentials, UserRepository};
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use domain::ids::UserId;
use domain::user::{Role, User, Username};
use sqlx::SqlitePool;
use sqlx::sqlite::SqliteRow;

use super::{RowExt, db_err, ts};

#[derive(Clone)]
pub struct SqliteUsers {
    pool: SqlitePool,
}

impl SqliteUsers {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }
}

fn user_from(row: &SqliteRow) -> RepoResult<User> {
    let username = Username::parse(&row.text("username")?)
        .map_err(|e| RepoError::Database(format!("username inválido no banco: {e}")))?;
    Ok(User {
        id: row.parse("id")?,
        username,
        role: row.parse::<Role>("role")?,
        is_active: row.flag("is_active")?,
        created_at: row.time("created_at")?,
        updated_at: row.time("updated_at")?,
    })
}

#[async_trait]
impl UserRepository for SqliteUsers {
    async fn insert(&self, user: &User, password_hash: &str) -> RepoResult<()> {
        sqlx::query(
            "INSERT INTO users (id, username, username_key, password_hash, role, is_active,
                                created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(user.id.to_string())
        .bind(user.username.as_str())
        .bind(user.username.key())
        .bind(password_hash)
        .bind(user.role.as_str())
        .bind(user.is_active)
        .bind(ts(user.created_at))
        .bind(ts(user.updated_at))
        .execute(&self.pool)
        .await
        .map_err(db_err)?;
        Ok(())
    }

    async fn list(&self) -> RepoResult<Vec<User>> {
        let rows = sqlx::query("SELECT * FROM users ORDER BY username_key")
            .fetch_all(&self.pool)
            .await
            .map_err(db_err)?;
        rows.iter().map(user_from).collect()
    }

    async fn get(&self, id: UserId) -> RepoResult<Option<User>> {
        let row = sqlx::query("SELECT * FROM users WHERE id = ?")
            .bind(id.to_string())
            .fetch_optional(&self.pool)
            .await
            .map_err(db_err)?;
        row.as_ref().map(user_from).transpose()
    }

    async fn find_credentials(&self, username_key: &str) -> RepoResult<Option<UserCredentials>> {
        let row = sqlx::query("SELECT * FROM users WHERE username_key = ?")
            .bind(username_key)
            .fetch_optional(&self.pool)
            .await
            .map_err(db_err)?;
        row.as_ref()
            .map(|row| {
                Ok(UserCredentials {
                    user: user_from(row)?,
                    password_hash: row.text("password_hash")?,
                })
            })
            .transpose()
    }

    async fn update(
        &self,
        id: UserId,
        role: Role,
        is_active: bool,
        now: DateTime<Utc>,
    ) -> RepoResult<()> {
        let result =
            sqlx::query("UPDATE users SET role = ?, is_active = ?, updated_at = ? WHERE id = ?")
                .bind(role.as_str())
                .bind(is_active)
                .bind(ts(now))
                .bind(id.to_string())
                .execute(&self.pool)
                .await
                .map_err(db_err)?;
        if result.rows_affected() == 0 {
            return Err(RepoError::NotFound);
        }
        Ok(())
    }

    async fn set_password_hash(
        &self,
        id: UserId,
        password_hash: &str,
        now: DateTime<Utc>,
    ) -> RepoResult<()> {
        let result = sqlx::query("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?")
            .bind(password_hash)
            .bind(ts(now))
            .bind(id.to_string())
            .execute(&self.pool)
            .await
            .map_err(db_err)?;
        if result.rows_affected() == 0 {
            return Err(RepoError::NotFound);
        }
        Ok(())
    }

    async fn delete(&self, id: UserId) -> RepoResult<()> {
        let result = sqlx::query("DELETE FROM users WHERE id = ?")
            .bind(id.to_string())
            .execute(&self.pool)
            .await
            .map_err(db_err)?;
        if result.rows_affected() == 0 {
            return Err(RepoError::NotFound);
        }
        Ok(())
    }
}
