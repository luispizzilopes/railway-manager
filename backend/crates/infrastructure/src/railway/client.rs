//! Implementação de `RailwayGateway`: paginação das conexões e mapeamento dos tipos
//! gerados por `graphql_client` para o domínio.

use application::railway::{
    AccountInfo, RailwayEnvironment, RailwayError, RailwayGateway, RailwayProject,
    RailwayProjectDetail, RailwayResult, RailwayService, RailwayServiceInstance, RailwayToken,
    RateLimitStatus, WorkspaceInfo,
};
use async_trait::async_trait;
use domain::deployment::{Deployment, DeploymentStatus};
use domain::ids::{
    RailwayDeploymentId, RailwayEnvironmentId, RailwayProjectId, RailwayServiceId,
    RailwayWorkspaceId,
};
use domain::power::{DeploymentRecord, StopMechanism, restart_source};
use domain::state::InstanceSnapshot;

use super::ops;
use super::transport::Transport;

/// Itens por página nas conexões do Railway.
const PAGE_SIZE: i64 = 50;
/// Deployments do histórico consultados para escolher de onde reiniciar.
const HISTORY_SIZE: i64 = 50;
/// Deployments consultados para saber se uma falha "mais recente" é antiga.
const STALE_CHECK_SIZE: i64 = 10;
/// Proteção contra cursores que nunca terminam.
const MAX_PAGES: usize = 200;

#[derive(Clone)]
pub struct RailwayClient {
    transport: Transport,
}

impl RailwayClient {
    pub fn new(transport: Transport) -> Self {
        Self { transport }
    }

    /// Histórico de deployments do serviço no ambiente (inclui `REMOVED`), do mais novo
    /// para o mais antigo segundo a API, com data de criação e se é um `redeploy`.
    async fn history(
        &self,
        token: &RailwayToken,
        environment: &RailwayEnvironmentId,
        service: &RailwayServiceId,
        first: i64,
    ) -> RailwayResult<Vec<DeploymentRecord>> {
        let vars = ops::deployments::Variables {
            input: ops::deployments::DeploymentListInput {
                environment_id: Some(environment.to_string()),
                service_id: Some(service.to_string()),
                project_id: None,
                status: None,
                include_deleted: None,
            },
            first,
        };
        let data = self
            .transport
            .execute::<ops::Deployments>(token, vars)
            .await?;
        data.deployments
            .edges
            .into_iter()
            .map(|e| {
                let node = e.node;
                let created_at = chrono::DateTime::parse_from_rfc3339(&node.created_at)
                    .ok()
                    .map(|d| d.to_utc());
                let is_redeploy = node
                    .meta
                    .as_ref()
                    .and_then(|m| m.get("reason"))
                    .and_then(|r| r.as_str())
                    == Some("redeploy");
                Ok(DeploymentRecord {
                    deployment: deployment_from_list(node.deployment_fields)?,
                    created_at,
                    is_redeploy,
                })
            })
            .collect()
    }

    /// `latestDeployment` omite os `REMOVED` e pode apontar para uma falha antiga.
    /// Sem deployment ativo e com uma falha como "mais recente", confere o histórico:
    /// se existir deployment mais novo que a falha (ex.: o que acabou de ser
    /// desligado), ele passa a ser o mais recente e a instância aparece desligada.
    async fn correct_stale_failure(
        &self,
        token: &RailwayToken,
        mut instance: RailwayServiceInstance,
    ) -> RailwayResult<RailwayServiceInstance> {
        let snapshot = &instance.snapshot;
        let Some(latest) = snapshot.latest.as_ref() else {
            return Ok(instance);
        };
        if snapshot.deleted || !snapshot.active.is_empty() || !latest.status.is_failure() {
            return Ok(instance);
        }
        let history = self
            .history(
                token,
                &instance.environment_id,
                &instance.service_id,
                STALE_CHECK_SIZE,
            )
            .await?;
        let failure_at = history
            .iter()
            .find(|r| r.deployment.id == latest.id)
            .and_then(|r| r.created_at);
        let newest = history
            .iter()
            .enumerate()
            .max_by_key(|(index, r)| (r.created_at, std::cmp::Reverse(*index)))
            .map(|(_, r)| r);
        if let Some(newest) = newest
            && newest.deployment.id != latest.id
            && (failure_at.is_none() || newest.created_at > failure_at)
        {
            instance.snapshot.latest = Some(newest.deployment.clone());
        }
        Ok(instance)
    }
}

fn parse_id<T>(
    value: &str,
    parse: fn(&str) -> Result<T, domain::ids::InvalidId>,
) -> RailwayResult<T> {
    parse(value).map_err(|e| RailwayError::Unknown(format!("ID inesperado do Railway: {e}")))
}

/// `NotFound` vira `None`: o recurso deixou de existir ou não é acessível.
fn optional<T>(result: RailwayResult<T>) -> RailwayResult<Option<T>> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(RailwayError::NotFound(_)) => Ok(None),
        Err(err) => Err(err),
    }
}

/// Percorre todas as páginas de uma conexão.
async fn paginate<T, F, Fut>(mut fetch: F) -> RailwayResult<Vec<T>>
where
    F: FnMut(Option<String>) -> Fut,
    Fut: Future<Output = RailwayResult<(Vec<T>, bool, Option<String>)>>,
{
    let mut items = Vec::new();
    let mut after = None;
    for _ in 0..MAX_PAGES {
        let (page, has_next, cursor) = fetch(after.take()).await?;
        items.extend(page);
        match (has_next, cursor) {
            (true, Some(cursor)) => after = Some(cursor),
            _ => return Ok(items),
        }
    }
    Err(RailwayError::Unknown(
        "paginação excedeu o limite de páginas".into(),
    ))
}

/// Gera o mapeamento do fragmento `DeploymentFields` de um módulo gerado.
macro_rules! deployment_mapper {
    ($fn:ident, $module:ident) => {
        fn $fn(d: ops::$module::DeploymentFields) -> RailwayResult<Deployment> {
            use ops::$module::DeploymentStatus as S;
            let status = match d.status {
                S::BUILDING => DeploymentStatus::Building,
                S::CRASHED => DeploymentStatus::Crashed,
                S::DEPLOYING => DeploymentStatus::Deploying,
                S::FAILED => DeploymentStatus::Failed,
                S::INITIALIZING => DeploymentStatus::Initializing,
                S::NEEDS_APPROVAL => DeploymentStatus::NeedsApproval,
                S::QUEUED => DeploymentStatus::Queued,
                S::REMOVED => DeploymentStatus::Removed,
                S::REMOVING => DeploymentStatus::Removing,
                S::SKIPPED => DeploymentStatus::Skipped,
                S::SLEEPING => DeploymentStatus::Sleeping,
                S::SUCCESS => DeploymentStatus::Success,
                S::WAITING => DeploymentStatus::Waiting,
                S::Other(other) => {
                    return Err(RailwayError::Unknown(format!(
                        "status de deployment desconhecido: {other}"
                    )));
                }
            };
            Ok(Deployment {
                id: parse_id(&d.id, RailwayDeploymentId::parse)?,
                status,
                can_redeploy: d.can_redeploy,
                stopped: d.deployment_stopped,
            })
        }
    };
}

/// Gera o mapeamento do fragmento `InstanceFields` de um módulo gerado.
macro_rules! instance_mapper {
    ($fn:ident, $module:ident, $deployment:ident) => {
        fn $fn(i: ops::$module::InstanceFields) -> RailwayResult<RailwayServiceInstance> {
            Ok(RailwayServiceInstance {
                service_id: parse_id(&i.service_id, RailwayServiceId::parse)?,
                service_name: i.service_name,
                environment_id: parse_id(&i.environment_id, RailwayEnvironmentId::parse)?,
                snapshot: InstanceSnapshot {
                    deleted: i.deleted_at.is_some(),
                    latest: i.latest_deployment.map($deployment).transpose()?,
                    active: i
                        .active_deployments
                        .into_iter()
                        .map($deployment)
                        .collect::<RailwayResult<_>>()?,
                },
            })
        }
    };
}

deployment_mapper!(deployment_from_env, environment_instances);
deployment_mapper!(deployment_from_instance, service_instance);
deployment_mapper!(deployment_from_query, deployment);
deployment_mapper!(deployment_from_redeploy, deployment_redeploy);
deployment_mapper!(deployment_from_list, deployments);
instance_mapper!(
    instance_from_env,
    environment_instances,
    deployment_from_env
);
instance_mapper!(
    instance_from_query,
    service_instance,
    deployment_from_instance
);

#[async_trait]
impl RailwayGateway for RailwayClient {
    async fn me(&self, token: &RailwayToken) -> RailwayResult<AccountInfo> {
        let data = self
            .transport
            .execute::<ops::Me>(token, ops::me::Variables)
            .await?;
        let workspaces = data
            .me
            .workspaces
            .into_iter()
            .map(|w| {
                Ok(WorkspaceInfo {
                    id: parse_id(&w.id, RailwayWorkspaceId::parse)?,
                    name: w.name,
                })
            })
            .collect::<RailwayResult<_>>()?;
        Ok(AccountInfo {
            name: data.me.name,
            email: data.me.email,
            workspaces,
        })
    }

    async fn workspace(
        &self,
        token: &RailwayToken,
        id: &RailwayWorkspaceId,
    ) -> RailwayResult<WorkspaceInfo> {
        let vars = ops::workspace::Variables {
            workspace_id: id.to_string(),
        };
        let data = self
            .transport
            .execute::<ops::Workspace>(token, vars)
            .await?;
        Ok(WorkspaceInfo {
            id: parse_id(&data.workspace.id, RailwayWorkspaceId::parse)?,
            name: data.workspace.name,
        })
    }

    async fn list_projects(
        &self,
        token: &RailwayToken,
        workspace: Option<&RailwayWorkspaceId>,
    ) -> RailwayResult<Vec<RailwayProject>> {
        let workspace_id = workspace.map(ToString::to_string);
        paginate(|after| {
            let vars = ops::projects::Variables {
                workspace_id: workspace_id.clone(),
                first: PAGE_SIZE,
                after,
            };
            async move {
                let conn = self
                    .transport
                    .execute::<ops::Projects>(token, vars)
                    .await?
                    .projects;
                let page = conn
                    .edges
                    .into_iter()
                    .map(|e| e.node)
                    .filter(|p| p.deleted_at.is_none())
                    .map(|p| {
                        Ok(RailwayProject {
                            id: parse_id(&p.id, RailwayProjectId::parse)?,
                            name: p.name,
                            description: p.description,
                            workspace_id: p
                                .workspace_id
                                .as_deref()
                                .map(|w| parse_id(w, RailwayWorkspaceId::parse))
                                .transpose()?,
                        })
                    })
                    .collect::<RailwayResult<Vec<_>>>()?;
                Ok((
                    page,
                    conn.page_info.has_next_page,
                    conn.page_info.end_cursor,
                ))
            }
        })
        .await
    }

    async fn get_project(
        &self,
        token: &RailwayToken,
        id: &RailwayProjectId,
    ) -> RailwayResult<Option<RailwayProjectDetail>> {
        let vars = ops::project::Variables { id: id.to_string() };
        let Some(data) = optional(self.transport.execute::<ops::Project>(token, vars).await)?
        else {
            return Ok(None);
        };
        let p = data.project;
        if p.deleted_at.is_some() {
            return Ok(None);
        }
        let project = RailwayProject {
            id: parse_id(&p.id, RailwayProjectId::parse)?,
            name: p.name,
            description: p.description,
            workspace_id: p
                .workspace_id
                .as_deref()
                .map(|w| parse_id(w, RailwayWorkspaceId::parse))
                .transpose()?,
        };

        let environments = paginate(|after| {
            let vars = ops::project_environments::Variables {
                id: id.to_string(),
                first: PAGE_SIZE,
                after,
            };
            async move {
                let conn = self
                    .transport
                    .execute::<ops::ProjectEnvironments>(token, vars)
                    .await?
                    .project
                    .environments;
                let page = conn
                    .edges
                    .into_iter()
                    .map(|e| e.node)
                    .filter(|e| e.deleted_at.is_none())
                    .map(|e| {
                        Ok(RailwayEnvironment {
                            id: parse_id(&e.id, RailwayEnvironmentId::parse)?,
                            name: e.name,
                            is_ephemeral: e.is_ephemeral,
                        })
                    })
                    .collect::<RailwayResult<Vec<_>>>()?;
                Ok((
                    page,
                    conn.page_info.has_next_page,
                    conn.page_info.end_cursor,
                ))
            }
        })
        .await?;

        let services = paginate(|after| {
            let vars = ops::project_services::Variables {
                id: id.to_string(),
                first: PAGE_SIZE,
                after,
            };
            async move {
                let conn = self
                    .transport
                    .execute::<ops::ProjectServices>(token, vars)
                    .await?
                    .project
                    .services;
                let page = conn
                    .edges
                    .into_iter()
                    .map(|e| e.node)
                    .filter(|s| s.deleted_at.is_none())
                    .map(|s| {
                        Ok(RailwayService {
                            id: parse_id(&s.id, RailwayServiceId::parse)?,
                            name: s.name,
                        })
                    })
                    .collect::<RailwayResult<Vec<_>>>()?;
                Ok((
                    page,
                    conn.page_info.has_next_page,
                    conn.page_info.end_cursor,
                ))
            }
        })
        .await?;

        Ok(Some(RailwayProjectDetail {
            project,
            environments,
            services,
        }))
    }

    async fn list_service_instances(
        &self,
        token: &RailwayToken,
        environment: &RailwayEnvironmentId,
    ) -> RailwayResult<Option<Vec<RailwayServiceInstance>>> {
        let result = paginate(|after| {
            let vars = ops::environment_instances::Variables {
                id: environment.to_string(),
                first: PAGE_SIZE,
                after,
            };
            async move {
                let env = self
                    .transport
                    .execute::<ops::EnvironmentInstances>(token, vars)
                    .await?
                    .environment;
                if env.deleted_at.is_some() {
                    return Err(RailwayError::NotFound(format!("ambiente {}", env.id)));
                }
                let conn = env.service_instances;
                let page = conn
                    .edges
                    .into_iter()
                    .map(|e| instance_from_env(e.node))
                    .collect::<RailwayResult<Vec<_>>>()?;
                Ok((
                    page,
                    conn.page_info.has_next_page,
                    conn.page_info.end_cursor,
                ))
            }
        })
        .await;
        let Some(instances) = optional(result)? else {
            return Ok(None);
        };
        let mut corrected = Vec::with_capacity(instances.len());
        for instance in instances {
            corrected.push(self.correct_stale_failure(token, instance).await?);
        }
        Ok(Some(corrected))
    }

    async fn get_service_instance(
        &self,
        token: &RailwayToken,
        environment: &RailwayEnvironmentId,
        service: &RailwayServiceId,
    ) -> RailwayResult<Option<RailwayServiceInstance>> {
        let vars = ops::service_instance::Variables {
            environment_id: environment.to_string(),
            service_id: service.to_string(),
        };
        let instance = optional(
            self.transport
                .execute::<ops::ServiceInstance>(token, vars)
                .await,
        )?
        .map(|data| instance_from_query(data.service_instance))
        .transpose()?;
        match instance {
            Some(instance) => Ok(Some(self.correct_stale_failure(token, instance).await?)),
            None => Ok(None),
        }
    }

    async fn restart_source(
        &self,
        token: &RailwayToken,
        environment: &RailwayEnvironmentId,
        service: &RailwayServiceId,
    ) -> RailwayResult<Option<Deployment>> {
        let history = self
            .history(token, environment, service, HISTORY_SIZE)
            .await?;
        let chosen = restart_source(&history);
        // Verificação pela data: compara com a escolha feita só pela ordem da API.
        let undated: Vec<_> = history
            .iter()
            .map(|r| DeploymentRecord {
                created_at: None,
                ..r.clone()
            })
            .collect();
        let by_api_order = restart_source(&undated).map(|r| &r.deployment.id);
        if let (Some(c), Some(api)) = (chosen, by_api_order)
            && &c.deployment.id != api
        {
            tracing::warn!(
                chosen = %c.deployment.id,
                api_order = %api,
                "ordem da API divergiu da data de criação; usando o mais recente pela data"
            );
        }
        Ok(chosen.map(|r| r.deployment.clone()))
    }

    async fn get_deployment(
        &self,
        token: &RailwayToken,
        id: &RailwayDeploymentId,
    ) -> RailwayResult<Option<Deployment>> {
        let vars = ops::deployment::Variables { id: id.to_string() };
        optional(self.transport.execute::<ops::Deployment>(token, vars).await)?
            .map(|data| deployment_from_query(data.deployment))
            .transpose()
    }

    async fn stop_deployment(
        &self,
        token: &RailwayToken,
        id: &RailwayDeploymentId,
        mechanism: StopMechanism,
    ) -> RailwayResult<()> {
        let accepted = match mechanism {
            StopMechanism::Remove => {
                let vars = ops::deployment_remove::Variables { id: id.to_string() };
                self.transport
                    .execute::<ops::DeploymentRemove>(token, vars)
                    .await?
                    .deployment_remove
            }
            StopMechanism::Stop => {
                let vars = ops::deployment_stop::Variables { id: id.to_string() };
                self.transport
                    .execute::<ops::DeploymentStop>(token, vars)
                    .await?
                    .deployment_stop
            }
        };
        if accepted {
            Ok(())
        } else {
            Err(RailwayError::Unknown(format!(
                "o Railway recusou desligar o deployment {id}"
            )))
        }
    }

    async fn redeploy_deployment(
        &self,
        token: &RailwayToken,
        id: &RailwayDeploymentId,
    ) -> RailwayResult<Deployment> {
        let vars = ops::deployment_redeploy::Variables { id: id.to_string() };
        let data = self
            .transport
            .execute::<ops::DeploymentRedeploy>(token, vars)
            .await?;
        deployment_from_redeploy(data.deployment_redeploy)
    }

    fn rate_limit_status(&self) -> RateLimitStatus {
        self.transport.rate_limit_status()
    }
}
