//! Erros dos casos de uso. A camada HTTP os traduz para status e códigos.

use crate::ports::{CipherError, RepoError};
use crate::railway::RailwayError;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum AppError {
    /// Entrada malformada (400).
    #[error("{0}")]
    Validation(String),
    /// Entrada bem formada, mas recusada pelas regras ou pelo Railway (422).
    #[error("{0}")]
    Unprocessable(String),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Conflict(String),
    /// Agenda inválida (400); sobreposição traz as janelas em conflito.
    #[error("{0}")]
    InvalidSchedule(domain::schedule::InvalidSchedule),
    /// Instâncias inexistentes ou não gerenciadas num alvo de instâncias (400).
    #[error("instâncias desconhecidas ou não gerenciadas: {}", ids(.0))]
    UnknownInstances(Vec<domain::ids::ServiceInstanceId>),
    /// Plano já executado (409), com a operação criada por ele.
    #[error("este plano já foi executado")]
    PlanAlreadyUsed(Option<domain::ids::OperationId>),
    /// Recurso que existiu e não é mais utilizável (410), ex.: plano expirado.
    #[error("{0}")]
    Gone(String),
    #[error("integração não configurada: cadastre um token do Railway")]
    IntegrationNotConfigured,
    #[error("o token do Railway é inválido ou foi revogado: cadastre um novo")]
    CredentialInvalid,
    #[error(
        "o token armazenado não pode ser decifrado com a chave mestra atual: cadastre-o novamente"
    )]
    CredentialUndecipherable,
    #[error("{0}")]
    RailwayUnavailable(String),
    #[error("rate limit do Railway atingido; tente novamente em {0}s")]
    RateLimited(u64),
    /// Erro do Railway sem classificação mais específica (502).
    #[error("{0}")]
    Railway(String),
    #[error("erro interno: {0}")]
    Internal(String),
}

fn ids(list: &[domain::ids::ServiceInstanceId]) -> String {
    list.iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join(", ")
}

pub type AppResult<T> = Result<T, AppError>;

impl From<RepoError> for AppError {
    fn from(err: RepoError) -> Self {
        match err {
            RepoError::Conflict(msg) => Self::Conflict(msg),
            RepoError::NotFound => Self::NotFound("registro não encontrado".into()),
            RepoError::Database(msg) => Self::Internal(msg),
        }
    }
}

impl From<RailwayError> for AppError {
    fn from(err: RailwayError) -> Self {
        match err {
            RailwayError::Unauthorized => Self::CredentialInvalid,
            RailwayError::NotFound(_) => Self::NotFound(err.to_string()),
            RailwayError::Validation(_) => Self::Unprocessable(err.to_string()),
            RailwayError::RateLimited { retry_after_secs } => Self::RateLimited(retry_after_secs),
            RailwayError::Unavailable(_) | RailwayError::Uncertain(_) => {
                Self::RailwayUnavailable(err.to_string())
            }
            RailwayError::Unknown(_) => Self::Railway(err.to_string()),
        }
    }
}

impl From<CipherError> for AppError {
    fn from(err: CipherError) -> Self {
        match err {
            CipherError::MissingKey | CipherError::Undecipherable => Self::CredentialUndecipherable,
            CipherError::Encrypt => Self::Internal(err.to_string()),
        }
    }
}

impl From<domain::schedule::InvalidSchedule> for AppError {
    fn from(err: domain::schedule::InvalidSchedule) -> Self {
        Self::InvalidSchedule(err)
    }
}
