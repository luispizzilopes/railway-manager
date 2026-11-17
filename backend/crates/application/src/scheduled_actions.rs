//! Ações agendadas pontuais: cadastro, cancelamento e execução pelo agendador
//! (change command-console, design decisão 6).

use std::collections::HashSet;
use std::sync::Arc;

use chrono::{DateTime, Utc};
use chrono_tz::Tz;
use domain::ids::{OperationId, ScheduledActionId, ServiceInstanceId};
use domain::scheduled_action::{
    ActionTarget, ScheduledAction, ScheduledActionSpec, ScheduledActionStatus, label,
};

use crate::credentials::CredentialService;
use crate::error::{AppError, AppResult};
use crate::ports::{
    Clock, InstanceView, InventoryRepository, Page, ProjectRepository, RepoError,
    ScheduledActionRepository,
};
use crate::power::{PowerService, PowerTarget};

/// Motivo de `skipped` quando nada resta no alvo.
pub const NO_TARGETS: &str = "sem instâncias no alvo";
const INTERRUPTED: &str = "interrompida por reinício do servidor";

/// Resumo do processamento das ações num ciclo do agendador.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ActionsReport {
    pub executed: usize,
    pub skipped: usize,
    pub missed: usize,
    pub failed: usize,
}

pub struct ScheduledActionService {
    actions: Arc<dyn ScheduledActionRepository>,
    projects: Arc<dyn ProjectRepository>,
    inventory: Arc<dyn InventoryRepository>,
    clock: Arc<dyn Clock>,
    default_timezone: Tz,
}

/// Instâncias atuais do alvo (resolvido na hora da execução).
fn resolve(target: &ActionTarget, views: &[InstanceView]) -> Vec<ServiceInstanceId> {
    let env_matches = |v: &InstanceView, env: Option<&str>| {
        env.is_none_or(|e| v.environment.name.eq_ignore_ascii_case(e))
    };
    match target {
        ActionTarget::All { environment_name } => views
            .iter()
            .filter(|v| env_matches(v, environment_name.as_deref()))
            .map(|v| v.instance.id)
            .collect(),
        ActionTarget::Projects {
            project_ids,
            environment_name,
        } => views
            .iter()
            .filter(|v| project_ids.contains(&v.project.id))
            .filter(|v| env_matches(v, environment_name.as_deref()))
            .map(|v| v.instance.id)
            .collect(),
        ActionTarget::Instances { instance_ids } => {
            let managed: HashSet<_> = views.iter().map(|v| v.instance.id).collect();
            instance_ids
                .iter()
                .copied()
                .filter(|i| managed.contains(i))
                .collect()
        }
    }
}

fn status_message(status: ScheduledActionStatus) -> &'static str {
    match status {
        ScheduledActionStatus::Pending => "a ação está pendente",
        ScheduledActionStatus::Processing => "a ação já está sendo executada",
        ScheduledActionStatus::Executed | ScheduledActionStatus::Late => "a ação já foi executada",
        ScheduledActionStatus::Skipped => "a ação já foi processada (ignorada)",
        ScheduledActionStatus::Missed => "a ação foi perdida (servidor indisponível no horário)",
        ScheduledActionStatus::Failed => "a ação já foi processada e falhou",
        ScheduledActionStatus::Cancelled => "a ação já foi cancelada",
    }
}

impl ScheduledActionService {
    pub fn new(
        actions: Arc<dyn ScheduledActionRepository>,
        projects: Arc<dyn ProjectRepository>,
        inventory: Arc<dyn InventoryRepository>,
        clock: Arc<dyn Clock>,
        default_timezone: Tz,
    ) -> Self {
        Self {
            actions,
            projects,
            inventory,
            clock,
            default_timezone,
        }
    }

    pub fn default_timezone(&self) -> Tz {
        self.default_timezone
    }

    pub async fn create(&self, spec: ScheduledActionSpec) -> AppResult<ScheduledAction> {
        let now = self.clock.now();
        let spec = spec
            .validate(now)
            .map_err(|e| AppError::Validation(e.to_string()))?;
        let names = match &spec.target {
            ActionTarget::All { .. } => vec![],
            ActionTarget::Projects { project_ids, .. } => {
                let mut names = Vec::with_capacity(project_ids.len());
                for id in project_ids {
                    let project = self.projects.get(*id).await?.ok_or_else(|| {
                        AppError::Validation(format!("projeto não gerenciado: {id}"))
                    })?;
                    names.push(project.shown_name().to_owned());
                }
                names
            }
            ActionTarget::Instances { instance_ids } => {
                let views = self.inventory.list_instances(None).await?;
                let unknown: Vec<_> = instance_ids
                    .iter()
                    .copied()
                    .filter(|i| !views.iter().any(|v| v.instance.id == *i))
                    .collect();
                if !unknown.is_empty() {
                    return Err(AppError::UnknownInstances(unknown));
                }
                instance_ids
                    .iter()
                    .filter_map(|i| views.iter().find(|v| v.instance.id == *i))
                    .map(|v| {
                        format!(
                            "{}/{}@{}",
                            v.project.shown_name(),
                            v.service.name,
                            v.environment.name
                        )
                    })
                    .collect()
            }
        };
        let action = ScheduledAction::new(spec.clone(), label(&spec.target, &names), now);
        self.actions.insert(&action).await?;
        tracing::info!(
            action = %action.id,
            kind = action.kind.as_str(),
            run_at = %action.run_at,
            "ação agendada criada"
        );
        Ok(action)
    }

    pub async fn list(
        &self,
        status: Option<ScheduledActionStatus>,
        page: Option<u32>,
        per_page: Option<u32>,
    ) -> AppResult<Page<ScheduledAction>> {
        Ok(self
            .actions
            .list(status, page.unwrap_or(1), per_page.unwrap_or(50))
            .await?)
    }

    pub async fn get(&self, id: ScheduledActionId) -> AppResult<ScheduledAction> {
        self.actions
            .get(id)
            .await?
            .ok_or_else(|| AppError::NotFound("ação agendada não encontrada".into()))
    }

    pub async fn cancel(&self, id: ScheduledActionId) -> AppResult<ScheduledAction> {
        match self.actions.cancel(id, self.clock.now()).await {
            Ok(Ok(action)) => {
                tracing::info!(action = %action.id, "ação agendada cancelada");
                Ok(action)
            }
            Ok(Err(status)) => Err(AppError::Conflict(status_message(status).into())),
            Err(RepoError::NotFound) => {
                Err(AppError::NotFound("ação agendada não encontrada".into()))
            }
            Err(err) => Err(err.into()),
        }
    }

    /// Na inicialização: ações reivindicadas por um processo que caiu viram `failed`.
    pub async fn startup(&self) -> AppResult<u64> {
        Ok(self
            .actions
            .fail_processing(INTERRUPTED, self.clock.now())
            .await?)
    }

    /// Processa as ações vencidas até `now` (chamado pelo agendador a cada ciclo).
    pub async fn process_due(
        &self,
        now: DateTime<Utc>,
        catchup: chrono::Duration,
        late_after: chrono::Duration,
        credentials: &CredentialService,
        power: &Arc<PowerService>,
    ) -> AppResult<ActionsReport> {
        let mut report = ActionsReport::default();
        for mut action in self.actions.due(now).await? {
            if !self.actions.claim(action.id).await? {
                continue;
            }
            let delay = now - action.run_at;
            let (status, operation, message) = if delay > catchup {
                (
                    ScheduledActionStatus::Missed,
                    None,
                    Some("servidor indisponível no horário".to_owned()),
                )
            } else {
                match self.execute(&action, credentials, power).await {
                    Ok(Some(operation)) if delay > late_after => {
                        (ScheduledActionStatus::Late, Some(operation), None)
                    }
                    Ok(Some(operation)) => (ScheduledActionStatus::Executed, Some(operation), None),
                    Ok(None) => (
                        ScheduledActionStatus::Skipped,
                        None,
                        Some(NO_TARGETS.to_owned()),
                    ),
                    Err(err) => (ScheduledActionStatus::Failed, None, Some(err.to_string())),
                }
            };
            match status {
                ScheduledActionStatus::Executed | ScheduledActionStatus::Late => {
                    report.executed += 1
                }
                ScheduledActionStatus::Skipped => report.skipped += 1,
                ScheduledActionStatus::Missed => report.missed += 1,
                _ => report.failed += 1,
            }
            action.status = status;
            action.operation_id = operation;
            action.message = message;
            action.processed_at = Some(self.clock.now());
            if let Err(err) = self.actions.finish(&action).await {
                tracing::error!(%err, action = %action.id, "falha ao registrar ação agendada");
            }
            tracing::info!(
                action = %action.id,
                kind = action.kind.as_str(),
                status = action.status.as_str(),
                "ação agendada processada"
            );
        }
        Ok(report)
    }

    /// `Ok(None)` quando não há instâncias a tratar.
    async fn execute(
        &self,
        action: &ScheduledAction,
        credentials: &CredentialService,
        power: &Arc<PowerService>,
    ) -> AppResult<Option<OperationId>> {
        let views = self.inventory.list_instances(None).await?;
        let instances = resolve(&action.target, &views);
        if instances.is_empty() {
            return Ok(None);
        }
        // Sem credencial utilizável nada é enviado ao Railway.
        credentials.active().await?;
        let planned = power
            .plan(action.kind, &PowerTarget::Instances(instances))
            .await?;
        let operation = power
            .execute_scheduled_action(planned.plan.id, action.id, &action.label)
            .await?;
        Ok(Some(operation))
    }
}
