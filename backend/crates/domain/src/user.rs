//! Usuários e papéis. O master vive no ambiente; só os papéis abaixo são gravados no banco.

use std::fmt;
use std::str::FromStr;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::ids::UserId;

/// Papel de acesso, em ordem crescente de permissão. Cada papel inclui os anteriores.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    Viewer,
    Operator,
    Admin,
    /// Usuário definido no ambiente; nunca é gravado em `users`.
    Master,
}

impl Role {
    /// Papéis que podem ser atribuídos a usuários cadastrados.
    pub const ASSIGNABLE: [Role; 3] = [Role::Viewer, Role::Operator, Role::Admin];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Viewer => "viewer",
            Self::Operator => "operator",
            Self::Admin => "admin",
            Self::Master => "master",
        }
    }

    pub fn allows(self, minimum: Role) -> bool {
        self >= minimum
    }

    pub fn is_assignable(self) -> bool {
        self != Self::Master
    }
}

impl fmt::Display for Role {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("papel inválido: '{0}' (use viewer, operator ou admin)")]
pub struct InvalidRole(pub String);

impl FromStr for Role {
    type Err = InvalidRole;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "viewer" => Ok(Self::Viewer),
            "operator" => Ok(Self::Operator),
            "admin" => Ok(Self::Admin),
            other => Err(InvalidRole(other.to_owned())),
        }
    }
}

pub const MIN_PASSWORD_LEN: usize = 8;
const USERNAME_LEN: std::ops::RangeInclusive<usize> = 3..=32;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum InvalidUsername {
    #[error("o nome de usuário deve ter de 3 a 32 caracteres")]
    Length,
    #[error("o nome de usuário só pode ter letras, números, '.', '_' e '-'")]
    Charset,
}

/// Nome de usuário validado. A chave de unicidade ignora maiúsculas e minúsculas.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Username(String);

impl Username {
    pub fn parse(raw: &str) -> Result<Self, InvalidUsername> {
        let name = raw.trim();
        if !USERNAME_LEN.contains(&name.chars().count()) {
            return Err(InvalidUsername::Length);
        }
        if !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        {
            return Err(InvalidUsername::Charset);
        }
        Ok(Self(name.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Forma normalizada usada para comparar e garantir unicidade.
    pub fn key(&self) -> String {
        key_of(&self.0)
    }
}

impl fmt::Display for Username {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// Chave de comparação de um nome de usuário (sem diferenciar maiúsculas).
pub fn key_of(name: &str) -> String {
    name.trim().to_lowercase()
}

/// Usuário cadastrado. O hash da senha nunca faz parte desta estrutura.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct User {
    pub id: UserId,
    pub username: Username,
    pub role: Role,
    pub is_active: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn papeis_sao_ordenados() {
        assert!(Role::Master.allows(Role::Admin));
        assert!(Role::Admin.allows(Role::Operator));
        assert!(Role::Operator.allows(Role::Viewer));
        assert!(!Role::Viewer.allows(Role::Operator));
        assert!(!Role::Operator.allows(Role::Admin));
        assert!(!Role::Admin.allows(Role::Master));
    }

    #[test]
    fn master_nao_e_atribuivel() {
        assert!("master".parse::<Role>().is_err());
        assert!("root".parse::<Role>().is_err());
        assert_eq!("operator".parse::<Role>().unwrap(), Role::Operator);
        assert!(!Role::Master.is_assignable());
    }

    #[test]
    fn nome_normalizado_e_validado() {
        let name = Username::parse("  Maria.Silva ").unwrap();
        assert_eq!(name.as_str(), "Maria.Silva");
        assert_eq!(name.key(), "maria.silva");
        assert_eq!(Username::parse("ab").unwrap_err(), InvalidUsername::Length);
        assert_eq!(
            Username::parse(&"a".repeat(33)).unwrap_err(),
            InvalidUsername::Length
        );
        assert_eq!(
            Username::parse("maria silva").unwrap_err(),
            InvalidUsername::Charset
        );
        assert_eq!(
            Username::parse("joão").unwrap_err(),
            InvalidUsername::Charset
        );
    }
}
