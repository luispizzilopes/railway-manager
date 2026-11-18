//! Handlers HTTP. Validam a entrada, chamam os casos de uso e devolvem DTOs sem segredos.

use std::str::FromStr;

use application::credentials::RegisterCredential;
use application::inventory::InstanceRef;
use application::ports::HistoryFilter;
use application::power::{PlannedOperation, PowerTarget};
use application::railway::RailwayToken;
use axum::Json;
use axum::extract::rejection::JsonRejection;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use chrono::{DateTime, NaiveDate, Utc};
use domain::credential::CredentialKind;
use domain::ids::{OperationId, PlanId, ProjectId, ServiceId, ServiceInstanceId};
use domain::operation::ItemResult;
use domain::power::{Decision, PowerKind};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::AppState;
use crate::auth::{clear_cookie, hash_session, new_session_id, session_cookie, session_from};
use crate::error::{ApiError, ApiResult};

type Body<T> = Result<Json<T>, JsonRejection>;

fn id<T: FromStr>(raw: &str) -> ApiResult<T> {
    raw.parse()
        .map_err(|_| ApiError::not_found("recurso não encontrado"))
}

fn parse<T: FromStr>(field: &str, raw: &str) -> ApiResult<T> {
    raw.parse()
        .map_err(|_| ApiError::bad_request(format!("{field} inválido: '{raw}'")))
}

// ---------- sessão ----------

#[derive(Deserialize)]
pub struct Login {
    password: String,
}

pub async fn login(State(state): State<AppState>, body: Body<Login>) -> ApiResult<Response> {
    let auth = &state.auth;
    if let Some(wait) = auth.limiter.blocked_for() {
        let mut response = ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "too_many_attempts",
            "muitas tentativas de login; aguarde e tente novamente",
        )
        .into_response();
        if let Ok(value) = HeaderValue::from_str(&wait.as_secs().max(1).to_string()) {
            response.headers_mut().insert(header::RETRY_AFTER, value);
        }
        return Ok(response);
    }
    let Json(login) = body?;
    if !auth.password.verify(&login.password) {
        auth.limiter.record_failure();
        tracing::warn!("tentativa de login com senha incorreta");
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "invalid_credentials",
            "senha incorreta",
        ));
    }
    auth.limiter.reset();
    let session = new_session_id();
    let now = state.clock.now();
    let ttl = chrono::Duration::from_std(auth.session_ttl).unwrap_or(chrono::Duration::hours(12));
    state
        .sessions
        .create(&hash_session(&session), now, now + ttl)
        .await
        .map_err(application::error::AppError::from)?;
    let _ = state.sessions.purge_expired(now).await;
    tracing::info!("login do administrador");
    let mut response = StatusCode::NO_CONTENT.into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&session_cookie(&session, auth)).expect("cookie ASCII"),
    );
    Ok(response)
}

pub async fn logout(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Response> {
    if let Some(session) = session_from(&headers) {
        state
            .sessions
            .delete(&hash_session(&session))
            .await
            .map_err(application::error::AppError::from)?;
    }
    let mut response = StatusCode::NO_CONTENT.into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&clear_cookie(&state.auth)).expect("cookie ASCII"),
    );
    Ok(response)
}

pub async fn session() -> Json<serde_json::Value> {
    Json(json!({ "authenticated": true }))
}

// ---------- credencial ----------

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

// ---------- projetos ----------

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

// ---------- inventário ----------

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

// ---------- operações ----------

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
    let operation_id = state.power.execute(plan_id, "admin").await?;
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

// ---------- histórico ----------

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

/// Aceita RFC 3339 ou `AAAA-MM-DD` (início do dia; `to` vai até o fim do dia).
fn date(field: &str, raw: &str, end_of_day: bool) -> ApiResult<DateTime<Utc>> {
    if let Ok(dt) = DateTime::parse_from_rfc3339(raw) {
        return Ok(dt.to_utc());
    }
    let day = NaiveDate::parse_from_str(raw, "%Y-%m-%d")
        .map_err(|_| ApiError::bad_request(format!("{field} inválida: '{raw}'")))?;
    let time = if end_of_day {
        day.and_hms_milli_opt(23, 59, 59, 999)
    } else {
        day.and_hms_opt(0, 0, 0)
    };
    Ok(time.expect("hora válida").and_utc())
}

fn non_empty(v: Option<String>) -> Option<String> {
    v.map(|s| s.trim().to_owned()).filter(|s| !s.is_empty())
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

// ---------- logs ----------

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

// ---------- dashboard ----------

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

// ---------- agendas ----------

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

// ---------- ações agendadas ----------

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
