use application::ports::{CredentialRepository, RepoResult, SealedSecret, StoredCredential};
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use domain::credential::{CredentialMetadata, CredentialStatus};
use domain::ids::CredentialId;
use sqlx::SqlitePool;
use sqlx::sqlite::SqliteRow;

use super::{RowExt, db_err, opt_ts, ts};

#[derive(Clone)]
pub struct SqliteCredentials {
    pool: SqlitePool,
}

impl SqliteCredentials {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }
}

fn from_row(row: &SqliteRow) -> RepoResult<StoredCredential> {
    use sqlx::Row;
    Ok(StoredCredential {
        metadata: CredentialMetadata {
            id: row.parse("id")?,
            kind: row.parse("kind")?,
            workspace_id: row.opt_parse("workspace_id")?,
            label: row.text("label")?,
            masked_suffix: row.text("masked_suffix")?,
            status: row.parse("status")?,
            validated_at: row.opt_time("validated_at")?,
            created_at: row.time("created_at")?,
        },
        sealed: SealedSecret {
            ciphertext: row.try_get("ciphertext").map_err(db_err)?,
            nonce: row.try_get("nonce").map_err(db_err)?,
            key_version: row.int("key_version")?,
        },
    })
}

#[async_trait]
impl CredentialRepository for SqliteCredentials {
    async fn get(&self) -> RepoResult<Option<StoredCredential>> {
        sqlx::query("SELECT * FROM credentials ORDER BY created_at DESC LIMIT 1")
            .fetch_optional(&self.pool)
            .await
            .map_err(db_err)?
            .as_ref()
            .map(from_row)
            .transpose()
    }

    async fn replace(&self, c: &StoredCredential) -> RepoResult<()> {
        let m = &c.metadata;
        let mut tx = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(db_err)?;
        sqlx::query(
            "INSERT INTO credentials (id, kind, workspace_id, ciphertext, nonce, key_version,
                                      label, masked_suffix, status, validated_at, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(m.id.to_string())
        .bind(m.kind.as_str())
        .bind(m.workspace_id.as_ref().map(|w| w.to_string()))
        .bind(&c.sealed.ciphertext)
        .bind(&c.sealed.nonce)
        .bind(c.sealed.key_version)
        .bind(&m.label)
        .bind(&m.masked_suffix)
        .bind(m.status.as_str())
        .bind(opt_ts(m.validated_at))
        .bind(ts(m.created_at))
        .execute(&mut *tx)
        .await
        .map_err(db_err)?;
        // Um único token por vez: os projetos passam a usar o novo.
        sqlx::query("UPDATE projects SET credential_id = ?")
            .bind(m.id.to_string())
            .execute(&mut *tx)
            .await
            .map_err(db_err)?;
        sqlx::query("DELETE FROM credentials WHERE id <> ?")
            .bind(m.id.to_string())
            .execute(&mut *tx)
            .await
            .map_err(db_err)?;
        tx.commit().await.map_err(db_err)
    }

    async fn delete(&self) -> RepoResult<()> {
        sqlx::query("DELETE FROM credentials")
            .execute(&self.pool)
            .await
            .map_err(db_err)?;
        Ok(())
    }

    async fn set_status(
        &self,
        id: CredentialId,
        status: CredentialStatus,
        validated_at: Option<DateTime<Utc>>,
    ) -> RepoResult<()> {
        sqlx::query(
            "UPDATE credentials SET status = ?, validated_at = COALESCE(?, validated_at) WHERE id = ?",
        )
        .bind(status.as_str())
        .bind(opt_ts(validated_at))
        .bind(id.to_string())
        .execute(&self.pool)
        .await
        .map_err(db_err)?;
        Ok(())
    }
}
