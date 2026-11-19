//! Planejamento e execução de operações de energia.

use application::power::{PlannedOperation, PowerTarget};
use axum::Extension;
use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use domain::ids::{OperationId, PlanId, ProjectId, ServiceInstanceId};
use domain::power::{Decision, PowerKind};
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::util::{Body, id, parse};
use crate::AppState;
use crate::auth::Principal;
use crate::error::{ApiError, ApiResult};

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TargetInput {
    Instance {
        instance_id: String,
    },
    Project {
        project_id: String,
        environment_id: Option<String>,
        instance_ids: Option<Vec<String>>,
    },
    Batch {
        project_ids: Vec<String>,
        environment_name: Option<String>,
    },
    Instances {
        instance_ids: Vec<String>,
    },
}

#[derive(Deserialize)]
pub struct PlanInput {
    kind: String,
    target: TargetInput,
}

fn target(input: TargetInput) -> ApiResult<PowerTarget> {
    Ok(match input {
        TargetInput::Instance { instance_id } => {
            PowerTarget::Instance(parse("instance_id", &instance_id)?)
        }
        TargetInput::Project {
            project_id,
            environment_id,
            instance_ids,
        } => PowerTarget::Project {
            project: parse("project_id", &project_id)?,
            environment: environment_id
                .as_deref()
                .map(|e| parse("environment_id", e))
                .transpose()?,
            instances: instance_ids
                .map(|ids| {
                    ids.iter()
                        .map(|i| parse("instance_ids", i))
                        .collect::<ApiResult<Vec<_>>>()
                })
                .transpose()?,
        },
        TargetInput::Batch {
            project_ids,
            environment_name,
        } => PowerTarget::Batch {
            projects: project_ids
                .iter()
                .map(|p| parse("project_ids", p))
                .collect::<ApiResult<_>>()?,
            environment_name: environment_name.filter(|e| !e.trim().is_empty()),
        },
        TargetInput::Instances { instance_ids } => PowerTarget::Instances(
            instance_ids
                .iter()
                .map(|i| parse("instance_ids", i))
                .collect::<ApiResult<_>>()?,
        ),
    })
}

#[derive(Serialize)]
struct PlanEntryDto {
    instance_id: ServiceInstanceId,
    project_id: ProjectId,
    project_name: String,
    service_name: String,
    environment_name: String,
    current_state: domain::state::ObservedState,
    action: &'static str,
    deployments: usize,
    reason_code: Option<serde_json::Value>,
    reason: Option<String>,
    fails: bool,
}

fn plan_dto(planned: PlannedOperation) -> serde_json::Value {
    let plan = planned.plan;
    let entries: Vec<_> = plan
        .entries
        .into_iter()
        .map(|e| {
            let (action, deployments, reason) = match &e.decision {
                Decision::WillStop { deployments } => ("will_stop", deployments.len(), None),
                Decision::WillStart { .. } => ("will_start", 1, None),
                Decision::WillSkip { reason } => ("will_skip", 0, Some(reason.clone())),
            };
            PlanEntryDto {
                instance_id: e.service_instance_id,
                project_id: e.label.project_id,
                project_name: e.label.project_name,
                service_name: e.label.service_name,
                environment_name: e.label.environment_name,
                current_state: e.current_state,
                action,
                deployments,
                fails: reason.as_ref().is_some_and(|r| r.is_failure()),
                reason: reason.as_ref().map(|r| r.message()),
                reason_code: reason
                    .map(|r| serde_json::to_value(r).unwrap_or_default()["code"].clone()),
            }
        })
        .collect();
    json!({
        "plan_id": plan.id,
        "kind": plan.kind,
        "scope": plan.scope,
        "created_at": plan.created_at,
        "expires_at": plan.expires_at,
        "entries": entries,
        "estimate": planned.estimate,
    })
}

pub async fn plan_operation(
    State(state): State<AppState>,
    body: Body<PlanInput>,
) -> ApiResult<Response> {
    let Json(input) = body?;
    let kind: PowerKind = parse("kind", &input.kind)?;
    let planned = state.power.plan(kind, &target(input.target)?).await?;
    Ok(Json(plan_dto(planned)).into_response())
}

#[derive(Deserialize)]
pub struct ExecuteInput {
    plan_id: Option<String>,
}

pub async fn execute_operation(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    body: Body<ExecuteInput>,
) -> ApiResult<Response> {
    let Json(input) = body?;
    let plan_id: PlanId = match input.plan_id.as_deref() {
        Some(raw) => parse("plan_id", raw)?,
        None => {
            return Err(ApiError::bad_request(
                "plan_id é obrigatório: gere e confirme um plano",
            ));
        }
    };
    let operation_id = state.power.execute(plan_id, &principal.username).await?;
    Ok((
        StatusCode::ACCEPTED,
        Json(json!({ "operation_id": operation_id })),
    )
        .into_response())
}

pub async fn get_operation(
    State(state): State<AppState>,
    Path(operation): Path<String>,
) -> ApiResult<Response> {
    let (operation, items) = state.power.get(id::<OperationId>(&operation)?).await?;
    let done = operation.status.is_final();
    Ok(Json(json!({ "operation": operation, "items": items, "done": done })).into_response())
}
