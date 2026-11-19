//! Ambientes, instâncias e serviços.

use application::inventory::InstanceRef;
use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use domain::ids::{ProjectId, ServiceId, ServiceInstanceId};
use serde::Deserialize;
use serde_json::json;

use super::util::{Body, id};
use crate::AppState;
use crate::error::{ApiError, ApiResult};

pub async fn list_environments(
    State(state): State<AppState>,
    Path(project): Path<String>,
) -> ApiResult<Response> {
    let environments = state.inventory.local_environments(id(&project)?).await?;
    Ok(Json(json!({ "environments": environments })).into_response())
}

pub async fn discover_instances(
    State(state): State<AppState>,
    Path(project): Path<String>,
) -> ApiResult<Response> {
    let environments = state.inventory.discover(id(&project)?).await?;
    Ok(Json(json!({ "environments": environments })).into_response())
}

pub async fn list_instances(
    State(state): State<AppState>,
    Path(project): Path<String>,
) -> ApiResult<Response> {
    let project: ProjectId = id(&project)?;
    state.projects.get(project).await?;
    Ok(
        Json(json!({ "instances": state.inventory.local_instances(Some(project)).await? }))
            .into_response(),
    )
}

#[derive(Deserialize)]
pub struct InstanceInput {
    environment_id: String,
    service_id: String,
}

impl From<InstanceInput> for InstanceRef {
    fn from(i: InstanceInput) -> Self {
        Self {
            environment_id: i.environment_id,
            service_id: i.service_id,
        }
    }
}

pub async fn associate_instance(
    State(state): State<AppState>,
    Path(project): Path<String>,
    body: Body<InstanceInput>,
) -> ApiResult<Response> {
    let Json(input) = body?;
    let view = state
        .inventory
        .associate(id(&project)?, &input.into())
        .await?;
    Ok((StatusCode::CREATED, Json(json!({ "instance": view }))).into_response())
}

#[derive(Deserialize)]
pub struct ImportInstances {
    instances: Vec<InstanceInput>,
}

pub async fn import_instances(
    State(state): State<AppState>,
    Path(project): Path<String>,
    body: Body<ImportInstances>,
) -> ApiResult<Response> {
    let Json(input) = body?;
    if input.instances.is_empty() {
        return Err(ApiError::bad_request("selecione ao menos uma instância"));
    }
    let refs: Vec<InstanceRef> = input.instances.into_iter().map(Into::into).collect();
    Ok(Json(state.inventory.import(id(&project)?, &refs).await?).into_response())
}

pub async fn delete_instance(
    State(state): State<AppState>,
    Path(instance): Path<String>,
) -> ApiResult<StatusCode> {
    state
        .inventory
        .remove_instance(id::<ServiceInstanceId>(&instance)?)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn delete_service(
    State(state): State<AppState>,
    Path(service): Path<String>,
) -> ApiResult<StatusCode> {
    state
        .inventory
        .remove_service(id::<ServiceId>(&service)?)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}
