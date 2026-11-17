//! Agendas: cadastro (com próximas execuções e avisos) e o agendador, que executa os
//! eventos no horário pelo mesmo fluxo das operações manuais.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Utc};
use chrono_tz::Tz;
use domain::ids::{EnvironmentId, ProjectId, ScheduleId, ScheduleRunId, ServiceInstanceId};
use domain::power::PowerKind;
use domain::schedule::{
    DueKind, EventTargets, Occurrence, RunStatus, Schedule, ScheduleRun, ScheduleSpec,
    ScheduleTarget, Window, due_events, next_occurrences, occurrences, resolve_conflicts,
};
use serde::Serialize;

use crate::credentials::CredentialService;
use crate::error::{AppError, AppResult};
use crate::ports::{
    Clock, InstanceView, InventoryRepository, Page, ProjectRepository, RepoError,
    ScheduleRepository, ScheduleRunRepository,
};
use crate::power::{PowerService, PowerTarget};

/// Motivo da pausa automática quando o alvo fica vazio.
pub const NO_TARGETS: &str = "sem instâncias no alvo";
const NEXT_RUNS: usize = 5;

/// Agenda como exposta pela API.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ScheduleDto {
    pub id: ScheduleId,
    pub project_id: ProjectId,
    pub name: String,
    pub enabled: bool,
    pub timezone: String,
    /// Índices 0 (segunda) a 6 (domingo).
    pub days: Vec<u32>,
    pub windows: Vec<Window>,
    pub target: ScheduleTarget,
    pub paused_reason: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl From<&Schedule> for ScheduleDto {
    fn from(s: &Schedule) -> Self {
        Self {
            id: s.id,
            project_id: s.project_id,
            name: s.name.clone(),
            enabled: s.enabled,
            timezone: s.timezone.name().to_owned(),
            days: s.days.indices().collect(),
            windows: s.windows.clone(),
            target: s.target.clone(),
            paused_reason: s.paused_reason.clone(),
            created_at: s.created_at,
            updated_at: s.updated_at,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ScheduleView {
    pub schedule: ScheduleDto,
    /// Próximos eventos (vazio se pausada).
    pub next_runs: Vec<Occurrence>,
    pub warnings: Vec<String>,
}

/// Próxima ação agendada de um projeto (para o dashboard).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NextAction {
    pub action: PowerKind,
    pub at: DateTime<Utc>,
    pub schedule_id: ScheduleId,
    pub schedule_name: String,
}

pub struct ScheduleService {
    schedules: Arc<dyn ScheduleRepository>,
    runs: Arc<dyn ScheduleRunRepository>,
    projects: Arc<dyn ProjectRepository>,
    inventory: Arc<dyn InventoryRepository>,
    clock: Arc<dyn Clock>,
    default_timezone: Tz,
    start_timeout: Duration,
}

/// Instâncias atuais do alvo de uma agenda.
fn target_instances(schedule: &Schedule, views: &[InstanceView]) -> Vec<ServiceInstanceId> {
    views
        .iter()
        .filter(|v| v.project.id == schedule.project_id)
        .filter(|v| match &schedule.target {
            ScheduleTarget::Project { environment_id } => {
                environment_id.is_none_or(|e| v.environment.id == e)
            }
            ScheduleTarget::Instances { instance_ids } => instance_ids.contains(&v.instance.id),
        })
        .map(|v| v.instance.id)
        .collect()
}

/// Intervalos "ligado" da agenda nos próximos dias, em UTC.
fn on_intervals(
    schedule: &Schedule,
    from: DateTime<Utc>,
    days: i64,
) -> Vec<(DateTime<Utc>, DateTime<Utc>)> {
    let to = from + chrono::Duration::days(days);
    // Começa um dia antes para pegar janelas já abertas que atravessam `from`.
    let events = occurrences(
        schedule.timezone,
        schedule.days,
        &schedule.windows,
        from - chrono::Duration::days(1),
        to,
    );
    let mut open: HashMap<usize, DateTime<Utc>> = HashMap::new();
    let mut out = Vec::new();
    for e in events {
        match e.action {
            PowerKind::Start => {
                open.insert(e.window, e.at);
            }
            PowerKind::Stop => {
                if let Some(start) = open.remove(&e.window) {
                    out.push((start, e.at));
                }
            }
        }
    }
    out
}

impl ScheduleService {
    pub fn new(
        schedules: Arc<dyn ScheduleRepository>,
        runs: Arc<dyn ScheduleRunRepository>,
        projects: Arc<dyn ProjectRepository>,
        inventory: Arc<dyn InventoryRepository>,
        clock: Arc<dyn Clock>,
        default_timezone: Tz,
        start_timeout: Duration,
    ) -> Self {
        Self {
            schedules,
            runs,
            projects,
            inventory,
            clock,
            default_timezone,
            start_timeout,
        }
    }

    pub fn default_timezone(&self) -> Tz {
        self.default_timezone
    }

    async fn find(&self, id: ScheduleId) -> AppResult<Schedule> {
        self.schedules
            .get(id)
            .await?
            .ok_or_else(|| AppError::NotFound("agenda não encontrada".into()))
    }

    /// Ambiente e instâncias do alvo precisam ser do projeto.
    async fn check_target(&self, project: ProjectId, target: &ScheduleTarget) -> AppResult<()> {
        match target {
            ScheduleTarget::Project {
                environment_id: Some(env),
            } => {
                let envs = self.inventory.list_environments(project).await?;
                if !envs.iter().any(|e| e.id == *env) {
                    return Err(AppError::Validation(
                        "o ambiente não pertence ao projeto".into(),
                    ));
                }
            }
            ScheduleTarget::Project {
                environment_id: None,
            } => {}
            ScheduleTarget::Instances { instance_ids } => {
                let owned: HashSet<_> = self
                    .inventory
                    .list_instances(Some(project))
                    .await?
                    .into_iter()
                    .map(|v| v.instance.id)
                    .collect();
                if let Some(missing) = instance_ids.iter().find(|i| !owned.contains(i)) {
                    return Err(AppError::Validation(format!(
                        "a instância {missing} não pertence ao projeto"
                    )));
                }
            }
        }
        Ok(())
    }

    async fn view(&self, schedule: &Schedule) -> AppResult<ScheduleView> {
        let now = self.clock.now();
        let next_runs = if schedule.enabled {
            next_occurrences(
                schedule.timezone,
                schedule.days,
                &schedule.windows,
                now,
                NEXT_RUNS,
            )
        } else {
            vec![]
        };
        Ok(ScheduleView {
            schedule: schedule.into(),
            next_runs,
            warnings: self.warnings(schedule).await?,
        })
    }

    /// Avisos que não impedem salvar: sobreposição com outras agendas ativas que
    /// compartilham instâncias e janelas menores que o prazo de confirmação ao iniciar.
    async fn warnings(&self, schedule: &Schedule) -> AppResult<Vec<String>> {
        let mut out = Vec::new();
        let minimum = (self.start_timeout.as_secs() / 60) as u32;
        for w in &schedule.windows {
            if w.duration() < minimum {
                out.push(format!(
                    "a janela {}–{} é menor que o prazo para confirmar o início ({minimum} min): o desligamento \
                     pode encontrar a instância ainda subindo",
                    w.start, w.end
                ));
            }
        }
        if !schedule.enabled {
            return Ok(out);
        }
        let views = self
            .inventory
            .list_instances(Some(schedule.project_id))
            .await?;
        let mine: HashSet<_> = target_instances(schedule, &views).into_iter().collect();
        let now = self.clock.now();
        let my_intervals = on_intervals(schedule, now, 8);
        for other in self.schedules.list(Some(schedule.project_id)).await? {
            if other.id == schedule.id || !other.enabled {
                continue;
            }
            let shared = target_instances(&other, &views)
                .into_iter()
                .filter(|i| mine.contains(i))
                .count();
            if shared == 0 {
                continue;
            }
            let overlaps = on_intervals(&other, now, 8)
                .iter()
                .any(|(s2, e2)| my_intervals.iter().any(|(s1, e1)| s1 < e2 && s2 < e1));
            if overlaps {
                out.push(format!(
                    "os horários se sobrepõem aos da agenda \"{}\" ({shared} instância(s) em comum)",
                    other.name
                ));
            }
        }
        Ok(out)
    }

    pub async fn create(&self, project: ProjectId, spec: ScheduleSpec) -> AppResult<ScheduleView> {
        self.projects
            .get(project)
            .await?
            .ok_or_else(|| AppError::NotFound("projeto não encontrado".into()))?;
        let schedule = Schedule::new(project, spec, self.clock.now())?;
        self.check_target(project, &schedule.target).await?;
        self.schedules
            .insert(&schedule)
            .await
            .map_err(|e| match e {
                RepoError::Conflict(msg) => AppError::Validation(msg),
                other => other.into(),
            })?;
        tracing::info!(schedule = %schedule.id, name = %schedule.name, "agenda criada");
        self.view(&schedule).await
    }

    /// Edição vale a partir de agora (eventos anteriores não são recuperados).
    pub async fn update(&self, id: ScheduleId, spec: ScheduleSpec) -> AppResult<ScheduleView> {
        let mut schedule = self.find(id).await?;
        schedule.update(spec, self.clock.now())?;
        self.check_target(schedule.project_id, &schedule.target)
            .await?;
        self.schedules.update(&schedule).await?;
        self.view(&schedule).await
    }

    pub async fn pause(&self, id: ScheduleId) -> AppResult<ScheduleView> {
        let mut schedule = self.find(id).await?;
        schedule.pause(None, self.clock.now());
        self.schedules.update(&schedule).await?;
        self.view(&schedule).await
    }

    pub async fn resume(&self, id: ScheduleId) -> AppResult<ScheduleView> {
        let mut schedule = self.find(id).await?;
        if let ScheduleTarget::Instances { instance_ids } = &schedule.target
            && instance_ids.is_empty()
        {
            return Err(AppError::Validation(
                "a agenda não tem instâncias no alvo: edite-a antes de retomar".into(),
            ));
        }
        schedule.resume(self.clock.now());
        self.schedules.update(&schedule).await?;
        self.view(&schedule).await
    }

    pub async fn delete(&self, id: ScheduleId) -> AppResult<()> {
        self.schedules.delete(id).await.map_err(|e| match e {
            RepoError::NotFound => AppError::NotFound("agenda não encontrada".into()),
            other => other.into(),
        })
    }

    pub async fn get(&self, id: ScheduleId) -> AppResult<ScheduleView> {
        self.pause_orphans().await?;
        let schedule = self.find(id).await?;
        self.view(&schedule).await
    }

    pub async fn list(&self, project: Option<ProjectId>) -> AppResult<Vec<ScheduleView>> {
        self.pause_orphans().await?;
        let mut out = Vec::new();
        for schedule in self.schedules.list(project).await? {
            out.push(self.view(&schedule).await?);
        }
        Ok(out)
    }

    pub async fn runs(
        &self,
        id: ScheduleId,
        page: Option<u32>,
        per_page: Option<u32>,
    ) -> AppResult<Page<ScheduleRun>> {
        self.find(id).await?;
        Ok(self
            .runs
            .list(id, page.unwrap_or(1), per_page.unwrap_or(20))
            .await?)
    }

    /// Agendas de instâncias selecionadas que ficaram sem alvo são pausadas.
    pub async fn pause_orphans(&self) -> AppResult<u64> {
        let paused = self
            .schedules
            .pause_without_targets(NO_TARGETS, self.clock.now())
            .await?;
        if paused > 0 {
            tracing::warn!(paused, "agendas pausadas por ficarem sem instâncias");
        }
        Ok(paused)
    }

    /// Próxima ação agendada por projeto (agendas ativas).
    pub async fn next_actions(&self) -> AppResult<HashMap<ProjectId, NextAction>> {
        let now = self.clock.now();
        let mut out: HashMap<ProjectId, NextAction> = HashMap::new();
        for schedule in self
            .schedules
            .list(None)
            .await?
            .into_iter()
            .filter(|s| s.enabled)
        {
            let Some(next) =
                next_occurrences(schedule.timezone, schedule.days, &schedule.windows, now, 1).pop()
            else {
                continue;
            };
            let candidate = NextAction {
                action: next.action,
                at: next.at,
                schedule_id: schedule.id,
                schedule_name: schedule.name.clone(),
            };
            out.entry(schedule.project_id)
                .and_modify(|current| {
                    if candidate.at < current.at {
                        *current = candidate.clone();
                    }
                })
                .or_insert(candidate);
        }
        Ok(out)
    }
}

/// Dados de entrada de uma agenda (já convertidos pela API).
pub fn spec(
    name: String,
    timezone: Tz,
    days: domain::schedule::Weekdays,
    windows: Vec<Window>,
    environment: Option<EnvironmentId>,
    instances: Option<Vec<ServiceInstanceId>>,
) -> ScheduleSpec {
    let target = match instances {
        Some(instance_ids) => ScheduleTarget::Instances { instance_ids },
        None => ScheduleTarget::Project {
            environment_id: environment,
        },
    };
    ScheduleSpec {
        name,
        timezone,
        days,
        windows,
        target,
    }
}

#[derive(Debug, Clone)]
pub struct SchedulerConfig {
    pub tick: Duration,
    pub catchup: Duration,
}

/// Resumo de um ciclo do agendador.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TickReport {
    pub executed: usize,
    pub skipped: usize,
    pub missed: usize,
    pub failed: usize,
}

pub struct SchedulerService {
    schedules: Arc<ScheduleService>,
    schedule_repo: Arc<dyn ScheduleRepository>,
    runs: Arc<dyn ScheduleRunRepository>,
    inventory: Arc<dyn InventoryRepository>,
    credentials: Arc<CredentialService>,
    power: Arc<PowerService>,
    clock: Arc<dyn Clock>,
    config: SchedulerConfig,
}

impl SchedulerService {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        schedules: Arc<ScheduleService>,
        schedule_repo: Arc<dyn ScheduleRepository>,
        runs: Arc<dyn ScheduleRunRepository>,
        inventory: Arc<dyn InventoryRepository>,
        credentials: Arc<CredentialService>,
        power: Arc<PowerService>,
        clock: Arc<dyn Clock>,
        config: SchedulerConfig,
    ) -> Self {
        Self {
            schedules,
            schedule_repo,
            runs,
            inventory,
            credentials,
            power,
            clock,
            config,
        }
    }

    pub fn config(&self) -> &SchedulerConfig {
        &self.config
    }

    /// Na inicialização: eventos registrados sem operação (processo caiu no meio)
    /// viram `failed`; nunca são reexecutados.
    pub async fn startup(&self) -> AppResult<u64> {
        Ok(self
            .runs
            .fail_pending("interrompido por reinício do servidor", self.clock.now())
            .await?)
    }

    /// Avalia as agendas até `now` e executa os eventos devidos.
    pub async fn tick(&self, now: DateTime<Utc>) -> AppResult<TickReport> {
        self.schedules.pause_orphans().await?;
        let mut report = TickReport::default();
        let Some(last) = self.runs.last_evaluated().await? else {
            // Primeira execução: não há passado a recuperar.
            self.runs.record_tick(&[], now).await?;
            return Ok(report);
        };

        let catchup = chrono::Duration::from_std(self.config.catchup)
            .unwrap_or(chrono::Duration::minutes(30));
        let late_after = chrono::Duration::from_std(self.config.tick * 2)
            .unwrap_or(chrono::Duration::minutes(1));
        let schedules: HashMap<ScheduleId, Schedule> = self
            .schedule_repo
            .list(None)
            .await?
            .into_iter()
            .map(|s| (s.id, s))
            .collect();

        let mut runs = Vec::new();
        let mut late: HashSet<ScheduleRunId> = HashSet::new();
        for schedule in schedules.values() {
            for due in due_events(schedule, last, now, catchup, late_after) {
                let (status, message) = match due.kind {
                    DueKind::Execute { .. } => (RunStatus::Pending, None),
                    DueKind::Missed => (
                        RunStatus::Missed,
                        Some("servidor indisponível no horário".to_owned()),
                    ),
                };
                let run = ScheduleRun {
                    id: ScheduleRunId::new(),
                    schedule_id: schedule.id,
                    schedule_name: schedule.name.clone(),
                    action: due.occurrence.action,
                    scheduled_for: due.occurrence.at,
                    processed_at: now,
                    status,
                    operation_id: None,
                    message,
                };
                if due.kind == (DueKind::Execute { late: true }) {
                    late.insert(run.id);
                }
                runs.push(run);
            }
        }
        let inserted = self.runs.record_tick(&runs, now).await?;
        report.missed = inserted
            .iter()
            .filter(|r| r.status == RunStatus::Missed)
            .count();

        let pending: Vec<ScheduleRun> = inserted
            .into_iter()
            .filter(|r| r.status == RunStatus::Pending)
            .collect();
        if pending.is_empty() {
            return Ok(report);
        }

        // Alvos atuais e resolução de conflitos (iniciar prevalece no mesmo instante).
        let views = self.inventory.list_instances(None).await?;
        let events: Vec<EventTargets> = pending
            .iter()
            .map(|run| EventTargets {
                schedule_id: run.schedule_id,
                at: run.scheduled_for,
                action: run.action,
                instances: schedules
                    .get(&run.schedule_id)
                    .map(|s| target_instances(s, &views))
                    .unwrap_or_default(),
            })
            .collect();
        let resolved = resolve_conflicts(events);
        let mut conflict_notes: HashMap<(ScheduleId, DateTime<Utc>, PowerKind), Vec<String>> =
            HashMap::new();
        for (event, conflicts) in &resolved {
            for c in conflicts {
                let starting = schedules
                    .get(&c.starting_schedule)
                    .map(|s| s.name.clone())
                    .unwrap_or_default();
                let stopping = schedules
                    .get(&event.schedule_id)
                    .map(|s| s.name.clone())
                    .unwrap_or_default();
                conflict_notes
                    .entry((event.schedule_id, event.at, event.action))
                    .or_default()
                    .push(format!(
                        "conflito com a agenda \"{starting}\": iniciar prevalece"
                    ));
                conflict_notes
                    .entry((c.starting_schedule, event.at, PowerKind::Start))
                    .or_default()
                    .push(format!(
                        "conflito com a agenda \"{stopping}\": iniciar prevalece"
                    ));
            }
        }

        for (mut run, (event, _)) in pending.into_iter().zip(resolved) {
            let notes = conflict_notes
                .remove(&(run.schedule_id, run.scheduled_for, run.action))
                .unwrap_or_default();
            let schedule = &schedules[&run.schedule_id];
            let outcome = self.execute(schedule, &run, &event).await;
            run.processed_at = self.clock.now();
            let (status, operation, message) = match outcome {
                Ok(Some(operation)) => {
                    let status = if late.contains(&run.id) {
                        RunStatus::Late
                    } else {
                        RunStatus::Executed
                    };
                    (status, Some(operation), None)
                }
                Ok(None) => {
                    let reason = if notes.is_empty() {
                        "nenhuma instância no alvo"
                    } else {
                        "todas as instâncias em conflito"
                    };
                    (RunStatus::Skipped, None, Some(reason.to_owned()))
                }
                Err(err) => (RunStatus::Failed, None, Some(err.to_string())),
            };
            match status {
                RunStatus::Executed | RunStatus::Late => report.executed += 1,
                RunStatus::Skipped => report.skipped += 1,
                _ => report.failed += 1,
            }
            let mut parts: Vec<String> = message.into_iter().collect();
            parts.extend(notes);
            run.status = status;
            run.operation_id = operation;
            run.message = (!parts.is_empty()).then(|| parts.join("; "));
            if let Err(err) = self.runs.update(&run).await {
                tracing::error!(%err, run = %run.id, "falha ao registrar execução de agenda");
            }
            tracing::info!(
                schedule = %schedule.name,
                action = run.action.as_str(),
                status = run.status.as_str(),
                "evento de agenda processado"
            );
        }
        Ok(report)
    }

    /// Executa um evento; `Ok(None)` quando não há instâncias a tratar.
    async fn execute(
        &self,
        schedule: &Schedule,
        run: &ScheduleRun,
        event: &EventTargets,
    ) -> AppResult<Option<domain::ids::OperationId>> {
        if event.instances.is_empty() {
            return Ok(None);
        }
        // Sem credencial utilizável nada é enviado ao Railway.
        self.credentials.active().await?;
        let target = PowerTarget::Project {
            project: schedule.project_id,
            environment: None,
            instances: Some(event.instances.clone()),
        };
        let planned = self.power.plan(run.action, &target).await?;
        let operation = self
            .power
            .execute_scheduled(planned.plan.id, schedule.id, &schedule.name)
            .await?;
        Ok(Some(operation))
    }
}
