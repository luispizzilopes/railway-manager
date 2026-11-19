//! Ações agendadas (execução única).

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use chrono::DateTime;
use serde::Deserialize;
use serde_json::json;

use super::util::{Body, id, non_empty, parse};
use crate::AppState;
use crate::error::{ApiError, ApiResult};

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ActionTargetInput {
    All {
        environment_name: Option<String>,
    },
    Projects {
        project_ids: Vec<String>,
        environment_name: Option<String>,
    },
    Instances {
        instance_ids: Vec<String>,
    },
}

#[derive(Deserialize)]
pub struct ScheduledActionInput {
    kind: String,
    run_at: String,
    target: ActionTargetInput,
    note: Option<String>,
}

pub async fn create_scheduled_action(
    State(state): State<AppState>,
    body: Body<ScheduledActionInput>,
) -> ApiResult<Response> {
    use domain::scheduled_action::{ActionTarget, ScheduledActionSpec};
    let Json(input) = body?;
    let run_at = DateTime::parse_from_rfc3339(&input.run_at)
        .map_err(|_| ApiError::bad_request(format!("run_at inválido: '{}'", input.run_at)))?
        .to_utc();
    let target = match input.target {
        ActionTargetInput::All { environment_name } => ActionTarget::All { environment_name },
        ActionTargetInput::Projects {
            project_ids,
            environment_name,
        } => ActionTarget::Projects {
            project_ids: project_ids
                .iter()
                .map(|p| parse("project_ids", p))
                .collect::<ApiResult<_>>()?,
            environment_name,
        },
        ActionTargetInput::Instances { instance_ids } => ActionTarget::Instances {
            instance_ids: instance_ids
                .iter()
                .map(|i| parse("instance_ids", i))
                .collect::<ApiResult<_>>()?,
        },
    };
    let action = state
        .scheduled_actions
        .create(ScheduledActionSpec {
            kind: parse("kind", &input.kind)?,
            run_at,
            target,
            note: input.note,
        })
        .await?;
    Ok((StatusCode::CREATED, Json(action)).into_response())
}

#[derive(Deserialize, Default)]
pub struct ScheduledActionQuery {
    status: Option<String>,
    page: Option<u32>,
    per_page: Option<u32>,
}

pub async fn list_scheduled_actions(
    State(state): State<AppState>,
    query: Result<Query<ScheduledActionQuery>, axum::extract::rejection::QueryRejection>,
) -> ApiResult<Response> {
    let Query(q) = query.map_err(|e| ApiError::bad_request(e.body_text()))?;
    let status = non_empty(q.status)
        .map(|s| parse::<domain::scheduled_action::ScheduledActionStatus>("status", &s))
        .transpose()?;
    let page = state
        .scheduled_actions
        .list(status, q.page, q.per_page)
        .await?;
    let mut body = serde_json::to_value(page)
        .map_err(|e| ApiError::from(application::error::AppError::Internal(e.to_string())))?;
    body["default_timezone"] = json!(state.scheduled_actions.default_timezone().name());
    Ok(Json(body).into_response())
}

pub async fn get_scheduled_action(
    State(state): State<AppState>,
    Path(action): Path<String>,
) -> ApiResult<Response> {
    Ok(Json(state.scheduled_actions.get(id(&action)?).await?).into_response())
}

pub async fn cancel_scheduled_action(
    State(state): State<AppState>,
    Path(action): Path<String>,
) -> ApiResult<Response> {
    Ok(Json(state.scheduled_actions.cancel(id(&action)?).await?).into_response())
}
