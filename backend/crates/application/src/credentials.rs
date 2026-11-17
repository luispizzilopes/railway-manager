//! Cadastro, validação, substituição e remoção do token Railway.

use std::sync::Arc;

use domain::credential::{CredentialKind, CredentialMetadata, CredentialStatus, check_shape};
use domain::ids::RailwayWorkspaceId;

use crate::error::{AppError, AppResult};
use crate::ports::{Clock, CredentialCipher, CredentialRepository, StoredCredential};
use crate::railway::{RailwayError, RailwayGateway, RailwayResult, RailwayToken};

/// Pedido de cadastro. Tokens de projeto são recusados antes, na leitura do tipo.
#[derive(Debug, Clone)]
pub struct RegisterCredential {
    pub kind: CredentialKind,
    pub workspace_id: Option<String>,
    pub token: RailwayToken,
}

/// Credencial utilizável numa chamada ao Railway.
#[derive(Debug, Clone)]
pub struct ActiveCredential {
    pub metadata: CredentialMetadata,
    pub token: RailwayToken,
}

pub struct CredentialService {
    repo: Arc<dyn CredentialRepository>,
    cipher: Arc<dyn CredentialCipher>,
    railway: Arc<dyn RailwayGateway>,
    clock: Arc<dyn Clock>,
}

impl CredentialService {
    pub fn new(
        repo: Arc<dyn CredentialRepository>,
        cipher: Arc<dyn CredentialCipher>,
        railway: Arc<dyn RailwayGateway>,
        clock: Arc<dyn Clock>,
    ) -> Self {
        Self {
            repo,
            cipher,
            railway,
            clock,
        }
    }

    /// Valida no Railway e só então persiste (cifrado), substituindo o anterior.
    pub async fn register(&self, input: RegisterCredential) -> AppResult<CredentialMetadata> {
        let workspace_id = input
            .workspace_id
            .as_deref()
            .map(str::trim)
            .filter(|w| !w.is_empty())
            .map(RailwayWorkspaceId::parse)
            .transpose()
            .map_err(|e| AppError::Validation(e.to_string()))?;
        check_shape(input.kind, workspace_id.as_ref(), input.token.expose())
            .map_err(|e| AppError::Validation(e.to_string()))?;
        let token = RailwayToken::new(input.token.expose().trim());

        let label = match (input.kind, &workspace_id) {
            (CredentialKind::Account, _) => {
                let me = self.railway.me(&token).await.map_err(validation_error)?;
                match me.name.filter(|n| !n.trim().is_empty()) {
                    Some(name) => format!("{name} <{}>", me.email),
                    None => me.email,
                }
            }
            (CredentialKind::Workspace, Some(id)) => {
                self.railway
                    .workspace(&token, id)
                    .await
                    .map_err(validation_error)?
                    .name
            }
            (CredentialKind::Workspace, None) => unreachable!("validado por check_shape"),
        };

        let now = self.clock.now();
        let metadata =
            CredentialMetadata::validated(input.kind, workspace_id, &label, token.expose(), now)
                .map_err(|e| AppError::Validation(e.to_string()))?;
        let sealed = self.cipher.seal(metadata.id, &token)?;
        self.repo
            .replace(&StoredCredential {
                metadata: metadata.clone(),
                sealed,
            })
            .await?;
        tracing::info!(
            kind = metadata.kind.as_str(),
            "credencial Railway cadastrada"
        );
        Ok(metadata)
    }

    /// Metadados atuais; marca como indecifrável se a chave mestra não abrir o token.
    pub async fn current(&self) -> AppResult<Option<CredentialMetadata>> {
        let Some(stored) = self.repo.get().await? else {
            return Ok(None);
        };
        let mut metadata = stored.metadata;
        let decipherable = self.cipher.open(metadata.id, &stored.sealed).is_ok();
        if !decipherable && metadata.status != CredentialStatus::Undecipherable {
            self.repo
                .set_status(metadata.id, CredentialStatus::Undecipherable, None)
                .await?;
            metadata.status = CredentialStatus::Undecipherable;
            tracing::warn!("credencial Railway indecifrável com a chave mestra atual");
        } else if decipherable && metadata.status == CredentialStatus::Undecipherable {
            // A chave correta voltou: o token volta a valer até prova em contrário.
            self.repo
                .set_status(metadata.id, CredentialStatus::Valid, None)
                .await?;
            metadata.status = CredentialStatus::Valid;
        }
        Ok(Some(metadata))
    }

    pub async fn remove(&self) -> AppResult<()> {
        self.repo.delete().await?;
        tracing::info!("credencial Railway removida");
        Ok(())
    }

    /// Token pronto para uso, ou o motivo de a integração não estar ativa.
    pub async fn active(&self) -> AppResult<ActiveCredential> {
        let stored = self
            .repo
            .get()
            .await?
            .ok_or(AppError::IntegrationNotConfigured)?;
        let token = match self.cipher.open(stored.metadata.id, &stored.sealed) {
            Ok(token) => token,
            Err(_) => {
                if stored.metadata.status != CredentialStatus::Undecipherable {
                    self.repo
                        .set_status(stored.metadata.id, CredentialStatus::Undecipherable, None)
                        .await?;
                }
                return Err(AppError::CredentialUndecipherable);
            }
        };
        if stored.metadata.status == CredentialStatus::Invalid {
            return Err(AppError::CredentialInvalid);
        }
        Ok(ActiveCredential {
            metadata: stored.metadata,
            token,
        })
    }

    /// Converte o resultado de uma chamada; em falha de autenticação marca a credencial
    /// como inválida para o dashboard.
    pub async fn check<T>(
        &self,
        credential: &ActiveCredential,
        result: RailwayResult<T>,
    ) -> AppResult<T> {
        match result {
            Ok(value) => Ok(value),
            Err(RailwayError::Unauthorized) => {
                self.mark_invalid(credential).await;
                Err(AppError::CredentialInvalid)
            }
            Err(err) => Err(err.into()),
        }
    }

    pub async fn mark_invalid(&self, credential: &ActiveCredential) {
        let result = self
            .repo
            .set_status(credential.metadata.id, CredentialStatus::Invalid, None)
            .await;
        match result {
            Ok(()) => tracing::warn!("credencial Railway marcada como inválida"),
            Err(err) => tracing::error!(%err, "falha ao marcar credencial como inválida"),
        }
    }
}

/// Erros durante a validação do token: recusa → 422; indisponibilidade → 503.
fn validation_error(err: RailwayError) -> AppError {
    match err {
        RailwayError::Unauthorized | RailwayError::NotFound(_) | RailwayError::Validation(_) => {
            AppError::Unprocessable(
                "token inválido ou sem permissão no Railway (verifique o tipo e o workspace)"
                    .into(),
            )
        }
        RailwayError::RateLimited { retry_after_secs } => AppError::RateLimited(retry_after_secs),
        RailwayError::Unavailable(_) | RailwayError::Uncertain(_) => AppError::RailwayUnavailable(
            "não foi possível validar o token: Railway indisponível".into(),
        ),
        RailwayError::Unknown(msg) => AppError::Railway(msg),
    }
}
