use application::ports::{Page, RepoError, RepoResult, ScheduleRepository, ScheduleRunRepository};
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use domain::ids::{ProjectId, ScheduleId};
use domain::schedule::{
    LocalTime, RunStatus, Schedule, ScheduleRun, ScheduleTarget, Weekdays, Window, parse_timezone,
};
use sqlx::sqlite::SqliteRow;
use sqlx::{SqliteConnection, SqlitePool};

use super::{RowExt, db_err, opt_ts, ts};

#[derive(Clone)]
pub struct SqliteSchedules {
    pool: SqlitePool,
}

impl SqliteSchedules {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }
}

fn corrupt(detail: impl std::fmt::Display) -> RepoError {
    RepoError::Database(format!("agenda inválida no banco: {detail}"))
}

async fn load(conn: &mut SqliteConnection, row: &SqliteRow) -> RepoResult<Schedule> {
    let id: ScheduleId = row.parse("id")?;
    let windows = sqlx::query_as::<_, (i64, i64)>(
        "SELECT start_minute, end_minute FROM schedule_windows WHERE schedule_id = ? ORDER BY position",
    )
    .bind(id.to_string())
    .fetch_all(&mut *conn)
    .await
    .map_err(db_err)?
    .into_iter()
    .map(|(s, e)| {
        let time = |m: i64| u16::try_from(m).ok().and_then(LocalTime::from_minutes).ok_or_else(|| corrupt(m));
        Ok(Window { start: time(s)?, end: time(e)? })
    })
    .collect::<RepoResult<Vec<_>>>()?;

    let target = match row.text("target_kind")?.as_str() {
        "project" => ScheduleTarget::Project {
            environment_id: row.opt_parse("environment_id")?,
        },
        "instances" => {
            let ids: Vec<String> = sqlx::query_scalar(
                "SELECT service_instance_id FROM schedule_instances WHERE schedule_id = ?
                  ORDER BY service_instance_id",
            )
            .bind(id.to_string())
            .fetch_all(&mut *conn)
            .await
            .map_err(db_err)?;
            ScheduleTarget::Instances {
                instance_ids: ids
                    .iter()
                    .map(|i| i.parse().map_err(corrupt))
                    .collect::<RepoResult<_>>()?,
            }
        }
        other => return Err(corrupt(other)),
    };

    let days = u8::try_from(row.int("days_mask")?).map_err(corrupt)?;
    Ok(Schedule {
        id,
        project_id: row.parse("project_id")?,
        name: row.text("name")?,
        enabled: row.flag("enabled")?,
        timezone: parse_timezone(&row.text("timezone")?).map_err(corrupt)?,
        days: Weekdays::from_bits(days),
        windows,
        target,
        effective_from: row.time("effective_from")?,
        paused_reason: row.opt_text("paused_reason")?,
        created_at: row.time("created_at")?,
        updated_at: row.time("updated_at")?,
    })
}

async fn write_children(conn: &mut SqliteConnection, s: &Schedule) -> RepoResult<()> {
    sqlx::query("DELETE FROM schedule_windows WHERE schedule_id = ?")
        .bind(s.id.to_string())
        .execute(&mut *conn)
        .await
        .map_err(db_err)?;
    for (position, w) in s.windows.iter().enumerate() {
        sqlx::query(
            "INSERT INTO schedule_windows (schedule_id, position, start_minute, end_minute)
             VALUES (?, ?, ?, ?)",
        )
        .bind(s.id.to_string())
        .bind(position as i64)
        .bind(i64::from(w.start.minutes()))
        .bind(i64::from(w.end.minutes()))
        .execute(&mut *conn)
        .await
        .map_err(db_err)?;
    }
    sqlx::query("DELETE FROM schedule_instances WHERE schedule_id = ?")
        .bind(s.id.to_string())
        .execute(&mut *conn)
        .await
        .map_err(db_err)?;
    if let ScheduleTarget::Instances { instance_ids } = &s.target {
        for instance in instance_ids {
            sqlx::query(
                "INSERT INTO schedule_instances (schedule_id, service_instance_id) VALUES (?, ?)",
            )
            .bind(s.id.to_string())
            .bind(instance.to_string())
            .execute(&mut *conn)
            .await
            .map_err(|e| match db_err(e) {
                RepoError::Database(msg) if msg.contains("FOREIGN KEY") => {
                    RepoError::Conflict(format!("instância {instance} não existe"))
                }
                other => other,
            })?;
        }
    }
    Ok(())
}

fn target_columns(target: &ScheduleTarget) -> (&'static str, Option<String>) {
    match target {
        ScheduleTarget::Project { environment_id } => {
            ("project", environment_id.map(|e| e.to_string()))
        }
        ScheduleTarget::Instances { .. } => ("instances", None),
    }
}

#[async_trait]
impl ScheduleRepository for SqliteSchedules {
    async fn insert(&self, s: &Schedule) -> RepoResult<()> {
        let mut tx = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(db_err)?;
        let (kind, environment) = target_columns(&s.target);
        sqlx::query(
            "INSERT INTO schedules (id, project_id, name, enabled, timezone, days_mask, target_kind,
                                    environment_id, effective_from, paused_reason, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(s.id.to_string())
        .bind(s.project_id.to_string())
        .bind(&s.name)
        .bind(s.enabled)
        .bind(s.timezone.name())
        .bind(i64::from(s.days.bits()))
        .bind(kind)
        .bind(environment)
        .bind(ts(s.effective_from))
        .bind(&s.paused_reason)
        .bind(ts(s.created_at))
        .bind(ts(s.updated_at))
        .execute(&mut *tx)
        .await
        .map_err(|e| match db_err(e) {
            RepoError::Database(msg) if msg.contains("FOREIGN KEY") => {
                RepoError::Conflict("projeto ou ambiente inexistente".into())
            }
            other => other,
        })?;
        write_children(&mut tx, s).await?;
        tx.commit().await.map_err(db_err)
    }

    async fn update(&self, s: &Schedule) -> RepoResult<()> {
        let mut tx = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(db_err)?;
        let (kind, environment) = target_columns(&s.target);
        let result = sqlx::query(
            "UPDATE schedules SET name = ?, enabled = ?, timezone = ?, days_mask = ?, target_kind = ?,
                                  environment_id = ?, effective_from = ?, paused_reason = ?, updated_at = ?
              WHERE id = ?",
        )
        .bind(&s.name)
        .bind(s.enabled)
        .bind(s.timezone.name())
        .bind(i64::from(s.days.bits()))
        .bind(kind)
        .bind(environment)
        .bind(ts(s.effective_from))
        .bind(&s.paused_reason)
        .bind(ts(s.updated_at))
        .bind(s.id.to_string())
        .execute(&mut *tx)
        .await
        .map_err(db_err)?;
        if result.rows_affected() == 0 {
            return Err(RepoError::NotFound);
        }
        write_children(&mut tx, s).await?;
        tx.commit().await.map_err(db_err)
    }

    async fn get(&self, id: ScheduleId) -> RepoResult<Option<Schedule>> {
        let mut conn = self.pool.acquire().await.map_err(db_err)?;
        let row = sqlx::query("SELECT * FROM schedules WHERE id = ?")
            .bind(id.to_string())
            .fetch_optional(&mut *conn)
            .await
            .map_err(db_err)?;
        match row {
            Some(row) => Ok(Some(load(&mut conn, &row).await?)),
            None => Ok(None),
        }
    }

    async fn list(&self, project: Option<ProjectId>) -> RepoResult<Vec<Schedule>> {
        let mut conn = self.pool.acquire().await.map_err(db_err)?;
        let rows = match project {
            Some(p) => {
                sqlx::query(
                    "SELECT * FROM schedules WHERE project_id = ? ORDER BY name COLLATE NOCASE",
                )
                .bind(p.to_string())
                .fetch_all(&mut *conn)
                .await
            }
            None => {
                sqlx::query("SELECT * FROM schedules ORDER BY name COLLATE NOCASE")
                    .fetch_all(&mut *conn)
                    .await
            }
        }
        .map_err(db_err)?;
        let mut out = Vec::with_capacity(rows.len());
        for row in &rows {
            out.push(load(&mut conn, row).await?);
        }
        Ok(out)
    }

    async fn delete(&self, id: ScheduleId) -> RepoResult<()> {
        let result = sqlx::query("DELETE FROM schedules WHERE id = ?")
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

    async fn pause_without_targets(&self, reason: &str, now: DateTime<Utc>) -> RepoResult<u64> {
        let result = sqlx::query(
            "UPDATE schedules SET enabled = 0, paused_reason = ?, updated_at = ?
              WHERE enabled = 1 AND target_kind = 'instances'
                AND NOT EXISTS (SELECT 1 FROM schedule_instances si WHERE si.schedule_id = schedules.id)",
        )
        .bind(reason)
        .bind(ts(now))
        .execute(&self.pool)
        .await
        .map_err(db_err)?;
        Ok(result.rows_affected())
    }
}

#[derive(Clone)]
pub struct SqliteScheduleRuns {
    pool: SqlitePool,
}

impl SqliteScheduleRuns {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }
}

fn run_from_row(row: &SqliteRow) -> RepoResult<ScheduleRun> {
    Ok(ScheduleRun {
        id: row.parse("id")?,
        schedule_id: row.parse("schedule_id")?,
        schedule_name: row.text("schedule_name")?,
        action: row.parse("action")?,
        scheduled_for: row.time("scheduled_for")?,
        processed_at: row.time("processed_at")?,
        status: row.parse::<RunStatus>("status")?,
        operation_id: row.opt_parse("operation_id")?,
        message: row.opt_text("message")?,
    })
}

#[async_trait]
impl ScheduleRunRepository for SqliteScheduleRuns {
    async fn last_evaluated(&self) -> RepoResult<Option<DateTime<Utc>>> {
        let raw: Option<String> =
            sqlx::query_scalar("SELECT last_evaluated_at FROM scheduler_state WHERE id = 1")
                .fetch_optional(&self.pool)
                .await
                .map_err(db_err)?;
        raw.map(|r| {
            DateTime::parse_from_rfc3339(&r)
                .map(|d| d.to_utc())
                .map_err(corrupt)
        })
        .transpose()
    }

    async fn record_tick(
        &self,
        runs: &[ScheduleRun],
        evaluated_at: DateTime<Utc>,
    ) -> RepoResult<Vec<ScheduleRun>> {
        let mut tx = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(db_err)?;
        let mut inserted = Vec::new();
        for run in runs {
            let result = sqlx::query(
                "INSERT INTO schedule_runs (id, schedule_id, schedule_name, action, scheduled_for,
                                            processed_at, status, operation_id, message)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (schedule_id, scheduled_for, action) DO NOTHING",
            )
            .bind(run.id.to_string())
            .bind(run.schedule_id.to_string())
            .bind(&run.schedule_name)
            .bind(run.action.as_str())
            .bind(ts(run.scheduled_for))
            .bind(ts(run.processed_at))
            .bind(run.status.as_str())
            .bind(run.operation_id.map(|o| o.to_string()))
            .bind(&run.message)
            .execute(&mut *tx)
            .await
            .map_err(db_err)?;
            if result.rows_affected() == 1 {
                inserted.push(run.clone());
            }
        }
        // `last_evaluated_at` só avança (relógio voltando não reprocessa nada).
        sqlx::query(
            "INSERT INTO scheduler_state (id, last_evaluated_at) VALUES (1, ?)
             ON CONFLICT (id) DO UPDATE SET last_evaluated_at = MAX(last_evaluated_at, excluded.last_evaluated_at)",
        )
        .bind(ts(evaluated_at))
        .execute(&mut *tx)
        .await
        .map_err(db_err)?;
        tx.commit().await.map_err(db_err)?;
        Ok(inserted)
    }

    async fn update(&self, run: &ScheduleRun) -> RepoResult<()> {
        let result = sqlx::query(
            "UPDATE schedule_runs SET status = ?, operation_id = ?, message = ?, processed_at = ? WHERE id = ?",
        )
        .bind(run.status.as_str())
        .bind(run.operation_id.map(|o| o.to_string()))
        .bind(&run.message)
        .bind(ts(run.processed_at))
        .bind(run.id.to_string())
        .execute(&self.pool)
        .await
        .map_err(db_err)?;
        if result.rows_affected() == 0 {
            Err(RepoError::NotFound)
        } else {
            Ok(())
        }
    }

    async fn list(
        &self,
        schedule: ScheduleId,
        page: u32,
        per_page: u32,
    ) -> RepoResult<Page<ScheduleRun>> {
        let page = page.max(1);
        let per_page = per_page.clamp(1, 200);
        let total: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM schedule_runs WHERE schedule_id = ?")
                .bind(schedule.to_string())
                .fetch_one(&self.pool)
                .await
                .map_err(db_err)?;
        let items = sqlx::query(
            "SELECT * FROM schedule_runs WHERE schedule_id = ?
              ORDER BY scheduled_for DESC, action LIMIT ? OFFSET ?",
        )
        .bind(schedule.to_string())
        .bind(i64::from(per_page))
        .bind(i64::from((page - 1) * per_page))
        .fetch_all(&self.pool)
        .await
        .map_err(db_err)?
        .iter()
        .map(run_from_row)
        .collect::<RepoResult<_>>()?;
        Ok(Page {
            items,
            total: total as u64,
            page,
            per_page,
        })
    }

    async fn fail_pending(&self, message: &str, now: DateTime<Utc>) -> RepoResult<u64> {
        let result = sqlx::query(
            "UPDATE schedule_runs SET status = 'failed', message = COALESCE(message, ?), processed_at = ?
              WHERE status = 'pending'",
        )
        .bind(message)
        .bind(opt_ts(Some(now)))
        .execute(&self.pool)
        .await
        .map_err(db_err)?;
        Ok(result.rows_affected())
    }
}
