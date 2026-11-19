//! Agendas recorrentes.

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use domain::ids::ProjectId;
use serde::Deserialize;
use serde_json::json;

use super::util::{Body, id, non_empty, parse};
use crate::AppState;
use crate::error::{ApiError, ApiResult};

#[derive(Deserialize)]
pub struct WindowInput {
    start: String,
    end: String,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ScheduleTargetInput {
    Project { environment_id: Option<String> },
    Instances { instance_ids: Vec<String> },
}

#[derive(Deserialize)]
pub struct ScheduleInput {
    project_id: Option<String>,
    name: String,
    timezone: Option<String>,
    /// 0 = segunda … 6 = domingo.
    days: Vec<u8>,
    windows: Vec<WindowInput>,
    target: ScheduleTargetInput,
}

fn schedule_spec(
    input: ScheduleInput,
    default_timezone: chrono_tz::Tz,
) -> ApiResult<domain::schedule::ScheduleSpec> {
    use domain::schedule::{LocalTime, Weekdays, Window, parse_timezone};
    let timezone = match input
        .timezone
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
    {
        Some(tz) => parse_timezone(tz).map_err(application::error::AppError::from)?,
        None => default_timezone,
    };
    let mut bits = 0u8;
    for day in input.days {
        if day > 6 {
            return Err(ApiError::bad_request(format!(
                "dia inválido: {day} (use 0 = segunda … 6 = domingo)"
            )));
        }
        bits |= 1 << day;
    }
    let windows = input
        .windows
        .iter()
        .map(|w| {
            Ok(Window {
                start: w
                    .start
                    .parse::<LocalTime>()
                    .map_err(application::error::AppError::from)?,
                end: w
                    .end
                    .parse::<LocalTime>()
                    .map_err(application::error::AppError::from)?,
            })
        })
        .collect::<ApiResult<Vec<_>>>()?;
    let (environment, instances) = match input.target {
        ScheduleTargetInput::Project { environment_id } => (
            environment_id
                .as_deref()
                .filter(|e| !e.is_empty())
                .map(|e| parse("environment_id", e))
                .transpose()?,
            None,
        ),
        ScheduleTargetInput::Instances { instance_ids } => (
            None,
            Some(
                instance_ids
                    .iter()
                    .map(|i| parse("instance_ids", i))
                    .collect::<ApiResult<Vec<_>>>()?,
            ),
        ),
    };
    Ok(application::schedules::spec(
        input.name,
        timezone,
        Weekdays::from_bits(bits),
        windows,
        environment,
        instances,
    ))
}

#[derive(Deserialize, Default)]
pub struct ScheduleListQuery {
    project_id: Option<String>,
}

pub async fn list_schedules(
    State(state): State<AppState>,
    Query(q): Query<ScheduleListQuery>,
) -> ApiResult<Response> {
    let project: Option<ProjectId> = non_empty(q.project_id)
        .map(|p| parse("project_id", &p))
        .transpose()?;
    let schedules = state.schedules.list(project).await?;
    Ok(Json(json!({ "schedules": schedules, "default_timezone": state.schedules.default_timezone().name() }))
        .into_response())
}

pub async fn create_schedule(
    State(state): State<AppState>,
    body: Body<ScheduleInput>,
) -> ApiResult<Response> {
    let Json(input) = body?;
    let project: ProjectId = match input.project_id.as_deref() {
        Some(p) => parse("project_id", p)?,
        None => return Err(ApiError::bad_request("project_id é obrigatório")),
    };
    let spec = schedule_spec(input, state.schedules.default_timezone())?;
    let view = state.schedules.create(project, spec).await?;
    Ok((StatusCode::CREATED, Json(view)).into_response())
}

pub async fn get_schedule(
    State(state): State<AppState>,
    Path(schedule): Path<String>,
) -> ApiResult<Response> {
    Ok(Json(state.schedules.get(id(&schedule)?).await?).into_response())
}

pub async fn update_schedule(
    State(state): State<AppState>,
    Path(schedule): Path<String>,
    body: Body<ScheduleInput>,
) -> ApiResult<Response> {
    let schedule = id(&schedule)?;
    let Json(input) = body?;
    let spec = schedule_spec(input, state.schedules.default_timezone())?;
    Ok(Json(state.schedules.update(schedule, spec).await?).into_response())
}

pub async fn delete_schedule(
    State(state): State<AppState>,
    Path(schedule): Path<String>,
) -> ApiResult<StatusCode> {
    state.schedules.delete(id(&schedule)?).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn pause_schedule(
    State(state): State<AppState>,
    Path(schedule): Path<String>,
) -> ApiResult<Response> {
    Ok(Json(state.schedules.pause(id(&schedule)?).await?).into_response())
}

pub async fn resume_schedule(
    State(state): State<AppState>,
    Path(schedule): Path<String>,
) -> ApiResult<Response> {
    Ok(Json(state.schedules.resume(id(&schedule)?).await?).into_response())
}

#[derive(Deserialize, Default)]
pub struct PageQuery {
    page: Option<u32>,
    per_page: Option<u32>,
}

pub async fn schedule_runs(
    State(state): State<AppState>,
    Path(schedule): Path<String>,
    Query(q): Query<PageQuery>,
) -> ApiResult<Response> {
    Ok(Json(
        state
            .schedules
            .runs(id(&schedule)?, q.page, q.per_page)
            .await?,
    )
    .into_response())
}
