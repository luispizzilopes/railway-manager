//! Metadados da credencial Railway. O valor do token nunca faz parte destes tipos.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::ids::{CredentialId, RailwayWorkspaceId};
use crate::operation::str_enum;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CredentialKind {
    Account,
    Workspace,
}

str_enum!(CredentialKind { Account => "account", Workspace => "workspace" });

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CredentialStatus {
    Valid,
    /// O Railway recusou o token (revogado ou sem permissão).
    Invalid,
    /// A chave mestra ausente/incorreta não decifra o valor armazenado.
    Undecipherable,
}

str_enum!(CredentialStatus {
    Valid => "valid",
    Invalid => "invalid",
    Undecipherable => "undecipherable",
});

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum InvalidCredential {
    #[error("o token não pode ser vazio")]
    EmptyToken,
    #[error("token de workspace exige o ID do workspace")]
    MissingWorkspace,
    #[error("token de conta não aceita ID de workspace")]
    UnexpectedWorkspace,
}

/// Quantidade de caracteres finais exibidos na máscara.
pub const MASK_VISIBLE: usize = 4;

/// `••••abcd` — só os últimos 4 caracteres; tokens curtos ficam totalmente mascarados.
pub fn mask_suffix(token: &str) -> String {
    let chars: Vec<char> = token.trim().chars().collect();
    if chars.len() <= MASK_VISIBLE * 2 {
        return String::new();
    }
    chars[chars.len() - MASK_VISIBLE..].iter().collect()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CredentialMetadata {
    pub id: CredentialId,
    pub kind: CredentialKind,
    pub workspace_id: Option<RailwayWorkspaceId>,
    /// Nome/e-mail da conta ou nome do workspace, conforme a validação.
    pub label: String,
    pub masked_suffix: String,
    pub status: CredentialStatus,
    pub validated_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

impl CredentialMetadata {
    /// Metadados de um token recém-validado no Railway.
    pub fn validated(
        kind: CredentialKind,
        workspace_id: Option<RailwayWorkspaceId>,
        label: &str,
        token: &str,
        now: DateTime<Utc>,
    ) -> Result<Self, InvalidCredential> {
        check_shape(kind, workspace_id.as_ref(), token)?;
        Ok(Self {
            id: CredentialId::new(),
            kind,
            workspace_id,
            label: label.trim().to_owned(),
            masked_suffix: mask_suffix(token),
            status: CredentialStatus::Valid,
            validated_at: Some(now),
            created_at: now,
        })
    }

    /// Integração utilizável: token válido e decifrável.
    pub fn is_usable(&self) -> bool {
        self.status == CredentialStatus::Valid
    }
}

/// Validação de forma, antes de consultar o Railway.
pub fn check_shape(
    kind: CredentialKind,
    workspace_id: Option<&RailwayWorkspaceId>,
    token: &str,
) -> Result<(), InvalidCredential> {
    if token.trim().is_empty() {
        return Err(InvalidCredential::EmptyToken);
    }
    match (kind, workspace_id) {
        (CredentialKind::Workspace, None) => Err(InvalidCredential::MissingWorkspace),
        (CredentialKind::Account, Some(_)) => Err(InvalidCredential::UnexpectedWorkspace),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ws() -> RailwayWorkspaceId {
        RailwayWorkspaceId::parse("00000000-0000-4000-8000-000000000009").unwrap()
    }

    #[test]
    fn mascara_mostra_so_os_ultimos_4() {
        assert_eq!(mask_suffix("0123456789abcdef"), "cdef");
        assert_eq!(mask_suffix("curto"), "");
    }

    #[test]
    fn workspace_exige_id() {
        let now = Utc::now();
        let token = "tok-0123456789";
        assert_eq!(
            CredentialMetadata::validated(CredentialKind::Workspace, None, "x", token, now),
            Err(InvalidCredential::MissingWorkspace)
        );
        assert_eq!(
            CredentialMetadata::validated(CredentialKind::Account, Some(ws()), "x", token, now),
            Err(InvalidCredential::UnexpectedWorkspace)
        );
        assert_eq!(
            CredentialMetadata::validated(CredentialKind::Account, None, "x", "  ", now),
            Err(InvalidCredential::EmptyToken)
        );
        let ok = CredentialMetadata::validated(
            CredentialKind::Workspace,
            Some(ws()),
            "time",
            token,
            now,
        )
        .unwrap();
        assert!(ok.is_usable());
        assert_eq!(ok.masked_suffix, "6789");
    }

    #[test]
    fn metadados_nao_contem_o_token() {
        let token = "segredo-super-secreto-123";
        let meta =
            CredentialMetadata::validated(CredentialKind::Account, None, "eu", token, Utc::now())
                .unwrap();
        assert!(!format!("{meta:?}").contains("segredo"));
    }
}
