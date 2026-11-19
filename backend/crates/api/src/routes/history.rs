//! Histórico de operações.

use application::ports::HistoryFilter;
use axum::Json;
use axum::extract::{Query, State};
use axum::response::{IntoResponse, Response};
use domain::operation::ItemResult;
use serde::Deserialize;

use super::util::{date, non_empty, parse};
use crate::AppState;
use crate::error::{ApiError, ApiResult};

#[derive(Deserialize, Default)]
pub struct HistoryQuery {
    project: Option<String>,
    service: Option<String>,
    environment: Option<String>,
    kind: Option<String>,
    result: Option<String>,
    trigger: Option<String>,
    from: Option<String>,
    to: Option<String>,
    page: Option<u32>,
    per_page: Option<u32>,
}

pub async fn history(
    State(state): State<AppState>,
    query: Result<Query<HistoryQuery>, axum::extract::rejection::QueryRejection>,
) -> ApiResult<Response> {
    let Query(q) = query.map_err(|e| ApiError::bad_request(e.body_text()))?;
    let filter = HistoryFilter {
        railway_project_id: non_empty(q.project)
            .map(|v| parse("project", &v))
            .transpose()?,
        railway_service_id: non_empty(q.service)
            .map(|v| parse("service", &v))
            .transpose()?,
        environment_name: non_empty(q.environment),
        kind: non_empty(q.kind).map(|v| parse("kind", &v)).transpose()?,
        result: non_empty(q.result)
            .map(|v| parse::<ItemResult>("result", &v))
            .transpose()?,
        trigger: non_empty(q.trigger)
            .map(|v| parse::<domain::operation::OperationTrigger>("trigger", &v))
            .transpose()?,
        from: non_empty(q.from)
            .map(|v| date("from", &v, false))
            .transpose()?,
        to: non_empty(q.to).map(|v| date("to", &v, true)).transpose()?,
    };
    Ok(Json(state.history.query(&filter, q.page, q.per_page).await?).into_response())
}
