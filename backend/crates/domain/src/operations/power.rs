//! Regras de desligar/iniciar instâncias.

use std::fmt;
use std::str::FromStr;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::deployment::{Deployment, DeploymentStatus};
use crate::ids::RailwayDeploymentId;
use crate::state::{InstanceSnapshot, ObservedState, observe};

/// Mutation usada para desligar os deployments ativos de uma instância (ADR-003).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum StopMechanism {
    /// `deploymentRemove`: comportamento comprovado em produção pelo antigo `railway.sh`.
    #[default]
    Remove,
    /// `deploymentStop`: semântica de retorno ainda em avaliação.
    Stop,
}

impl FromStr for StopMechanism {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "remove" => Ok(Self::Remove),
            "stop" => Ok(Self::Stop),
            other => Err(format!("valor inválido '{other}': use 'remove' ou 'stop'")),
        }
    }
}

impl fmt::Display for StopMechanism {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Remove => "remove",
            Self::Stop => "stop",
        })
    }
}

/// Tipo de operação de energia.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PowerKind {
    Start,
    Stop,
}

impl PowerKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Start => "start",
            Self::Stop => "stop",
        }
    }

    /// Estado esperado ao final de uma operação bem-sucedida.
    pub fn desired_state(self) -> ObservedState {
        match self {
            Self::Start => ObservedState::Running,
            Self::Stop => ObservedState::Stopped,
        }
    }
}

impl FromStr for PowerKind {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "start" => Ok(Self::Start),
            "stop" => Ok(Self::Stop),
            other => Err(format!("tipo de operação inválido: '{other}'")),
        }
    }
}

/// Motivo para não agir sobre uma instância.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum SkipReason {
    AlreadyInDesiredState,
    Transitioning,
    AwaitingApproval,
    NotFound,
    UnknownState,
    OperationInProgress,
    /// O último deployment não é um deployment parado (ex.: `FAILED`) — não ressuscitamos.
    LatestNotStopped {
        status: Option<DeploymentStatus>,
    },
    /// Nenhum deployment pode ser reaproveitado (imagem fora da retenção, por exemplo).
    NoReusableDeployment,
}

impl SkipReason {
    /// Motivos que, na execução, fazem o item terminar `failed` em vez de `skipped`:
    /// o pedido não pode ser atendido sem uma ação que o sistema se recusa a fazer.
    pub fn is_failure(&self) -> bool {
        matches!(
            self,
            Self::LatestNotStopped { .. } | Self::NoReusableDeployment
        )
    }

    pub fn message(&self) -> String {
        match self {
            Self::AlreadyInDesiredState => "já está no estado desejado".into(),
            Self::Transitioning => "em transição".into(),
            Self::AwaitingApproval => "aguardando aprovação no Railway".into(),
            Self::NotFound => "não encontrado no Railway".into(),
            Self::UnknownState => "estado desconhecido".into(),
            Self::OperationInProgress => "operação em andamento".into(),
            Self::LatestNotStopped { status: Some(s) } => {
                format!("o último deployment não está parado ({s}) — verifique pelo Railway")
            }
            Self::LatestNotStopped { status: None } => {
                "a instância não tem deployment parado para reaproveitar".into()
            }
            Self::NoReusableDeployment => {
                "sem deployment reaproveitável — é necessário um novo deploy pelo Railway".into()
            }
        }
    }
}

/// Ação prevista para uma instância.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum Decision {
    /// Interromper todos os deployments ativos.
    WillStop {
        deployments: Vec<RailwayDeploymentId>,
    },
    /// Novo deployment a partir do deployment parado mais recente, com a mesma imagem.
    WillStart {
        from_deployment: RailwayDeploymentId,
    },
    WillSkip {
        reason: SkipReason,
    },
}

impl Decision {
    fn skip(reason: SkipReason) -> Self {
        Self::WillSkip { reason }
    }
}

/// Decide o que fazer com uma instância a partir da leitura atual do Railway.
pub fn decide(kind: PowerKind, snapshot: Option<&InstanceSnapshot>) -> Decision {
    let observation = observe(snapshot);
    if observation.not_found {
        return Decision::skip(SkipReason::NotFound);
    }
    let snapshot = snapshot.expect("observação encontrada implica snapshot");

    match (kind, observation.state) {
        (_, ObservedState::Transitioning) => Decision::skip(SkipReason::Transitioning),
        (_, ObservedState::AwaitingApproval) => Decision::skip(SkipReason::AwaitingApproval),
        (_, ObservedState::Unknown) => Decision::skip(SkipReason::UnknownState),

        (PowerKind::Stop, ObservedState::Stopped) => {
            Decision::skip(SkipReason::AlreadyInDesiredState)
        }
        // Sleeping conta como ligada: desligar interrompe o deployment.
        (PowerKind::Stop, ObservedState::Running | ObservedState::Sleeping) => {
            stop_active(snapshot)
        }
        (PowerKind::Stop, ObservedState::Failed) if !snapshot.active.is_empty() => {
            stop_active(snapshot)
        }
        (PowerKind::Stop, ObservedState::Failed) => {
            Decision::skip(SkipReason::AlreadyInDesiredState)
        }

        (PowerKind::Start, ObservedState::Running | ObservedState::Sleeping) => {
            Decision::skip(SkipReason::AlreadyInDesiredState)
        }
        (PowerKind::Start, ObservedState::Failed | ObservedState::Stopped) => start_from(snapshot),
    }
}

fn stop_active(snapshot: &InstanceSnapshot) -> Decision {
    Decision::WillStop {
        deployments: snapshot.active.iter().map(|d| d.id.clone()).collect(),
    }
}

/// Mesma regra conservadora do antigo `railway.sh`: só reaproveita se o mais recente estiver parado.
fn start_from(snapshot: &InstanceSnapshot) -> Decision {
    let Some(latest) = &snapshot.latest else {
        return Decision::skip(SkipReason::LatestNotStopped { status: None });
    };
    let is_stopped = latest.status == DeploymentStatus::Removed || latest.stopped;
    if !is_stopped {
        return Decision::skip(SkipReason::LatestNotStopped {
            status: Some(latest.status),
        });
    }
    if !latest.can_redeploy {
        return Decision::skip(SkipReason::NoReusableDeployment);
    }
    Decision::WillStart {
        from_deployment: latest.id.clone(),
    }
}

/// Deployment do histórico, com o necessário para escolher de onde reiniciar.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeploymentRecord {
    pub deployment: Deployment,
    pub created_at: Option<DateTime<Utc>>,
    /// Criado por `deploymentRedeploy` (reaproveita um deploy anterior), não por código novo.
    pub is_redeploy: bool,
}

/// O deployment chegou a ficar no ar em algum momento.
fn went_up(status: DeploymentStatus) -> bool {
    matches!(
        status,
        DeploymentStatus::Removed | DeploymentStatus::Success | DeploymentStatus::Sleeping
    )
}

/// Escolhe, no histórico, o deployment a reaproveitar para iniciar: o último commit que
/// subiu. Preferência: o deploy de código (não `redeploy`) mais recente que chegou a
/// subir; sem nenhum, o mais recente que subiu. A recência é decidida pela data de
/// criação (a ordem recebida só desempata), para não depender da ordenação da API.
pub fn restart_source(history: &[DeploymentRecord]) -> Option<&DeploymentRecord> {
    let newest = |only_deploys: bool| {
        history
            .iter()
            .enumerate()
            .filter(|(_, r)| went_up(r.deployment.status) && !(only_deploys && r.is_redeploy))
            .max_by_key(|(index, r)| (r.created_at, std::cmp::Reverse(*index)))
            .map(|(_, r)| r)
    };
    newest(true).or_else(|| newest(false))
}

#[cfg(test)]
mod tests {
    use super::*;
    use DeploymentStatus::*;

    fn id(n: u8) -> RailwayDeploymentId {
        RailwayDeploymentId::parse(&format!("00000000-0000-4000-8000-0000000000{n:02}")).unwrap()
    }

    fn dep(n: u8, status: DeploymentStatus) -> Deployment {
        Deployment {
            id: id(n),
            status,
            can_redeploy: true,
            stopped: false,
        }
    }

    fn snap(latest: Option<Deployment>, active: Vec<Deployment>) -> InstanceSnapshot {
        InstanceSnapshot {
            deleted: false,
            latest,
            active,
        }
    }

    fn running() -> InstanceSnapshot {
        snap(Some(dep(2, Success)), vec![dep(2, Success)])
    }

    fn stopped() -> InstanceSnapshot {
        snap(Some(dep(1, Removed)), vec![])
    }

    fn skip(reason: SkipReason) -> Decision {
        Decision::WillSkip { reason }
    }

    #[test]
    fn desligar_instancia_em_execucao() {
        assert_eq!(
            decide(PowerKind::Stop, Some(&running())),
            Decision::WillStop {
                deployments: vec![id(2)]
            }
        );
    }

    #[test]
    fn desligar_interrompe_todos_os_ativos() {
        let s = snap(
            Some(dep(3, Success)),
            vec![dep(2, Success), dep(3, Success)],
        );
        assert_eq!(
            decide(PowerKind::Stop, Some(&s)),
            Decision::WillStop {
                deployments: vec![id(2), id(3)]
            }
        );
    }

    #[test]
    fn ja_desligada_e_ignorada() {
        assert_eq!(
            decide(PowerKind::Stop, Some(&stopped())),
            skip(SkipReason::AlreadyInDesiredState)
        );
    }

    #[test]
    fn ja_ligada_e_ignorada() {
        assert_eq!(
            decide(PowerKind::Start, Some(&running())),
            skip(SkipReason::AlreadyInDesiredState)
        );
    }

    #[test]
    fn iniciar_instancia_parada_reaproveita_o_ultimo() {
        assert_eq!(
            decide(PowerKind::Start, Some(&stopped())),
            Decision::WillStart {
                from_deployment: id(1)
            }
        );
    }

    #[test]
    fn iniciar_aceita_deployment_marcado_como_parado() {
        let mut latest = dep(1, Success);
        latest.stopped = true;
        let s = snap(Some(latest), vec![]);
        assert_eq!(
            decide(PowerKind::Start, Some(&s)),
            Decision::WillStart {
                from_deployment: id(1)
            }
        );
    }

    #[test]
    fn nada_reaproveitavel() {
        let mut latest = dep(1, Removed);
        latest.can_redeploy = false;
        let d = decide(PowerKind::Start, Some(&snap(Some(latest), vec![])));
        assert_eq!(d, skip(SkipReason::NoReusableDeployment));
        let Decision::WillSkip { reason } = d else {
            unreachable!()
        };
        assert!(reason.is_failure());
        assert!(reason.message().contains("sem deployment reaproveitável"));
    }

    #[test]
    fn iniciar_com_ultimo_falho_nao_ressuscita_antigo() {
        let s = snap(Some(dep(2, Failed)), vec![]);
        assert_eq!(
            decide(PowerKind::Start, Some(&s)),
            skip(SkipReason::LatestNotStopped {
                status: Some(Failed)
            })
        );
    }

    #[test]
    fn iniciar_sem_nenhum_deployment_falha() {
        let d = decide(PowerKind::Start, Some(&snap(None, vec![])));
        assert_eq!(d, skip(SkipReason::LatestNotStopped { status: None }));
    }

    #[test]
    fn em_transicao_e_ignorada_nos_dois_sentidos() {
        let s = snap(Some(dep(2, Deploying)), vec![]);
        for kind in [PowerKind::Start, PowerKind::Stop] {
            assert_eq!(decide(kind, Some(&s)), skip(SkipReason::Transitioning));
        }
    }

    #[test]
    fn aguardando_aprovacao_e_ignorada() {
        let s = snap(Some(dep(2, NeedsApproval)), vec![]);
        for kind in [PowerKind::Start, PowerKind::Stop] {
            assert_eq!(decide(kind, Some(&s)), skip(SkipReason::AwaitingApproval));
        }
    }

    #[test]
    fn sleeping_conta_como_ligada() {
        let s = snap(Some(dep(2, Sleeping)), vec![dep(2, Sleeping)]);
        assert_eq!(
            decide(PowerKind::Start, Some(&s)),
            skip(SkipReason::AlreadyInDesiredState)
        );
        assert_eq!(
            decide(PowerKind::Stop, Some(&s)),
            Decision::WillStop {
                deployments: vec![id(2)]
            }
        );
    }

    #[test]
    fn nao_encontrada_e_inelegivel() {
        for kind in [PowerKind::Start, PowerKind::Stop] {
            assert_eq!(decide(kind, None), skip(SkipReason::NotFound));
        }
    }

    #[test]
    fn desligar_falha_sem_ativos_ja_esta_desligada() {
        let s = snap(Some(dep(2, Crashed)), vec![]);
        assert_eq!(
            decide(PowerKind::Stop, Some(&s)),
            skip(SkipReason::AlreadyInDesiredState)
        );
    }

    #[test]
    fn motivos_de_skip_comum_nao_sao_falha() {
        assert!(!SkipReason::AlreadyInDesiredState.is_failure());
        assert!(!SkipReason::Transitioning.is_failure());
        assert!(!SkipReason::OperationInProgress.is_failure());
    }

    fn record(
        n: u8,
        status: DeploymentStatus,
        minute: Option<u32>,
        redeploy: bool,
    ) -> DeploymentRecord {
        DeploymentRecord {
            deployment: dep(n, status),
            created_at: minute.map(|m| {
                DateTime::parse_from_rfc3339(&format!("2026-11-17T01:{m:02}:00Z"))
                    .unwrap()
                    .to_utc()
            }),
            is_redeploy: redeploy,
        }
    }

    #[test]
    fn reinicio_usa_o_ultimo_deploy_de_codigo_e_ignora_redeploys() {
        // Caso real: redeploys (mais novos) de um commit antigo por cima do último deploy.
        let history = [
            record(5, Removed, Some(50), true),
            record(4, Failed, Some(45), true),
            record(3, Removed, Some(35), false),
            record(2, Removed, Some(10), false),
        ];
        assert_eq!(restart_source(&history).unwrap().deployment.id, id(3));
    }

    #[test]
    fn reinicio_decide_pela_data_mesmo_fora_de_ordem() {
        let history = [
            record(1, Removed, Some(5), false),
            record(2, Removed, Some(40), false),
            record(3, Removed, Some(20), false),
        ];
        assert_eq!(restart_source(&history).unwrap().deployment.id, id(2));
    }

    #[test]
    fn reinicio_ignora_deploys_que_nao_subiram() {
        let history = [
            record(1, Failed, Some(50), false),
            record(2, Crashed, Some(45), false),
            record(3, Building, Some(44), false),
            record(4, Removed, Some(30), false),
        ];
        assert_eq!(restart_source(&history).unwrap().deployment.id, id(4));
    }

    #[test]
    fn reinicio_sem_deploy_de_codigo_usa_o_redeploy_mais_recente() {
        let history = [
            record(1, Removed, Some(10), true),
            record(2, Removed, Some(20), true),
        ];
        assert_eq!(restart_source(&history).unwrap().deployment.id, id(2));
    }

    #[test]
    fn reinicio_sem_datas_mantem_a_ordem_da_api() {
        let history = [
            record(1, Removed, None, false),
            record(2, Removed, None, false),
        ];
        assert_eq!(restart_source(&history).unwrap().deployment.id, id(1));
    }

    #[test]
    fn reinicio_sem_nada_que_subiu() {
        assert!(restart_source(&[record(1, Failed, Some(1), false)]).is_none());
        assert!(restart_source(&[]).is_none());
    }
}
