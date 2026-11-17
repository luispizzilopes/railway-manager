//! Identificadores: internos (UUID gerado localmente) e do Railway (UUID validado).

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{kind} inválido: '{value}' (esperado UUID)")]
pub struct InvalidId {
    pub kind: &'static str,
    pub value: String,
}

macro_rules! internal_id {
    ($(#[$doc:meta])* $name:ident) => {
        $(#[$doc])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(pub Uuid);

        impl $name {
            pub fn new() -> Self {
                Self(Uuid::new_v4())
            }
        }

        impl Default for $name {
            fn default() -> Self {
                Self::new()
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                self.0.fmt(f)
            }
        }

        impl FromStr for $name {
            type Err = InvalidId;

            fn from_str(s: &str) -> Result<Self, Self::Err> {
                Uuid::parse_str(s)
                    .map(Self)
                    .map_err(|_| InvalidId { kind: stringify!($name), value: s.to_owned() })
            }
        }
    };
}

internal_id!(CredentialId);
internal_id!(ProjectId);
internal_id!(EnvironmentId);
internal_id!(ServiceId);
internal_id!(ServiceInstanceId);
internal_id!(OperationId);
internal_id!(OperationItemId);
internal_id!(PlanId);
internal_id!(ScheduleId);
internal_id!(ScheduleRunId);

macro_rules! railway_id {
    ($(#[$doc:meta])* $name:ident, $label:literal) => {
        $(#[$doc])*
        #[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
        #[serde(try_from = "String", into = "String")]
        pub struct $name(String);

        impl $name {
            /// Valida o formato (UUID) e normaliza para minúsculas.
            pub fn parse(value: &str) -> Result<Self, InvalidId> {
                let trimmed = value.trim();
                Uuid::try_parse(trimmed)
                    .ok()
                    .filter(|_| trimmed.len() == 36)
                    .map(|u| Self(u.hyphenated().to_string()))
                    .ok_or_else(|| InvalidId { kind: $label, value: value.to_owned() })
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&self.0)
            }
        }

        impl FromStr for $name {
            type Err = InvalidId;

            fn from_str(s: &str) -> Result<Self, Self::Err> {
                Self::parse(s)
            }
        }

        impl TryFrom<String> for $name {
            type Error = InvalidId;

            fn try_from(value: String) -> Result<Self, Self::Error> {
                Self::parse(&value)
            }
        }

        impl From<$name> for String {
            fn from(id: $name) -> Self {
                id.0
            }
        }
    };
}

railway_id!(RailwayWorkspaceId, "Railway Workspace ID");
railway_id!(RailwayProjectId, "Railway Project ID");
railway_id!(RailwayEnvironmentId, "Railway Environment ID");
railway_id!(RailwayServiceId, "Railway Service ID");
railway_id!(RailwayDeploymentId, "Railway Deployment ID");

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn railway_id_valido_e_normalizado() {
        let id = RailwayProjectId::parse(" 0F3C2A1B-1234-4ABC-9DEF-0123456789AB ").unwrap();
        assert_eq!(id.as_str(), "0f3c2a1b-1234-4abc-9def-0123456789ab");
    }

    #[test]
    fn railway_id_invalido() {
        for value in [
            "",
            "abc",
            "0f3c2a1b12344abc9def0123456789ab",
            "{0f3c2a1b-1234-4abc-9def-0123456789ab}",
            "0f3c2a1b-1234-4abc-9def-0123456789ag",
        ] {
            let err = RailwayServiceId::parse(value).unwrap_err();
            assert_eq!(err.kind, "Railway Service ID", "{value}");
        }
    }

    #[test]
    fn railway_id_try_from_valida() {
        let ok = RailwayEnvironmentId::try_from("0f3c2a1b-1234-4abc-9def-0123456789ab".to_owned());
        assert!(ok.is_ok());
        assert!(RailwayEnvironmentId::try_from("x".to_owned()).is_err());
    }

    #[test]
    fn internal_id_roundtrip() {
        let id = ProjectId::new();
        assert_eq!(id.to_string().parse::<ProjectId>().unwrap(), id);
        assert!("nope".parse::<ProjectId>().is_err());
    }
}
