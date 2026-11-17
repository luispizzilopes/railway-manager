//! Persistência em SQLite (sqlx). Um processo único é premissa da v1.

mod credentials;
mod inventory;
mod operations;
mod plans;
mod projects;
mod scheduled_actions;
mod schedules;
mod sessions;

use std::str::FromStr;
use std::time::Duration;

use application::ports::{RepoError, RepoResult};
use chrono::{DateTime, SecondsFormat, Utc};
use sqlx::migrate::Migrator;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteRow};
use sqlx::{Row, SqlitePool};

pub use credentials::SqliteCredentials;
pub use inventory::SqliteInventory;
pub use operations::SqliteOperations;
pub use plans::SqlitePlans;
pub use projects::SqliteProjects;
pub use scheduled_actions::SqliteScheduledActions;
pub use schedules::{SqliteScheduleRuns, SqliteSchedules};
pub use sessions::SqliteSessions;

pub static MIGRATOR: Migrator = sqlx::migrate!("./migrations");

/// Abre o banco (criando se preciso), com chaves estrangeiras ativas, e aplica as migrações.
pub async fn connect(url: &str) -> Result<SqlitePool, sqlx::Error> {
    let in_memory = url.contains(":memory:");
    let options = SqliteConnectOptions::from_str(url)?
        .create_if_missing(true)
        .foreign_keys(true)
        .busy_timeout(Duration::from_secs(5))
        .journal_mode(if in_memory {
            SqliteJournalMode::Memory
        } else {
            SqliteJournalMode::Wal
        });
    // Banco em memória existe por conexão: uma só conexão mantém o mesmo banco.
    let pool = SqlitePoolOptions::new()
        .max_connections(if in_memory { 1 } else { 5 })
        .connect_with(options)
        .await?;
    MIGRATOR.run(&pool).await?;
    Ok(pool)
}

/// Datas com largura fixa (milissegundos, `Z`): a ordem textual é a cronológica.
pub(crate) fn ts(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub(crate) fn opt_ts(value: Option<DateTime<Utc>>) -> Option<String> {
    value.map(ts)
}

pub(crate) fn db_err(err: sqlx::Error) -> RepoError {
    match &err {
        sqlx::Error::Database(db) if db.is_unique_violation() => {
            RepoError::Conflict(db.message().to_owned())
        }
        sqlx::Error::RowNotFound => RepoError::NotFound,
        _ => RepoError::Database(err.to_string()),
    }
}

fn corrupt(column: &str, detail: impl std::fmt::Display) -> RepoError {
    RepoError::Database(format!("valor inválido em {column}: {detail}"))
}

/// Leitura tipada de colunas com conversão para tipos do domínio.
pub(crate) trait RowExt {
    fn text(&self, column: &str) -> RepoResult<String>;
    fn opt_text(&self, column: &str) -> RepoResult<Option<String>>;
    fn parse<T: FromStr>(&self, column: &str) -> RepoResult<T>
    where
        T::Err: std::fmt::Display;
    fn opt_parse<T: FromStr>(&self, column: &str) -> RepoResult<Option<T>>
    where
        T::Err: std::fmt::Display;
    fn time(&self, column: &str) -> RepoResult<DateTime<Utc>>;
    fn opt_time(&self, column: &str) -> RepoResult<Option<DateTime<Utc>>>;
    fn flag(&self, column: &str) -> RepoResult<bool>;
    fn int(&self, column: &str) -> RepoResult<i64>;
    fn opt_int(&self, column: &str) -> RepoResult<Option<i64>>;
}

impl RowExt for SqliteRow {
    fn text(&self, column: &str) -> RepoResult<String> {
        self.try_get(column).map_err(db_err)
    }

    fn opt_text(&self, column: &str) -> RepoResult<Option<String>> {
        self.try_get(column).map_err(db_err)
    }

    fn parse<T: FromStr>(&self, column: &str) -> RepoResult<T>
    where
        T::Err: std::fmt::Display,
    {
        let raw = self.text(column)?;
        raw.parse().map_err(|e| corrupt(column, e))
    }

    fn opt_parse<T: FromStr>(&self, column: &str) -> RepoResult<Option<T>>
    where
        T::Err: std::fmt::Display,
    {
        self.opt_text(column)?
            .map(|raw| raw.parse().map_err(|e| corrupt(column, e)))
            .transpose()
    }

    fn time(&self, column: &str) -> RepoResult<DateTime<Utc>> {
        let raw = self.text(column)?;
        DateTime::parse_from_rfc3339(&raw)
            .map(|d| d.to_utc())
            .map_err(|e| corrupt(column, e))
    }

    fn opt_time(&self, column: &str) -> RepoResult<Option<DateTime<Utc>>> {
        self.opt_text(column)?
            .map(|raw| {
                DateTime::parse_from_rfc3339(&raw)
                    .map(|d| d.to_utc())
                    .map_err(|e| corrupt(column, e))
            })
            .transpose()
    }

    fn flag(&self, column: &str) -> RepoResult<bool> {
        Ok(self.int(column)? != 0)
    }

    fn int(&self, column: &str) -> RepoResult<i64> {
        self.try_get(column).map_err(db_err)
    }

    fn opt_int(&self, column: &str) -> RepoResult<Option<i64>> {
        self.try_get(column).map_err(db_err)
    }
}

/// Itens ativos (bloqueiam a instância), em SQL.
pub(crate) const ACTIVE_RESULTS: &str = "('pending', 'running', 'verifying')";
