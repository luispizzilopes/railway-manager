//! Projetos, ambientes, serviços e instâncias (serviço × ambiente) gerenciados localmente.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::deployment::DeploymentStatus;
use crate::ids::{
    CredentialId, EnvironmentId, ProjectId, RailwayDeploymentId, RailwayEnvironmentId,
    RailwayProjectId, RailwayServiceId, ServiceId, ServiceInstanceId,
};
use crate::operation::str_enum;
use crate::state::ObservedState;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum InvalidEntity {
    #[error("{0} não pode ser vazio")]
    EmptyName(&'static str),
    #[error("{0} excede {1} caracteres")]
    TooLong(&'static str, usize),
    #[error("serviço e ambiente pertencem a projetos diferentes")]
    ProjectMismatch,
}

/// Normaliza um texto obrigatório (sem espaços nas pontas, não vazio, até `max` caracteres).
pub fn required_text(
    field: &'static str,
    value: &str,
    max: usize,
) -> Result<String, InvalidEntity> {
    let value = value.trim();
    if value.is_empty() {
        return Err(InvalidEntity::EmptyName(field));
    }
    optional_text(field, Some(value), max).map(|v| v.unwrap_or_default())
}

/// Texto opcional: vazio vira `None`.
pub fn optional_text(
    field: &'static str,
    value: Option<&str>,
    max: usize,
) -> Result<Option<String>, InvalidEntity> {
    match value.map(str::trim).filter(|v| !v.is_empty()) {
        Some(v) if v.chars().count() > max => Err(InvalidEntity::TooLong(field, max)),
        other => Ok(other.map(str::to_owned)),
    }
}

pub const NAME_MAX: usize = 200;
pub const DESCRIPTION_MAX: usize = 2000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncStatus {
    Never,
    Ok,
    Failed,
    NotFound,
}

str_enum!(SyncStatus { Never => "never", Ok => "ok", Failed => "failed", NotFound => "not_found" });

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Project {
    pub id: ProjectId,
    /// Credencial usada para acessar o projeto; `None` após a remoção do token.
    pub credential_id: Option<CredentialId>,
    pub railway_project_id: RailwayProjectId,
    /// Nome no Railway.
    pub name: String,
    /// Nome local opcional, sobrepõe `name` na interface.
    pub display_name: Option<String>,
    pub description: Option<String>,
    pub created_at: DateTime<Utc>,
    pub last_synced_at: Option<DateTime<Utc>>,
    pub sync_status: SyncStatus,
}

impl Project {
    pub fn new(
        credential_id: CredentialId,
        railway_project_id: RailwayProjectId,
        name: &str,
        description: Option<&str>,
        now: DateTime<Utc>,
    ) -> Result<Self, InvalidEntity> {
        Ok(Self {
            id: ProjectId::new(),
            credential_id: Some(credential_id),
            railway_project_id,
            name: required_text("nome do projeto", name, NAME_MAX)?,
            display_name: None,
            description: optional_text("descrição", description, DESCRIPTION_MAX)?,
            created_at: now,
            last_synced_at: None,
            sync_status: SyncStatus::Never,
        })
    }

    pub fn shown_name(&self) -> &str {
        self.display_name.as_deref().unwrap_or(&self.name)
    }

    /// Edição local: nunca altera o Railway Project ID.
    pub fn edit(
        &mut self,
        display_name: Option<&str>,
        description: Option<&str>,
    ) -> Result<(), InvalidEntity> {
        self.display_name = optional_text("nome de exibição", display_name, NAME_MAX)?;
        self.description = optional_text("descrição", description, DESCRIPTION_MAX)?;
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Environment {
    pub id: EnvironmentId,
    pub project_id: ProjectId,
    pub railway_environment_id: RailwayEnvironmentId,
    pub name: String,
    pub is_ephemeral: bool,
}

impl Environment {
    pub fn new(
        project_id: ProjectId,
        railway_environment_id: RailwayEnvironmentId,
        name: &str,
        is_ephemeral: bool,
    ) -> Result<Self, InvalidEntity> {
        Ok(Self {
            id: EnvironmentId::new(),
            project_id,
            railway_environment_id,
            name: required_text("nome do ambiente", name, NAME_MAX)?,
            is_ephemeral,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Service {
    pub id: ServiceId,
    pub project_id: ProjectId,
    pub railway_service_id: RailwayServiceId,
    pub name: String,
}

impl Service {
    pub fn new(
        project_id: ProjectId,
        railway_service_id: RailwayServiceId,
        name: &str,
    ) -> Result<Self, InvalidEntity> {
        Ok(Self {
            id: ServiceId::new(),
            project_id,
            railway_service_id,
            name: required_text("nome do serviço", name, NAME_MAX)?,
        })
    }
}

/// Um serviço em um ambiente, com o último estado observado.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServiceInstance {
    pub id: ServiceInstanceId,
    pub service_id: ServiceId,
    pub environment_id: EnvironmentId,
    pub observed_state: ObservedState,
    /// O Railway não retornou a instância na última leitura.
    pub not_found: bool,
    pub latest_deployment_id: Option<RailwayDeploymentId>,
    pub latest_deployment_status: Option<DeploymentStatus>,
    /// Última leitura bem-sucedida.
    pub last_observed_at: Option<DateTime<Utc>>,
    /// Erro da última tentativa; presente ⇒ frescor `unavailable`.
    pub last_sync_error: Option<String>,
}

impl ServiceInstance {
    pub fn new(service: &Service, environment: &Environment) -> Result<Self, InvalidEntity> {
        if service.project_id != environment.project_id {
            return Err(InvalidEntity::ProjectMismatch);
        }
        Ok(Self {
            id: ServiceInstanceId::new(),
            service_id: service.id,
            environment_id: environment.id,
            observed_state: ObservedState::Unknown,
            not_found: false,
            latest_deployment_id: None,
            latest_deployment_status: None,
            last_observed_at: None,
            last_sync_error: None,
        })
    }

    /// Elegível para operações: existe no Railway.
    pub fn is_operable(&self) -> bool {
        !self.not_found
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rid<T: std::str::FromStr>(n: u8) -> T
    where
        T::Err: std::fmt::Debug,
    {
        format!("00000000-0000-4000-8000-0000000000{n:02}")
            .parse()
            .unwrap()
    }

    #[test]
    fn projeto_novo_nunca_sincronizado() {
        let p = Project::new(
            CredentialId::new(),
            rid(1),
            "  loja ",
            Some(" "),
            Utc::now(),
        )
        .unwrap();
        assert_eq!(p.name, "loja");
        assert_eq!(p.description, None);
        assert_eq!(p.sync_status, SyncStatus::Never);
        assert!(p.last_synced_at.is_none());
    }

    #[test]
    fn nomes_invalidos() {
        assert_eq!(
            Project::new(CredentialId::new(), rid(1), " ", None, Utc::now()),
            Err(InvalidEntity::EmptyName("nome do projeto"))
        );
        let long = "x".repeat(NAME_MAX + 1);
        assert!(matches!(
            Service::new(ProjectId::new(), rid(2), &long),
            Err(InvalidEntity::TooLong(_, NAME_MAX))
        ));
        assert!(Environment::new(ProjectId::new(), rid(3), "", false).is_err());
    }

    #[test]
    fn edicao_local_preserva_id_railway() {
        let mut p = Project::new(CredentialId::new(), rid(1), "loja", None, Utc::now()).unwrap();
        let before = p.railway_project_id.clone();
        p.edit(Some("Loja (prod)"), Some("e-commerce")).unwrap();
        assert_eq!(p.shown_name(), "Loja (prod)");
        assert_eq!(p.description.as_deref(), Some("e-commerce"));
        assert_eq!(p.railway_project_id, before);
        p.edit(None, None).unwrap();
        assert_eq!(p.shown_name(), "loja");
    }

    #[test]
    fn instancia_exige_mesmo_projeto() {
        let project = ProjectId::new();
        let service = Service::new(project, rid(2), "api").unwrap();
        let prod = Environment::new(project, rid(3), "production", false).unwrap();
        let staging = Environment::new(project, rid(4), "staging", false).unwrap();
        let other = Environment::new(ProjectId::new(), rid(5), "production", false).unwrap();

        let a = ServiceInstance::new(&service, &prod).unwrap();
        let b = ServiceInstance::new(&service, &staging).unwrap();
        assert_ne!(a.id, b.id);
        assert_eq!(a.service_id, b.service_id);
        assert_eq!(a.observed_state, ObservedState::Unknown);
        assert_eq!(
            ServiceInstance::new(&service, &other),
            Err(InvalidEntity::ProjectMismatch)
        );
    }
}
