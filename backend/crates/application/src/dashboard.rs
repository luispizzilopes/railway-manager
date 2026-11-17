//! Visão geral: indicadores, projetos com instâncias por ambiente, frescor,
//! últimas operações e alertas de integração.

use std::sync::Arc;

use chrono::{DateTime, Utc};
use domain::catalog::{Environment, Project, SyncStatus};
use domain::credential::{CredentialMetadata, CredentialStatus};
use domain::deployment::DeploymentStatus;
use domain::ids::ServiceInstanceId;
use domain::operation::{ItemResult, Operation, OperationItem};
use domain::state::{Freshness, ObservedState, freshness};
use serde::Serialize;

use crate::credentials::CredentialService;
use crate::error::AppResult;
use crate::ports::{Clock, InventoryRepository, OperationRepository, ProjectRepository};
use crate::railway::{RailwayGateway, RateLimitStatus};
use crate::schedules::{NextAction, ScheduleService};

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Indicators {
    pub projects: usize,
    pub instances: usize,
    /// Inclui `sleeping`, que também é contado à parte.
    pub running: usize,
    pub sleeping: usize,
    pub stopped: usize,
    pub failed: usize,
    pub other: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct InstanceCard {
    pub id: ServiceInstanceId,
    pub service_name: String,
    pub state: ObservedState,
    pub freshness: Freshness,
    pub not_found: bool,
    pub last_observed_at: Option<DateTime<Utc>>,
    pub last_sync_error: Option<String>,
    pub latest_deployment_status: Option<DeploymentStatus>,
    pub busy: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EnvironmentGroup {
    pub environment: Environment,
    pub instances: Vec<InstanceCard>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProjectCard {
    pub project: Project,
    pub environments: Vec<EnvironmentGroup>,
    /// Próxima ação de agenda ativa do projeto.
    pub next_action: Option<NextAction>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct OperationSummary {
    pub operation: Operation,
    pub total: usize,
    pub succeeded: usize,
    pub failed: usize,
    pub skipped: usize,
    pub active: usize,
    pub projects: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AlertCode {
    NoCredential,
    CredentialInvalid,
    CredentialUndecipherable,
    RateLimited,
    ProjectNotFound,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Alert {
    pub code: AlertCode,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Dashboard {
    pub generated_at: DateTime<Utc>,
    pub integration_ready: bool,
    pub credential: Option<CredentialMetadata>,
    pub indicators: Indicators,
    pub projects: Vec<ProjectCard>,
    pub recent_operations: Vec<OperationSummary>,
    pub alerts: Vec<Alert>,
    pub rate_limit: RateLimitStatus,
}

pub struct DashboardService {
    projects: Arc<dyn ProjectRepository>,
    inventory: Arc<dyn InventoryRepository>,
    operations: Arc<dyn OperationRepository>,
    credentials: Arc<CredentialService>,
    railway: Arc<dyn RailwayGateway>,
    schedules: Arc<ScheduleService>,
    clock: Arc<dyn Clock>,
    stale_after: chrono::Duration,
}

fn summarize(operation: Operation, items: &[OperationItem]) -> OperationSummary {
    let count = |f: fn(ItemResult) -> bool| items.iter().filter(|i| f(i.result)).count();
    let mut projects: Vec<String> = items.iter().map(|i| i.label.project_name.clone()).collect();
    projects.sort();
    projects.dedup();
    OperationSummary {
        operation,
        total: items.len(),
        succeeded: count(|r| r == ItemResult::Succeeded),
        failed: count(ItemResult::is_failure),
        skipped: count(|r| r == ItemResult::Skipped),
        active: count(ItemResult::is_active),
        projects,
    }
}

impl DashboardService {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        projects: Arc<dyn ProjectRepository>,
        inventory: Arc<dyn InventoryRepository>,
        operations: Arc<dyn OperationRepository>,
        credentials: Arc<CredentialService>,
        railway: Arc<dyn RailwayGateway>,
        schedules: Arc<ScheduleService>,
        clock: Arc<dyn Clock>,
        stale_after: std::time::Duration,
    ) -> Self {
        Self {
            projects,
            inventory,
            operations,
            credentials,
            railway,
            schedules,
            clock,
            stale_after: chrono::Duration::from_std(stale_after)
                .unwrap_or(chrono::Duration::minutes(5)),
        }
    }

    pub async fn overview(&self) -> AppResult<Dashboard> {
        let now = self.clock.now();
        let credential = self.credentials.current().await?;
        let projects = self.projects.list().await?;
        let views = self.inventory.list_instances(None).await?;
        let busy: std::collections::HashSet<_> = self
            .operations
            .active_instance_ids()
            .await?
            .into_iter()
            .collect();
        let rate_limit = self.railway.rate_limit_status();

        let mut indicators = Indicators {
            projects: projects.len(),
            instances: views.len(),
            ..Default::default()
        };
        let mut next_actions = self.schedules.next_actions().await?;
        let mut cards: Vec<ProjectCard> = projects
            .iter()
            .map(|p| ProjectCard {
                project: p.clone(),
                environments: vec![],
                next_action: next_actions.remove(&p.id),
            })
            .collect();

        for v in &views {
            match v.instance.observed_state {
                ObservedState::Running => indicators.running += 1,
                ObservedState::Sleeping => {
                    indicators.running += 1;
                    indicators.sleeping += 1;
                }
                ObservedState::Stopped => indicators.stopped += 1,
                ObservedState::Failed => indicators.failed += 1,
                _ => indicators.other += 1,
            }
            let Some(card) = cards.iter_mut().find(|c| c.project.id == v.project.id) else {
                continue;
            };
            let group = match card
                .environments
                .iter_mut()
                .position(|g| g.environment.id == v.environment.id)
            {
                Some(i) => &mut card.environments[i],
                None => {
                    card.environments.push(EnvironmentGroup {
                        environment: v.environment.clone(),
                        instances: vec![],
                    });
                    card.environments.last_mut().expect("recém inserido")
                }
            };
            group.instances.push(InstanceCard {
                id: v.instance.id,
                service_name: v.service.name.clone(),
                state: v.instance.observed_state,
                freshness: freshness(
                    v.instance.last_observed_at,
                    v.instance.last_sync_error.is_some(),
                    now,
                    self.stale_after,
                ),
                not_found: v.instance.not_found,
                last_observed_at: v.instance.last_observed_at,
                last_sync_error: v.instance.last_sync_error.clone(),
                latest_deployment_status: v.instance.latest_deployment_status,
                busy: busy.contains(&v.instance.id),
            });
        }

        let mut alerts = Vec::new();
        match credential.as_ref().map(|c| c.status) {
            None => alerts.push(Alert {
                code: AlertCode::NoCredential,
                message: "Nenhum token do Railway configurado: cadastre um em Configurações.".into(),
            }),
            Some(CredentialStatus::Invalid) => alerts.push(Alert {
                code: AlertCode::CredentialInvalid,
                message: "O token do Railway foi recusado (revogado ou sem permissão). Cadastre um novo.".into(),
            }),
            Some(CredentialStatus::Undecipherable) => alerts.push(Alert {
                code: AlertCode::CredentialUndecipherable,
                message: "O token salvo não pode ser decifrado com a RM_MASTER_KEY atual. Cadastre-o novamente."
                    .into(),
            }),
            Some(CredentialStatus::Valid) => {}
        }
        if let Some(until) = rate_limit.paused_until {
            alerts.push(Alert {
                code: AlertCode::RateLimited,
                message: format!(
                    "Rate limit do Railway atingido; chamadas pausadas até {}.",
                    until.to_rfc3339()
                ),
            });
        }
        for p in projects
            .iter()
            .filter(|p| p.sync_status == SyncStatus::NotFound)
        {
            alerts.push(Alert {
                code: AlertCode::ProjectNotFound,
                message: format!(
                    "O projeto \"{}\" não foi encontrado no Railway.",
                    p.shown_name()
                ),
            });
        }

        let recent_operations = self
            .operations
            .recent(10)
            .await?
            .into_iter()
            .map(|(op, items)| summarize(op, &items))
            .collect();

        Ok(Dashboard {
            generated_at: now,
            integration_ready: credential.as_ref().is_some_and(|c| c.is_usable()),
            credential,
            indicators,
            projects: cards,
            recent_operations,
            alerts,
            rate_limit,
        })
    }
}
