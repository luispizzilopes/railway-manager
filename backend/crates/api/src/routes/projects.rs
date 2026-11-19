//! Cadastro e sincronização de projetos.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::json;

use super::util::{Body, id};
use crate::AppState;
use crate::error::{ApiError, ApiResult};

pub async fn discover_projects(State(state): State<AppState>) -> ApiResult<Response> {
    Ok(Json(json!({ "workspaces": state.projects.discover().await? })).into_response())
}

pub async fn list_projects(State(state): State<AppState>) -> ApiResult<Response> {
    Ok(Json(json!({ "projects": state.projects.list().await? })).into_response())
}

#[derive(Deserialize)]
pub struct NewProject {
    railway_project_id: String,
    display_name: Option<String>,
}

pub async fn create_project(
    State(state): State<AppState>,
    body: Body<NewProject>,
) -> ApiResult<Response> {
    let Json(input) = body?;
    let project = state
        .projects
        .register(&input.railway_project_id, input.display_name.as_deref())
        .await?;
    Ok((StatusCode::CREATED, Json(json!({ "project": project }))).into_response())
}

#[derive(Deserialize)]
pub struct ImportProjects {
    railway_project_ids: Vec<String>,
}

pub async fn import_projects(
    State(state): State<AppState>,
    body: Body<ImportProjects>,
) -> ApiResult<Response> {
    let Json(input) = body?;
    if input.railway_project_ids.is_empty() {
        return Err(ApiError::bad_request("selecione ao menos um projeto"));
    }
    Ok(Json(state.projects.import(&input.railway_project_ids).await?).into_response())
}

pub async fn get_project(
    State(state): State<AppState>,
    Path(project): Path<String>,
) -> ApiResult<Response> {
    let project = state.projects.get(id(&project)?).await?;
    Ok(Json(json!({ "project": project })).into_response())
}

#[derive(Deserialize)]
pub struct EditProject {
    display_name: Option<String>,
    description: Option<String>,
}

pub async fn edit_project(
    State(state): State<AppState>,
    Path(project): Path<String>,
    body: Body<EditProject>,
) -> ApiResult<Response> {
    let Json(input) = body?;
    let project = state
        .projects
        .edit(
            id(&project)?,
            input.display_name.as_deref(),
            input.description.as_deref(),
        )
        .await?;
    Ok(Json(json!({ "project": project })).into_response())
}

pub async fn delete_project(
    State(state): State<AppState>,
    Path(project): Path<String>,
) -> ApiResult<StatusCode> {
    state.projects.remove(id(&project)?).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn sync_project(
    State(state): State<AppState>,
    Path(project): Path<String>,
) -> ApiResult<Response> {
    let (project, report) = state.projects.sync(id(&project)?).await?;
    Ok(Json(json!({ "project": project, "report": report })).into_response())
}
