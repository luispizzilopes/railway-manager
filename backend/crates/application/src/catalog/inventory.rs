//! Ambientes, serviços e instâncias: descoberta, importação, associação manual,
//! remoção local e sincronização de estados (agrupada por ambiente).

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;

use domain::catalog::{Environment, Project, Service, ServiceInstance};
use domain::ids::{
    ProjectId, RailwayEnvironmentId, RailwayServiceId, ServiceId, ServiceInstanceId,
};
use domain::state::{ObservedState, observe};
use serde::Serialize;

use crate::credentials::{ActiveCredential, CredentialService};
use crate::error::{AppError, AppResult};
use crate::ports::{
    Clock, InstanceObservation, InstanceView, InventoryRepository, ProjectRepository, RepoError,
};
use crate::railway::{
    RailwayEnvironment, RailwayGateway, RailwayProjectDetail, RailwayServiceInstance,
};

/// Instância encontrada no Railway, com indicação de já gerenciada.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DiscoveredInstance {
    pub service_id: RailwayServiceId,
    pub service_name: String,
    pub state: ObservedState,
    pub managed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DiscoveredEnvironment {
    pub environment: RailwayEnvironment,
    pub instances: Vec<DiscoveredInstance>,
}

/// Par serviço × ambiente a importar/associar (IDs Railway em texto).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstanceRef {
    pub environment_id: String,
    pub service_id: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct InstanceImportReport {
    pub imported: Vec<ServiceInstanceId>,
    pub already_managed: Vec<String>,
    pub failed: Vec<ImportFailure>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ImportFailure {
    pub id: String,
    pub reason: String,
}

/// Resultado de uma sincronização de estados.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct RefreshReport {
    pub refreshed: usize,
    pub not_found: usize,
    pub failed: usize,
}

pub struct InventoryService {
    projects: Arc<dyn ProjectRepository>,
    inventory: Arc<dyn InventoryRepository>,
    credentials: Arc<CredentialService>,
    railway: Arc<dyn RailwayGateway>,
    clock: Arc<dyn Clock>,
}

fn parse_env(id: &str) -> AppResult<RailwayEnvironmentId> {
    RailwayEnvironmentId::parse(id).map_err(|e| AppError::Validation(e.to_string()))
}

fn parse_service(id: &str) -> AppResult<RailwayServiceId> {
    RailwayServiceId::parse(id).map_err(|e| AppError::Validation(e.to_string()))
}

impl InventoryService {
    pub fn new(
        projects: Arc<dyn ProjectRepository>,
        inventory: Arc<dyn InventoryRepository>,
        credentials: Arc<CredentialService>,
        railway: Arc<dyn RailwayGateway>,
        clock: Arc<dyn Clock>,
    ) -> Self {
        Self {
            projects,
            inventory,
            credentials,
            railway,
            clock,
        }
    }

    async fn project(&self, id: ProjectId) -> AppResult<Project> {
        self.projects
            .get(id)
            .await?
            .ok_or_else(|| AppError::NotFound("projeto não encontrado".into()))
    }

    async fn detail(
        &self,
        cred: &ActiveCredential,
        project: &Project,
    ) -> AppResult<RailwayProjectDetail> {
        let result = self
            .railway
            .get_project(&cred.token, &project.railway_project_id)
            .await;
        self.credentials.check(cred, result).await?.ok_or_else(|| {
            AppError::NotFound(format!(
                "projeto {} não encontrado no Railway",
                project.railway_project_id
            ))
        })
    }

    pub async fn local_instances(
        &self,
        project: Option<ProjectId>,
    ) -> AppResult<Vec<InstanceView>> {
        Ok(self.inventory.list_instances(project).await?)
    }

    pub async fn local_environments(&self, project: ProjectId) -> AppResult<Vec<Environment>> {
        self.project(project).await?;
        Ok(self.inventory.list_environments(project).await?)
    }

    /// Ambientes e instâncias do projeto diretamente no Railway (efêmeros por último).
    pub async fn discover(&self, project_id: ProjectId) -> AppResult<Vec<DiscoveredEnvironment>> {
        let project = self.project(project_id).await?;
        let cred = self.credentials.active().await?;
        let detail = self.detail(&cred, &project).await?;

        let managed: HashSet<(RailwayEnvironmentId, RailwayServiceId)> = self
            .inventory
            .list_instances(Some(project_id))
            .await?
            .into_iter()
            .map(|v| {
                (
                    v.environment.railway_environment_id,
                    v.service.railway_service_id,
                )
            })
            .collect();

        let mut out = Vec::with_capacity(detail.environments.len());
        for env in detail.environments {
            let result = self
                .railway
                .list_service_instances(&cred.token, &env.id)
                .await;
            let instances = self
                .credentials
                .check(&cred, result)
                .await?
                .unwrap_or_default();
            out.push(DiscoveredEnvironment {
                instances: instances
                    .into_iter()
                    .filter(|i| !i.snapshot.deleted)
                    .map(|i| DiscoveredInstance {
                        managed: managed.contains(&(env.id.clone(), i.service_id.clone())),
                        state: observe(Some(&i.snapshot)).state,
                        service_id: i.service_id,
                        service_name: i.service_name,
                    })
                    .collect(),
                environment: env,
            });
        }
        out.sort_by_key(|e| {
            (
                e.environment.is_ephemeral,
                e.environment.name.to_lowercase(),
            )
        });
        Ok(out)
    }

    /// Importa instâncias selecionadas (validadas no Railway) e sincroniza seus estados.
    pub async fn import(
        &self,
        project_id: ProjectId,
        refs: &[InstanceRef],
    ) -> AppResult<InstanceImportReport> {
        let project = self.project(project_id).await?;
        let cred = self.credentials.active().await?;
        let detail = self.detail(&cred, &project).await?;
        let mut report = InstanceImportReport::default();

        for r in refs {
            let label = format!("{}@{}", r.service_id, r.environment_id);
            match self.associate_with(&project, &detail, r).await {
                Ok(id) => report.imported.push(id),
                Err(AppError::Conflict(_)) => report.already_managed.push(label),
                Err(err @ (AppError::Validation(_) | AppError::Unprocessable(_))) => {
                    report.failed.push(ImportFailure {
                        id: label,
                        reason: err.to_string(),
                    })
                }
                Err(err) => return Err(err),
            }
        }
        if !report.imported.is_empty() {
            self.refresh_with(&cred, Some(project_id)).await?;
        }
        Ok(report)
    }

    /// Associação manual: valida pertencimento ao projeto no Railway; duplicata → 409.
    pub async fn associate(
        &self,
        project_id: ProjectId,
        r: &InstanceRef,
    ) -> AppResult<InstanceView> {
        let project = self.project(project_id).await?;
        let cred = self.credentials.active().await?;
        let detail = self.detail(&cred, &project).await?;
        let id = self.associate_with(&project, &detail, r).await?;
        self.refresh_with(&cred, Some(project_id)).await?;
        self.inventory
            .get_instance(id)
            .await?
            .ok_or_else(|| AppError::Internal("instância sumiu".into()))
    }

    async fn associate_with(
        &self,
        project: &Project,
        detail: &RailwayProjectDetail,
        r: &InstanceRef,
    ) -> AppResult<ServiceInstanceId> {
        let env_id = parse_env(&r.environment_id)?;
        let service_id = parse_service(&r.service_id)?;
        let railway_env = detail
            .environments
            .iter()
            .find(|e| e.id == env_id)
            .ok_or_else(|| {
                AppError::Unprocessable(format!("o ambiente {env_id} não pertence ao projeto"))
            })?;
        let railway_service = detail
            .services
            .iter()
            .find(|s| s.id == service_id)
            .ok_or_else(|| {
                AppError::Unprocessable(format!("o serviço {service_id} não pertence ao projeto"))
            })?;

        let env = Environment::new(
            project.id,
            env_id,
            &railway_env.name,
            railway_env.is_ephemeral,
        )
        .map_err(|e| AppError::Unprocessable(e.to_string()))?;
        let env = self.inventory.upsert_environment(&env).await?;
        let service = Service::new(project.id, service_id, &railway_service.name)
            .map_err(|e| AppError::Unprocessable(e.to_string()))?;
        let service = self.inventory.upsert_service(&service).await?;
        let instance = ServiceInstance::new(&service, &env)
            .map_err(|e| AppError::Unprocessable(e.to_string()))?;
        self.inventory.insert_instance(&instance).await?;
        Ok(instance.id)
    }

    pub async fn remove_instance(&self, id: ServiceInstanceId) -> AppResult<()> {
        self.inventory
            .delete_instance(id)
            .await
            .map_err(|e| match e {
                RepoError::NotFound => AppError::NotFound("instância não encontrada".into()),
                other => other.into(),
            })
    }

    pub async fn remove_service(&self, id: ServiceId) -> AppResult<()> {
        self.inventory
            .delete_service(id)
            .await
            .map_err(|e| match e {
                RepoError::NotFound => AppError::NotFound("serviço não encontrado".into()),
                other => other.into(),
            })
    }

    /// Relê os estados das instâncias gerenciadas (uma chamada por ambiente).
    pub async fn refresh(&self, project: Option<ProjectId>) -> AppResult<RefreshReport> {
        let cred = self.credentials.active().await?;
        self.refresh_with(&cred, project).await
    }

    pub(crate) async fn refresh_with(
        &self,
        cred: &ActiveCredential,
        project: Option<ProjectId>,
    ) -> AppResult<RefreshReport> {
        let views = self.inventory.list_instances(project).await?;
        self.refresh_views(cred, &views).await
    }

    /// Atualiza as instâncias dadas a partir de leituras agrupadas por ambiente.
    /// Falha de autenticação interrompe; indisponibilidade marca as instâncias e segue.
    pub async fn refresh_views(
        &self,
        cred: &ActiveCredential,
        views: &[InstanceView],
    ) -> AppResult<RefreshReport> {
        let mut by_env: BTreeMap<RailwayEnvironmentId, Vec<&InstanceView>> = BTreeMap::new();
        for v in views {
            by_env
                .entry(v.environment.railway_environment_id.clone())
                .or_default()
                .push(v);
        }
        let mut report = RefreshReport::default();
        for (env, group) in by_env {
            let result = self.railway.list_service_instances(&cred.token, &env).await;
            match self.credentials.check(cred, result).await {
                Ok(found) => {
                    let found: HashMap<RailwayServiceId, RailwayServiceInstance> = found
                        .unwrap_or_default()
                        .into_iter()
                        .map(|i| (i.service_id.clone(), i))
                        .collect();
                    for v in group {
                        let snapshot = found
                            .get(&v.service.railway_service_id)
                            .map(|i| &i.snapshot);
                        let observation = observation(snapshot, self.clock.now());
                        if observation.not_found {
                            report.not_found += 1;
                        }
                        self.inventory
                            .record_observation(v.instance.id, &observation)
                            .await?;
                        report.refreshed += 1;
                    }
                }
                Err(AppError::CredentialInvalid) => {
                    let ids: Vec<_> = group.iter().map(|v| v.instance.id).collect();
                    self.inventory
                        .record_sync_error(&ids, "token do Railway inválido")
                        .await?;
                    return Err(AppError::CredentialInvalid);
                }
                Err(err) => {
                    let ids: Vec<_> = group.iter().map(|v| v.instance.id).collect();
                    self.inventory
                        .record_sync_error(&ids, &err.to_string())
                        .await?;
                    report.failed += ids.len();
                }
            }
        }
        Ok(report)
    }
}

/// Converte uma leitura do Railway no registro de observação local.
pub fn observation(
    snapshot: Option<&domain::state::InstanceSnapshot>,
    now: chrono::DateTime<chrono::Utc>,
) -> InstanceObservation {
    let o = observe(snapshot);
    let latest = snapshot.and_then(|s| s.latest.as_ref());
    InstanceObservation {
        state: o.state,
        not_found: o.not_found,
        latest_deployment_id: latest.map(|d| d.id.clone()),
        latest_deployment_status: latest.map(|d| d.status),
        observed_at: now,
    }
}
