//! Credencial do Railway.

use application::credentials::RegisterCredential;
use application::railway::RailwayToken;
use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use domain::credential::CredentialKind;
use serde::Deserialize;
use serde_json::json;

use super::util::Body;
use crate::AppState;
use crate::error::{ApiError, ApiResult};

#[derive(Deserialize)]
pub struct CredentialInput {
    kind: String,
    workspace_id: Option<String>,
    token: String,
}

pub async fn get_credential(State(state): State<AppState>) -> ApiResult<Response> {
    Ok(Json(json!({ "credential": state.credentials.current().await? })).into_response())
}

pub async fn put_credential(
    State(state): State<AppState>,
    body: Body<CredentialInput>,
) -> ApiResult<Response> {
    let Json(input) = body?;
    let kind = match input.kind.as_str() {
        "account" => CredentialKind::Account,
        "workspace" => CredentialKind::Workspace,
        "project" => {
            return Err(ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "unsupported_token_kind",
                "tokens de projeto não são suportados: use um token de conta ou de workspace",
            ));
        }
        other => {
            return Err(ApiError::bad_request(format!(
                "tipo de token inválido: '{other}'"
            )));
        }
    };
    let metadata = state
        .credentials
        .register(RegisterCredential {
            kind,
            workspace_id: input.workspace_id,
            token: RailwayToken::new(input.token),
        })
        .await?;
    Ok(Json(json!({ "credential": metadata })).into_response())
}

pub async fn delete_credential(State(state): State<AppState>) -> ApiResult<StatusCode> {
    state.credentials.remove().await?;
    Ok(StatusCode::NO_CONTENT)
}
