//! Painel, atualização e verificações de saúde.

use axum::Json;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use serde_json::json;

use crate::AppState;
use crate::error::{ApiError, ApiResult};

pub async fn dashboard(State(state): State<AppState>) -> ApiResult<Response> {
    Ok(Json(state.dashboard.overview().await?).into_response())
}

pub async fn refresh(State(state): State<AppState>) -> ApiResult<Response> {
    let report = state.inventory.refresh(None).await?;
    Ok(Json(json!({ "report": report })).into_response())
}

pub async fn healthz() -> Json<serde_json::Value> {
    Json(json!({ "status": "ok" }))
}

pub async fn api_not_found() -> ApiError {
    ApiError::not_found("rota não encontrada")
}
