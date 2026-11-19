//! Logs e deployments de uma instância.

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::response::{IntoResponse, Response};
use domain::ids::ServiceInstanceId;
use serde::Deserialize;
use serde_json::json;

use super::util::{id, non_empty};
use crate::AppState;
use crate::error::{ApiError, ApiResult};

#[derive(Deserialize)]
pub struct LogsQuery {
    #[serde(rename = "type")]
    kind: Option<String>,
    deployment_id: Option<String>,
    start: Option<String>,
    end: Option<String>,
    /// Níveis separados por vírgula (`error,warn`).
    severity: Option<String>,
    q: Option<String>,
    limit: Option<u32>,
}

pub async fn instance_logs(
    State(state): State<AppState>,
    Path(instance): Path<String>,
    query: Result<Query<LogsQuery>, axum::extract::rejection::QueryRejection>,
) -> ApiResult<Response> {
    use application::logs::{LogKind, LogsRequest};
    let Query(q) = query.map_err(|e| ApiError::bad_request(e.body_text()))?;
    let severities = non_empty(q.severity)
        .map(|raw| {
            raw.split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| {
                    domain::logs::LogSeverity::parse(s)
                        .ok_or_else(|| ApiError::bad_request(format!("severity inválida: '{s}'")))
                })
                .collect::<ApiResult<Vec<_>>>()
        })
        .transpose()?
        .unwrap_or_default();
    let request = LogsRequest {
        kind: non_empty(q.kind)
            .map(|k| LogKind::parse(&k))
            .transpose()?
            .unwrap_or_default(),
        deployment_id: non_empty(q.deployment_id),
        start: non_empty(q.start),
        end: non_empty(q.end),
        severities,
        search: q.q,
        limit: q.limit,
    };
    let logs = state
        .logs
        .read(id::<ServiceInstanceId>(&instance)?, request)
        .await?;
    Ok(Json(logs).into_response())
}

pub async fn instance_deployments(
    State(state): State<AppState>,
    Path(instance): Path<String>,
) -> ApiResult<Response> {
    let deployments = state
        .logs
        .deployments(id::<ServiceInstanceId>(&instance)?)
        .await?;
    Ok(Json(json!({ "deployments": deployments })).into_response())
}
