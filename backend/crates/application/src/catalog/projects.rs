//! Projetos gerenciados: descoberta, cadastro, importação, edição, sincronização e
//! remoção local. Nada aqui cria ou exclui projetos no Railway.

use std::collections::HashSet;
use std::sync::Arc;

use domain::catalog::{Project, SyncStatus};
use domain::credential::CredentialKind;
use domain::ids::{ProjectId, RailwayProjectId};
use serde::Serialize;

use crate::credentials::{ActiveCredential, CredentialService};
use crate::error::{AppError, AppResult};
use crate::inventory::{ImportFailure, InventoryService, RefreshReport};
use crate::ports::{Clock, InventoryRepository, ProjectRepository, RepoError};
use crate::railway::{RailwayGateway, RailwayProject, WorkspaceInfo};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DiscoveredProject {
    pub project: RailwayProject,
    pub managed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DiscoveredWorkspace {
    /// `None` para projetos sem workspace identificado.
    pub workspace: Option<WorkspaceInfo>,
    pub projects: Vec<DiscoveredProject>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct ProjectImportReport {
    pub imported: Vec<Project>,
    pub already_managed: Vec<String>,
    pub failed: Vec<ImportFailure>,
}

pub struct ProjectService {
    projects: Arc<dyn ProjectRepository>,
    inventory_repo: Arc<dyn InventoryRepository>,
    inventory: Arc<InventoryService>,
    credentials: Arc<CredentialService>,
    railway: Arc<dyn RailwayGateway>,
    clock: Arc<dyn Clock>,
}

impl ProjectService {
    pub fn new(
        projects: Arc<dyn ProjectRepository>,
        inventory_repo: Arc<dyn InventoryRepository>,
        inventory: Arc<InventoryService>,
        credentials: Arc<CredentialService>,
        railway: Arc<dyn RailwayGateway>,
        clock: Arc<dyn Clock>,
    ) -> Self {
        Self {
            projects,
            inventory_repo,
            inventory,
            credentials,
            railway,
            clock,
        }
    }

    pub async fn list(&self) -> AppResult<Vec<Project>> {
        Ok(self.projects.list().await?)
    }

    pub async fn get(&self, id: ProjectId) -> AppResult<Project> {
        self.projects
            .get(id)
            .await?
            .ok_or_else(|| AppError::NotFound("projeto não encontrado".into()))
    }

    /// Projetos acessíveis pelo token (todas as páginas; com token de conta, todos os
    /// workspaces), agrupados por workspace e marcando os já gerenciados.
    pub async fn discover(&self) -> AppResult<Vec<DiscoveredWorkspace>> {
        let cred = self.credentials.active().await?;
        let managed: HashSet<RailwayProjectId> = self
            .projects
            .list()
            .await?
            .into_iter()
            .map(|p| p.railway_project_id)
            .collect();
        let mark = |projects: Vec<RailwayProject>| {
            let mut out: Vec<_> = projects
                .into_iter()
                .map(|p| DiscoveredProject {
                    managed: managed.contains(&p.id),
                    project: p,
                })
                .collect();
            out.sort_by_key(|p| p.project.name.to_lowercase());
            out
        };

        let workspaces = match cred.metadata.kind {
            CredentialKind::Account => {
                let me = self
                    .credentials
                    .check(&cred, self.railway.me(&cred.token).await)
                    .await?;
                me.workspaces
            }
            CredentialKind::Workspace => {
                let id = cred.metadata.workspace_id.clone().ok_or_else(|| {
                    AppError::Internal("credencial de workspace sem workspace".into())
                })?;
                vec![WorkspaceInfo {
                    id,
                    name: cred.metadata.label.clone(),
                }]
            }
        };

        let mut groups = Vec::with_capacity(workspaces.len());
        for workspace in workspaces {
            let result = self
                .railway
                .list_projects(&cred.token, Some(&workspace.id))
                .await;
            let projects = self.credentials.check(&cred, result).await?;
            groups.push(DiscoveredWorkspace {
                workspace: Some(workspace),
                projects: mark(projects),
            });
        }
        Ok(groups)
    }

    /// Cadastro manual por Railway Project ID; nome/descrição vêm do Railway.
    pub async fn register(
        &self,
        railway_id: &str,
        display_name: Option<&str>,
    ) -> AppResult<Project> {
        let railway_id =
            RailwayProjectId::parse(railway_id).map_err(|e| AppError::Validation(e.to_string()))?;
        if self
            .projects
            .find_by_railway_id(&railway_id)
            .await?
            .is_some()
        {
            return Err(AppError::Conflict(format!(
                "o projeto {railway_id} já está cadastrado"
            )));
        }
        let cred = self.credentials.active().await?;
        let mut project = self.create(&cred, &railway_id).await?;
        if display_name.is_some() {
            project
                .edit(display_name, project.description.clone().as_deref())
                .map_err(|e| AppError::Validation(e.to_string()))?;
            self.projects.update(&project).await?;
        }
        Ok(project)
    }

    async fn create(
        &self,
        cred: &ActiveCredential,
        railway_id: &RailwayProjectId,
    ) -> AppResult<Project> {
        let result = self.railway.get_project(&cred.token, railway_id).await;
        let detail = self.credentials.check(cred, result).await?.ok_or_else(|| {
            AppError::Unprocessable(format!(
                "projeto {railway_id} não encontrado no Railway ou sem acesso pelo token"
            ))
        })?;
        let mut project = Project::new(
            cred.metadata.id,
            railway_id.clone(),
            &detail.project.name,
            detail.project.description.as_deref(),
            self.clock.now(),
        )
        .map_err(|e| AppError::Unprocessable(e.to_string()))?;
        self.projects.insert(&project).await.map_err(|e| match e {
            RepoError::Conflict(_) => {
                AppError::Conflict(format!("o projeto {railway_id} já está cadastrado"))
            }
            other => other.into(),
        })?;
        project.sync_status = SyncStatus::Ok;
        project.last_synced_at = Some(self.clock.now());
        self.projects.update(&project).await?;
        Ok(project)
    }

    /// Importa vários projetos; os já existentes são reportados, não duplicados.
    pub async fn import(&self, railway_ids: &[String]) -> AppResult<ProjectImportReport> {
        let cred = self.credentials.active().await?;
        let mut report = ProjectImportReport::default();
        for raw in railway_ids {
            let railway_id = match RailwayProjectId::parse(raw) {
                Ok(id) => id,
                Err(err) => {
                    report.failed.push(ImportFailure {
                        id: raw.clone(),
                        reason: err.to_string(),
                    });
                    continue;
                }
            };
            if self
                .projects
                .find_by_railway_id(&railway_id)
                .await?
                .is_some()
            {
                report.already_managed.push(railway_id.to_string());
                continue;
            }
            match self.create(&cred, &railway_id).await {
                Ok(project) => report.imported.push(project),
                Err(AppError::Conflict(_)) => report.already_managed.push(railway_id.to_string()),
                Err(err @ (AppError::Unprocessable(_) | AppError::NotFound(_))) => {
                    report.failed.push(ImportFailure {
                        id: railway_id.to_string(),
                        reason: err.to_string(),
                    })
                }
                Err(err) => return Err(err),
            }
        }
        Ok(report)
    }

    /// Edição local apenas (nome de exibição e descrição).
    pub async fn edit(
        &self,
        id: ProjectId,
        display_name: Option<&str>,
        description: Option<&str>,
    ) -> AppResult<Project> {
        let mut project = self.get(id).await?;
        project
            .edit(display_name, description)
            .map_err(|e| AppError::Validation(e.to_string()))?;
        self.projects.update(&project).await?;
        Ok(project)
    }

    /// Remove do gerenciamento (cascata local; histórico preservado). Nada no Railway.
    pub async fn remove(&self, id: ProjectId) -> AppResult<()> {
        self.projects.delete(id).await.map_err(|e| match e {
            RepoError::NotFound => AppError::NotFound("projeto não encontrado".into()),
            RepoError::Conflict(_) => {
                AppError::Conflict("há operação em andamento no projeto; aguarde o término".into())
            }
            other => other.into(),
        })
    }

    /// Atualiza nome, descrição, ambientes, serviços e estados das instâncias.
    pub async fn sync(&self, id: ProjectId) -> AppResult<(Project, RefreshReport)> {
        let mut project = self.get(id).await?;
        let cred = self.credentials.active().await?;
        let now = self.clock.now();

        let result = self
            .railway
            .get_project(&cred.token, &project.railway_project_id)
            .await;
        let detail = match self.credentials.check(&cred, result).await {
            Ok(detail) => detail,
            Err(err) => {
                project.sync_status = SyncStatus::Failed;
                self.projects.update(&project).await?;
                let ids: Vec<_> = self
                    .inventory_repo
                    .list_instances(Some(id))
                    .await?
                    .into_iter()
                    .map(|v| v.instance.id)
                    .collect();
                self.inventory_repo
                    .record_sync_error(&ids, &err.to_string())
                    .await?;
                return Err(err);
            }
        };

        let Some(detail) = detail else {
            // Excluído no Railway: mantém os dados locais e sinaliza.
            project.sync_status = SyncStatus::NotFound;
            project.last_synced_at = Some(now);
            self.projects.update(&project).await?;
            return Ok((project, RefreshReport::default()));
        };

        project.name = detail.project.name.clone();
        project.description = detail.project.description.clone();
        for env in self.inventory_repo.list_environments(id).await? {
            if let Some(remote) = detail
                .environments
                .iter()
                .find(|e| e.id == env.railway_environment_id)
                && remote.name != env.name
            {
                self.inventory_repo
                    .rename_environment(env.id, &remote.name)
                    .await?;
            }
        }
        for service in self.inventory_repo.list_services(id).await? {
            if let Some(remote) = detail
                .services
                .iter()
                .find(|s| s.id == service.railway_service_id)
                && remote.name != service.name
            {
                self.inventory_repo
                    .rename_service(service.id, &remote.name)
                    .await?;
            }
        }

        let report = self.inventory.refresh_with(&cred, Some(id)).await?;
        project.sync_status = if report.failed > 0 {
            SyncStatus::Failed
        } else {
            SyncStatus::Ok
        };
        project.last_synced_at = Some(now);
        self.projects.update(&project).await?;
        Ok((project, report))
    }
}
