//! Desligar/iniciar instâncias: plano → execução (concorrência limitada, isolamento
//! de falhas) → verificação por polling agrupado por ambiente (design, Decisão 6).

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::{DateTime, Utc};
use domain::deployment::DeploymentStatus;
use domain::ids::{
    EnvironmentId, OperationId, OperationItemId, PlanId, ProjectId, RailwayDeploymentId,
    RailwayEnvironmentId, ScheduleId, ScheduledActionId, ServiceInstanceId,
};
use domain::operation::{
    InstanceLabel, ItemResult, Operation, OperationItem, OperationScope, OperationStatus,
    OperationTrigger, Plan, PlanEntry,
};
use domain::power::{Decision, PowerKind, SkipReason, StopMechanism, decide};
use domain::state::{InstanceSnapshot, ObservedState, observe};
use serde::Serialize;
use tokio::sync::Semaphore;
use tokio::task::JoinHandle;

use crate::credentials::{ActiveCredential, CredentialService};
use crate::error::{AppError, AppResult};
use crate::inventory::observation;
use crate::ports::{
    Clock, ConsumeOutcome, InstanceView, InventoryRepository, OperationRepository, PlanRepository,
};
use crate::railway::{RailwayError, RailwayGateway, RailwayServiceInstance};

/// `requested_by` das operações disparadas por agendas.
pub const SCHEDULER_USER: &str = "agendador";

#[derive(Debug, Clone)]
pub struct PowerConfig {
    pub max_concurrency: usize,
    pub plan_ttl: Duration,
    pub start_timeout: Duration,
    pub stop_timeout: Duration,
    pub poll_interval: Duration,
    pub poll_max_interval: Duration,
    pub stop_mechanism: StopMechanism,
}

impl Default for PowerConfig {
    fn default() -> Self {
        Self {
            max_concurrency: 3,
            plan_ttl: Duration::from_secs(300),
            start_timeout: Duration::from_secs(600),
            stop_timeout: Duration::from_secs(180),
            poll_interval: Duration::from_secs(5),
            poll_max_interval: Duration::from_secs(15),
            stop_mechanism: StopMechanism::Remove,
        }
    }
}

/// Quem disparou a execução.
enum Origin {
    Manual,
    Schedule(ScheduleId, String),
    ScheduledAction(ScheduledActionId, String),
}

impl Origin {
    fn trigger(&self) -> OperationTrigger {
        match self {
            Self::Manual => OperationTrigger::Manual,
            Self::Schedule(..) => OperationTrigger::Schedule,
            Self::ScheduledAction(..) => OperationTrigger::ScheduledAction,
        }
    }
}

/// Alvo de uma operação.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PowerTarget {
    Instance(ServiceInstanceId),
    /// Instâncias gerenciadas do projeto: todas, as selecionadas, ou as de um ambiente.
    Project {
        project: ProjectId,
        environment: Option<EnvironmentId>,
        instances: Option<Vec<ServiceInstanceId>>,
    },
    /// Vários projetos; ambiente filtrado pelo nome (ex.: `staging`).
    Batch {
        projects: Vec<ProjectId>,
        environment_name: Option<String>,
    },
    /// Conjunto arbitrário de instâncias gerenciadas, de um ou mais projetos.
    Instances(Vec<ServiceInstanceId>),
}

/// Custo estimado em requisições ao Railway (mínimo, sem contar novas tentativas).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CostEstimate {
    pub mutations: usize,
    pub reads_per_poll: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PlannedOperation {
    pub plan: Plan,
    pub estimate: CostEstimate,
}

type CachedRead = (tokio::time::Instant, Arc<Vec<RailwayServiceInstance>>);

/// Leituras de ambiente compartilhadas entre itens concorrentes (uma chamada por
/// ambiente e ciclo, não uma por instância).
#[derive(Default)]
struct EnvReader {
    cache: Mutex<HashMap<RailwayEnvironmentId, CachedRead>>,
    locks: Mutex<HashMap<RailwayEnvironmentId, Arc<tokio::sync::Mutex<()>>>>,
}

impl EnvReader {
    async fn read(
        &self,
        railway: &dyn RailwayGateway,
        cred: &ActiveCredential,
        env: &RailwayEnvironmentId,
        max_age: Duration,
    ) -> Result<Arc<Vec<RailwayServiceInstance>>, RailwayError> {
        let lock = self
            .locks
            .lock()
            .unwrap()
            .entry(env.clone())
            .or_default()
            .clone();
        let _guard = lock.lock().await;
        if let Some((at, data)) = self.cache.lock().unwrap().get(env)
            && at.elapsed() <= max_age
        {
            return Ok(data.clone());
        }
        let data = Arc::new(
            railway
                .list_service_instances(&cred.token, env)
                .await?
                .unwrap_or_default(),
        );
        self.cache
            .lock()
            .unwrap()
            .insert(env.clone(), (tokio::time::Instant::now(), data.clone()));
        Ok(data)
    }
}

pub struct PowerService {
    inventory: Arc<dyn InventoryRepository>,
    plans: Arc<dyn PlanRepository>,
    operations: Arc<dyn OperationRepository>,
    credentials: Arc<CredentialService>,
    railway: Arc<dyn RailwayGateway>,
    clock: Arc<dyn Clock>,
    config: PowerConfig,
    semaphore: Arc<Semaphore>,
    workers: Mutex<Vec<JoinHandle<()>>>,
}

fn label(view: &InstanceView) -> InstanceLabel {
    InstanceLabel {
        project_id: view.project.id,
        project_name: view.project.shown_name().to_owned(),
        railway_project_id: view.project.railway_project_id.clone(),
        service_name: view.service.name.clone(),
        railway_service_id: view.service.railway_service_id.clone(),
        environment_name: view.environment.name.clone(),
        railway_environment_id: view.environment.railway_environment_id.clone(),
    }
}

fn find<'a>(
    instances: &'a [RailwayServiceInstance],
    label: &InstanceLabel,
) -> Option<&'a InstanceSnapshot> {
    instances
        .iter()
        .find(|i| i.service_id == label.railway_service_id)
        .map(|i| &i.snapshot)
}

impl PowerService {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        inventory: Arc<dyn InventoryRepository>,
        plans: Arc<dyn PlanRepository>,
        operations: Arc<dyn OperationRepository>,
        credentials: Arc<CredentialService>,
        railway: Arc<dyn RailwayGateway>,
        clock: Arc<dyn Clock>,
        config: PowerConfig,
    ) -> Self {
        let semaphore = Arc::new(Semaphore::new(config.max_concurrency.max(1)));
        Self {
            inventory,
            plans,
            operations,
            credentials,
            railway,
            clock,
            config,
            semaphore,
            workers: Mutex::new(Vec::new()),
        }
    }

    async fn resolve(
        &self,
        target: &PowerTarget,
    ) -> AppResult<(OperationScope, Vec<InstanceView>)> {
        let (scope, views) = match target {
            PowerTarget::Instance(id) => {
                let view = self
                    .inventory
                    .get_instance(*id)
                    .await?
                    .ok_or_else(|| AppError::NotFound("instância não encontrada".into()))?;
                (OperationScope::Instance, vec![view])
            }
            PowerTarget::Project {
                project,
                environment,
                instances,
            } => {
                let selected: Option<HashSet<_>> =
                    instances.as_ref().map(|ids| ids.iter().copied().collect());
                let views = self
                    .inventory
                    .list_instances(Some(*project))
                    .await?
                    .into_iter()
                    .filter(|v| environment.is_none_or(|e| v.environment.id == e))
                    .filter(|v| selected.as_ref().is_none_or(|s| s.contains(&v.instance.id)))
                    .collect();
                (OperationScope::Project, views)
            }
            PowerTarget::Batch {
                projects,
                environment_name,
            } => {
                if projects.is_empty() {
                    return Err(AppError::Validation("selecione ao menos um projeto".into()));
                }
                let wanted: HashSet<_> = projects.iter().copied().collect();
                let env = environment_name.as_deref().map(str::to_lowercase);
                let views = self
                    .inventory
                    .list_instances(None)
                    .await?
                    .into_iter()
                    .filter(|v| wanted.contains(&v.project.id))
                    .filter(|v| {
                        env.as_ref()
                            .is_none_or(|e| v.environment.name.to_lowercase() == *e)
                    })
                    .collect();
                (OperationScope::Batch, views)
            }
            PowerTarget::Instances(ids) => {
                if ids.is_empty() {
                    return Err(AppError::Validation(
                        "selecione ao menos uma instância".into(),
                    ));
                }
                let mut seen = HashSet::new();
                let wanted: Vec<_> = ids.iter().copied().filter(|i| seen.insert(*i)).collect();
                let mut by_id: HashMap<_, _> = self
                    .inventory
                    .list_instances(None)
                    .await?
                    .into_iter()
                    .map(|v| (v.instance.id, v))
                    .collect();
                let unknown: Vec<_> = wanted
                    .iter()
                    .copied()
                    .filter(|i| !by_id.contains_key(i))
                    .collect();
                if !unknown.is_empty() {
                    return Err(AppError::UnknownInstances(unknown));
                }
                let views = wanted.iter().filter_map(|i| by_id.remove(i)).collect();
                (OperationScope::Batch, views)
            }
        };
        if views.is_empty() {
            return Err(AppError::Validation(
                "nenhuma instância gerenciada corresponde ao alvo".into(),
            ));
        }
        Ok((scope, views))
    }

    /// Lê o estado atual no Railway e persiste o plano (válido por `plan_ttl`).
    pub async fn plan(&self, kind: PowerKind, target: &PowerTarget) -> AppResult<PlannedOperation> {
        let (scope, views) = self.resolve(target).await?;
        let cred = self.credentials.active().await?;
        let busy: HashSet<_> = self
            .operations
            .active_instance_ids()
            .await?
            .into_iter()
            .collect();

        let mut by_env: BTreeMap<RailwayEnvironmentId, Vec<&InstanceView>> = BTreeMap::new();
        for v in &views {
            by_env
                .entry(v.environment.railway_environment_id.clone())
                .or_default()
                .push(v);
        }
        let now = self.clock.now();
        let mut entries = Vec::with_capacity(views.len());
        for (env, group) in &by_env {
            let result = self.railway.list_service_instances(&cred.token, env).await;
            let instances = self
                .credentials
                .check(&cred, result)
                .await?
                .unwrap_or_default();
            for v in group {
                let label = label(v);
                let read = find(&instances, &label).cloned();
                self.inventory
                    .record_observation(v.instance.id, &observation(read.as_ref(), now))
                    .await?;
                let result = self.with_restart_source(&cred, kind, &label, read).await;
                let snapshot = self.credentials.check(&cred, result).await?;
                let snapshot = snapshot.as_ref();
                let decision = if busy.contains(&v.instance.id) {
                    Decision::WillSkip {
                        reason: SkipReason::OperationInProgress,
                    }
                } else {
                    decide(kind, snapshot)
                };
                entries.push(PlanEntry {
                    service_instance_id: v.instance.id,
                    current_state: observe(snapshot).state,
                    label,
                    decision,
                });
            }
        }

        let estimate = CostEstimate {
            mutations: entries
                .iter()
                .map(|e| match &e.decision {
                    Decision::WillStop { deployments } => deployments.len(),
                    Decision::WillStart { .. } => 1,
                    Decision::WillSkip { .. } => 0,
                })
                .sum(),
            reads_per_poll: by_env.len(),
        };
        let ttl = chrono::Duration::from_std(self.config.plan_ttl)
            .map_err(|e| AppError::Internal(e.to_string()))?;
        let plan = Plan::new(kind, scope, entries, now, now + ttl)
            .map_err(|e| AppError::Validation(e.to_string()))?;
        self.plans.save(&plan).await?;
        Ok(PlannedOperation { plan, estimate })
    }

    /// Consome um plano confirmado, cria a operação e a processa em segundo plano.
    pub async fn execute(
        self: &Arc<Self>,
        plan_id: PlanId,
        requested_by: &str,
    ) -> AppResult<OperationId> {
        self.execute_as(plan_id, requested_by, Origin::Manual).await
    }

    /// Execução disparada por uma agenda: mesmo fluxo, registrando a origem.
    pub async fn execute_scheduled(
        self: &Arc<Self>,
        plan_id: PlanId,
        schedule_id: ScheduleId,
        schedule_name: &str,
    ) -> AppResult<OperationId> {
        let origin = Origin::Schedule(schedule_id, schedule_name.to_owned());
        self.execute_as(plan_id, SCHEDULER_USER, origin).await
    }

    /// Execução disparada por uma ação agendada pontual.
    pub async fn execute_scheduled_action(
        self: &Arc<Self>,
        plan_id: PlanId,
        action_id: ScheduledActionId,
        label: &str,
    ) -> AppResult<OperationId> {
        let origin = Origin::ScheduledAction(action_id, label.to_owned());
        self.execute_as(plan_id, SCHEDULER_USER, origin).await
    }

    async fn execute_as(
        self: &Arc<Self>,
        plan_id: PlanId,
        requested_by: &str,
        origin: Origin,
    ) -> AppResult<OperationId> {
        let plan = self.plans.get(plan_id).await?.ok_or_else(|| {
            AppError::Validation("plano inexistente: gere e confirme um plano".into())
        })?;
        let now = self.clock.now();
        let mut operation = Operation {
            id: OperationId::new(),
            kind: plan.kind,
            scope: plan.scope,
            trigger: origin.trigger(),
            schedule_id: None,
            schedule_name: None,
            scheduled_action_id: None,
            scheduled_action_label: None,
            requested_by: requested_by.to_owned(),
            plan_id,
            status: OperationStatus::Pending,
            created_at: now,
            started_at: None,
            finished_at: None,
        };
        match origin {
            Origin::Manual => {}
            Origin::Schedule(id, name) => {
                operation.schedule_id = Some(id);
                operation.schedule_name = Some(name);
            }
            Origin::ScheduledAction(id, label) => {
                operation.scheduled_action_id = Some(id);
                operation.scheduled_action_label = Some(label);
            }
        }
        let items: Vec<_> = plan
            .entries
            .iter()
            .map(|e| {
                // Individual sobre instância ocupada: o item entra ativo para que o índice
                // de conflito o recuse na transação (409), em vez de virar `skipped`.
                let busy = matches!(
                    &e.decision,
                    Decision::WillSkip {
                        reason: SkipReason::OperationInProgress
                    }
                );
                if busy && plan.scope == OperationScope::Instance {
                    let pending = PlanEntry {
                        decision: Decision::WillStop {
                            deployments: vec![],
                        },
                        ..e.clone()
                    };
                    item_for(&operation, plan.kind, &pending, now)
                } else {
                    item_for(&operation, plan.kind, e, now)
                }
            })
            .collect();

        match self.plans.consume(plan_id, now, &operation, &items).await? {
            ConsumeOutcome::Created { operation_id, .. } => {
                let service = Arc::clone(self);
                let handle = tokio::spawn(async move { service.run(operation_id).await });
                let mut workers = self.workers.lock().unwrap();
                workers.retain(|h| !h.is_finished());
                workers.push(handle);
                Ok(operation_id)
            }
            ConsumeOutcome::AlreadyConsumed { operation_id } => {
                Err(AppError::PlanAlreadyUsed(operation_id))
            }
            ConsumeOutcome::Expired => {
                Err(AppError::Gone("o plano expirou: gere um novo plano".into()))
            }
            ConsumeOutcome::NotFound => Err(AppError::Validation("plano inexistente".into())),
            ConsumeOutcome::Conflict => Err(AppError::Conflict(
                "já existe uma operação em andamento para esta instância".into(),
            )),
        }
    }

    pub async fn get(&self, id: OperationId) -> AppResult<(Operation, Vec<OperationItem>)> {
        self.operations
            .get(id)
            .await?
            .ok_or_else(|| AppError::NotFound("operação não encontrada".into()))
    }

    /// Aguarda todas as operações em andamento (testes e desligamento).
    pub async fn wait_idle(&self) {
        loop {
            let handles: Vec<_> = std::mem::take(&mut *self.workers.lock().unwrap());
            if handles.is_empty() {
                return;
            }
            for handle in handles {
                let _ = handle.await;
            }
        }
    }

    /// Processa os itens pendentes de uma operação. Isolado para o agendador futuro.
    pub async fn run(self: Arc<Self>, operation_id: OperationId) {
        if let Err(err) = self.run_inner(operation_id).await {
            tracing::error!(%operation_id, %err, "falha ao processar operação");
        }
    }

    async fn run_inner(self: &Arc<Self>, operation_id: OperationId) -> AppResult<()> {
        let (operation, items) = self.get(operation_id).await?;
        self.operations
            .update_status(
                operation_id,
                OperationStatus::Running,
                Some(self.clock.now()),
                None,
            )
            .await?;

        let pending: Vec<_> = items
            .into_iter()
            .filter(|i| i.result == ItemResult::Pending)
            .collect();
        match self.credentials.active().await {
            Ok(cred) => {
                let reader = Arc::new(EnvReader::default());
                let mut tasks = tokio::task::JoinSet::new();
                for item in pending {
                    let service = Arc::clone(self);
                    let cred = cred.clone();
                    let reader = reader.clone();
                    let kind = operation.kind;
                    tasks.spawn(async move {
                        let _permit = service
                            .semaphore
                            .clone()
                            .acquire_owned()
                            .await
                            .expect("semáforo");
                        service.process(kind, item, &cred, &reader).await;
                    });
                }
                while let Some(result) = tasks.join_next().await {
                    if let Err(err) = result {
                        tracing::error!(%operation_id, %err, "tarefa de item abortada");
                    }
                }
            }
            Err(err) => {
                for mut item in pending {
                    self.finish(&mut item, ItemResult::Failed, None, Some(err.to_string()))
                        .await;
                }
            }
        }

        let (_, items) = self.get(operation_id).await?;
        let status = OperationStatus::aggregate(items.iter().map(|i| i.result))
            .unwrap_or(OperationStatus::Failed);
        self.operations
            .update_status(operation_id, status, None, Some(self.clock.now()))
            .await?;
        tracing::info!(%operation_id, status = status.as_str(), "operação concluída");
        Ok(())
    }

    /// Ciclo de vida de um item. Erros ficam no item; nunca interrompem os demais.
    async fn process(
        &self,
        kind: PowerKind,
        mut item: OperationItem,
        cred: &ActiveCredential,
        reader: &EnvReader,
    ) {
        // O registro é persistido antes de qualquer mutation; sem ele, nada é enviado.
        if item.advance(ItemResult::Running, self.clock.now()).is_err() {
            return;
        }
        if let Err(err) = self.operations.update_item(&item).await {
            tracing::error!(item = %item.id, %err, "falha ao registrar item; mutation não enviada");
            item.result = ItemResult::Pending;
            self.finish(
                &mut item,
                ItemResult::Failed,
                None,
                Some(format!("falha ao registrar o item: {err}")),
            )
            .await;
            return;
        }

        // Pré-condição: estado atual no Railway.
        let read = match self.read(cred, reader, &item, Duration::ZERO).await {
            Ok(snapshot) => {
                self.with_restart_source(cred, kind, &item.label, snapshot)
                    .await
            }
            Err(err) => Err(err),
        };
        let snapshot = match read {
            Ok(snapshot) => snapshot,
            Err(err) => {
                let message = format!("não foi possível ler o estado no Railway: {err}");
                self.finish(&mut item, ItemResult::Failed, None, Some(message))
                    .await;
                return;
            }
        };
        let current = observe(snapshot.as_ref()).state;
        let decision = decide(kind, snapshot.as_ref());

        let mut uncertain = None;
        match decision {
            Decision::WillSkip { reason } => {
                let result = if reason.is_failure() {
                    ItemResult::Failed
                } else {
                    ItemResult::Skipped
                };
                self.finish(&mut item, result, Some(current), Some(reason.message()))
                    .await;
                return;
            }
            Decision::WillStop { deployments } => {
                item.deployment_id = deployments.first().cloned();
                for id in &deployments {
                    match self.mutate_stop(cred, id).await {
                        Ok(()) => {}
                        Err(RailwayError::Uncertain(op)) => uncertain = Some(op),
                        Err(err) => {
                            self.fail_mutation(cred, &mut item, err, reader).await;
                            return;
                        }
                    }
                }
            }
            Decision::WillStart { from_deployment } => {
                match self.mutate_start(cred, &from_deployment).await {
                    Ok(new) => item.deployment_id = Some(new),
                    Err(RailwayError::Uncertain(op)) => uncertain = Some(op),
                    Err(err) => {
                        self.fail_mutation(cred, &mut item, err, reader).await;
                        return;
                    }
                }
            }
        }

        if let Some(op) = &uncertain {
            item.error_message = Some(format!(
                "resultado incerto ({op}): verificando o estado real"
            ));
        }
        let _ = item.advance(ItemResult::Verifying, self.clock.now());
        if let Err(err) = self.operations.update_item(&item).await {
            tracing::error!(item = %item.id, %err, "falha ao atualizar item");
        }
        self.verify(kind, item, cred, reader).await;
    }

    /// Para iniciar, a referência é o último commit que subiu, escolhido no histórico
    /// de deployments: `latestDeployment` omite os `REMOVED` e pode apontar para um
    /// deployment antigo (ex.: uma falha de meses atrás), que reimplantaria código velho.
    /// Só vale para instâncias paradas ou com falha; transição e aprovação seguem as
    /// regras normais.
    async fn with_restart_source(
        &self,
        cred: &ActiveCredential,
        kind: PowerKind,
        label: &InstanceLabel,
        snapshot: Option<InstanceSnapshot>,
    ) -> Result<Option<InstanceSnapshot>, RailwayError> {
        match snapshot {
            Some(mut s)
                if kind == PowerKind::Start
                    && s.active.is_empty()
                    && matches!(
                        observe(Some(&s)).state,
                        ObservedState::Stopped | ObservedState::Failed
                    ) =>
            {
                s.latest = self
                    .railway
                    .restart_source(
                        &cred.token,
                        &label.railway_environment_id,
                        &label.railway_service_id,
                    )
                    .await?;
                Ok(Some(s))
            }
            other => Ok(other),
        }
    }

    async fn mutate_stop(
        &self,
        cred: &ActiveCredential,
        id: &RailwayDeploymentId,
    ) -> Result<(), RailwayError> {
        retry_rate_limited(|| {
            self.railway
                .stop_deployment(&cred.token, id, self.config.stop_mechanism)
        })
        .await
    }

    async fn mutate_start(
        &self,
        cred: &ActiveCredential,
        id: &RailwayDeploymentId,
    ) -> Result<RailwayDeploymentId, RailwayError> {
        retry_rate_limited(|| self.railway.redeploy_deployment(&cred.token, id))
            .await
            .map(|d| d.id)
    }

    async fn fail_mutation(
        &self,
        cred: &ActiveCredential,
        item: &mut OperationItem,
        err: RailwayError,
        reader: &EnvReader,
    ) {
        if err.is_auth() {
            self.credentials.mark_invalid(cred).await;
        }
        let final_state = self
            .read(cred, reader, item, Duration::ZERO)
            .await
            .ok()
            .map(|s| observe(s.as_ref()).state);
        self.finish(item, ItemResult::Failed, final_state, Some(err.to_string()))
            .await;
    }

    /// Polling até o estado desejado, falha definitiva ou timeout.
    async fn verify(
        &self,
        kind: PowerKind,
        mut item: OperationItem,
        cred: &ActiveCredential,
        reader: &EnvReader,
    ) {
        let timeout = match kind {
            PowerKind::Start => self.config.start_timeout,
            PowerKind::Stop => self.config.stop_timeout,
        };
        let deadline = tokio::time::Instant::now() + timeout;
        let mut interval = self.config.poll_interval;
        let mut last_state = None;

        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                let message = format!("estado desejado não confirmado em {}s", timeout.as_secs());
                self.finish(&mut item, ItemResult::TimedOut, last_state, Some(message))
                    .await;
                return;
            }
            tokio::time::sleep(interval.min(remaining)).await;
            interval = interval.mul_f64(1.5).min(self.config.poll_max_interval);

            let snapshot = match self.read(cred, reader, &item, interval / 2).await {
                Ok(snapshot) => snapshot,
                Err(err) if err.is_auth() => {
                    self.credentials.mark_invalid(cred).await;
                    self.finish(
                        &mut item,
                        ItemResult::Failed,
                        last_state,
                        Some(err.to_string()),
                    )
                    .await;
                    return;
                }
                // Leitura falhou: tenta de novo no próximo ciclo, dentro do prazo.
                Err(_) => continue,
            };
            let state = observe(snapshot.as_ref()).state;
            last_state = Some(state);
            match evaluate(kind, snapshot.as_ref(), item.deployment_id.as_ref()) {
                Verdict::Done => {
                    // Confirmado: o aviso de "resultado incerto", se houve, deixa de valer.
                    item.error_message = None;
                    self.finish(&mut item, ItemResult::Succeeded, Some(state), None)
                        .await;
                    return;
                }
                Verdict::Failed(message) => {
                    self.finish(&mut item, ItemResult::Failed, Some(state), Some(message))
                        .await;
                    return;
                }
                Verdict::Wait => {}
            }
        }
    }

    /// Lê a instância do item (via leitura do ambiente) e atualiza o estado observado.
    async fn read(
        &self,
        cred: &ActiveCredential,
        reader: &EnvReader,
        item: &OperationItem,
        max_age: Duration,
    ) -> Result<Option<InstanceSnapshot>, RailwayError> {
        let instances = reader
            .read(
                self.railway.as_ref(),
                cred,
                &item.label.railway_environment_id,
                max_age,
            )
            .await?;
        let snapshot = find(&instances, &item.label).cloned();
        if let Some(instance) = item.service_instance_id {
            let o = observation(snapshot.as_ref(), self.clock.now());
            if let Err(err) = self.inventory.record_observation(instance, &o).await {
                tracing::warn!(%err, "falha ao registrar observação");
            }
        }
        Ok(snapshot)
    }

    async fn finish(
        &self,
        item: &mut OperationItem,
        result: ItemResult,
        final_state: Option<ObservedState>,
        message: Option<String>,
    ) {
        if item.advance(result, self.clock.now()).is_err() {
            tracing::error!(item = %item.id, from = %item.result, to = %result, "transição inválida");
            return;
        }
        item.final_state = final_state.or(item.final_state);
        if message.is_some() {
            item.error_message = message;
        }
        if let Err(err) = self.operations.update_item(item).await {
            tracing::error!(item = %item.id, %err, "falha ao gravar resultado do item");
        }
    }
}

/// Item inicial a partir da linha do plano: ações previstas ficam `pending`;
/// ignoradas já nascem finalizadas (`skipped`, ou `failed` quando o pedido é inviável).
fn item_for(
    operation: &Operation,
    kind: PowerKind,
    entry: &PlanEntry,
    now: DateTime<Utc>,
) -> OperationItem {
    let (result, message) = match &entry.decision {
        Decision::WillSkip { reason } if reason.is_failure() => {
            (ItemResult::Failed, Some(reason.message()))
        }
        Decision::WillSkip { reason } => (ItemResult::Skipped, Some(reason.message())),
        _ => (ItemResult::Pending, None),
    };
    let finished = result.is_final().then_some(now);
    OperationItem {
        id: OperationItemId::new(),
        operation_id: operation.id,
        service_instance_id: Some(entry.service_instance_id),
        label: entry.label.clone(),
        previous_state: entry.current_state,
        desired_state: kind.desired_state(),
        final_state: finished.map(|_| entry.current_state),
        deployment_id: None,
        result,
        error_message: message,
        started_at: None,
        finished_at: finished,
        duration_ms: finished.map(|_| 0),
    }
}

enum Verdict {
    Done,
    Wait,
    Failed(String),
}

fn evaluate(
    kind: PowerKind,
    snapshot: Option<&InstanceSnapshot>,
    deployment: Option<&RailwayDeploymentId>,
) -> Verdict {
    let o = observe(snapshot);
    if o.not_found {
        return Verdict::Failed("instância não encontrada no Railway".into());
    }
    let snapshot = snapshot.expect("encontrada");
    match kind {
        PowerKind::Stop => match o.state {
            ObservedState::Stopped => Verdict::Done,
            _ => Verdict::Wait,
        },
        PowerKind::Start => {
            let tracked = deployment.and_then(|id| {
                snapshot
                    .active
                    .iter()
                    .chain(snapshot.latest.iter())
                    .find(|d| &d.id == id)
            });
            match tracked.map(|d| d.status) {
                Some(DeploymentStatus::Success | DeploymentStatus::Sleeping) => Verdict::Done,
                Some(status) if status.is_failure() => {
                    Verdict::Failed(format!("o novo deployment terminou com status {status}"))
                }
                Some(_) => Verdict::Wait,
                // Sem deployment conhecido (resultado incerto): decide pelo estado.
                None => match o.state {
                    ObservedState::Running | ObservedState::Sleeping => Verdict::Done,
                    ObservedState::Failed => Verdict::Failed("o deployment falhou ao subir".into()),
                    _ => Verdict::Wait,
                },
            }
        }
    }
}

/// HTTP 429 garante que a mutation não foi aplicada: aguarda e reenvia (até 3 vezes).
async fn retry_rate_limited<T, F, Fut>(mut call: F) -> Result<T, RailwayError>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T, RailwayError>>,
{
    let mut attempts = 0;
    loop {
        match call().await {
            Err(RailwayError::RateLimited { retry_after_secs }) if attempts < 3 => {
                attempts += 1;
                tokio::time::sleep(Duration::from_secs(retry_after_secs.max(1))).await;
            }
            other => return other,
        }
    }
}
