//! Deployments do Railway como vistos pelo domínio.

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};

use crate::ids::RailwayDeploymentId;

/// Valores de `DeploymentStatus` no schema do Railway (a documentação omite alguns).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DeploymentStatus {
    Building,
    Crashed,
    Deploying,
    Failed,
    Initializing,
    NeedsApproval,
    Queued,
    Removed,
    Removing,
    Skipped,
    Sleeping,
    Success,
    Waiting,
}

impl DeploymentStatus {
    pub const ALL: [Self; 13] = [
        Self::Building,
        Self::Crashed,
        Self::Deploying,
        Self::Failed,
        Self::Initializing,
        Self::NeedsApproval,
        Self::Queued,
        Self::Removed,
        Self::Removing,
        Self::Skipped,
        Self::Sleeping,
        Self::Success,
        Self::Waiting,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Building => "BUILDING",
            Self::Crashed => "CRASHED",
            Self::Deploying => "DEPLOYING",
            Self::Failed => "FAILED",
            Self::Initializing => "INITIALIZING",
            Self::NeedsApproval => "NEEDS_APPROVAL",
            Self::Queued => "QUEUED",
            Self::Removed => "REMOVED",
            Self::Removing => "REMOVING",
            Self::Skipped => "SKIPPED",
            Self::Sleeping => "SLEEPING",
            Self::Success => "SUCCESS",
            Self::Waiting => "WAITING",
        }
    }

    /// Deployment ainda progredindo para um estado estável.
    pub fn is_transitioning(self) -> bool {
        matches!(
            self,
            Self::Queued
                | Self::Waiting
                | Self::Initializing
                | Self::Building
                | Self::Deploying
                | Self::Removing
        )
    }

    pub fn is_failure(self) -> bool {
        matches!(self, Self::Failed | Self::Crashed)
    }
}

impl fmt::Display for DeploymentStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("status de deployment desconhecido: '{0}'")]
pub struct UnknownDeploymentStatus(pub String);

impl FromStr for DeploymentStatus {
    type Err = UnknownDeploymentStatus;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::ALL
            .into_iter()
            .find(|status| status.as_str() == s)
            .ok_or_else(|| UnknownDeploymentStatus(s.to_owned()))
    }
}

/// Resumo de um deployment, com os campos que as regras de energia usam.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Deployment {
    pub id: RailwayDeploymentId,
    pub status: DeploymentStatus,
    /// `Deployment.canRedeploy`: a imagem ainda pode ser reaproveitada.
    pub can_redeploy: bool,
    /// `Deployment.deploymentStopped`: todas as instâncias pararam.
    pub stopped: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_de_todos_os_status() {
        for status in DeploymentStatus::ALL {
            assert_eq!(status.as_str().parse::<DeploymentStatus>().unwrap(), status);
        }
        assert!("PAUSED".parse::<DeploymentStatus>().is_err());
    }
}
