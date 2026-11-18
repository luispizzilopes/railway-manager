//! Linhas de log de um deployment, como o domínio as enxerga.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Severidade normalizada; o Railway devolve texto livre (`error`, `warn`, `info`, …).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LogSeverity {
    Error,
    Warn,
    Info,
    Debug,
}

impl LogSeverity {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Error => "error",
            Self::Warn => "warn",
            Self::Info => "info",
            Self::Debug => "debug",
        }
    }

    /// `None` para valores desconhecidos ou ausentes.
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "error" | "err" | "fatal" | "critical" | "crit" | "panic" => Some(Self::Error),
            "warn" | "warning" => Some(Self::Warn),
            "info" | "notice" => Some(Self::Info),
            "debug" | "trace" => Some(Self::Debug),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LogLine {
    pub timestamp: DateTime<Utc>,
    pub severity: Option<LogSeverity>,
    pub message: String,
}

/// Parâmetros de uma consulta de logs ao Railway.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogQuery {
    pub start: Option<DateTime<Utc>>,
    pub end: Option<DateTime<Utc>>,
    /// Filtro na sintaxe do Railway (`@level:error`, texto livre).
    pub filter: Option<String>,
    pub limit: u32,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normaliza_severidades() {
        assert_eq!(LogSeverity::parse("ERROR"), Some(LogSeverity::Error));
        assert_eq!(LogSeverity::parse("warning"), Some(LogSeverity::Warn));
        assert_eq!(LogSeverity::parse(" trace "), Some(LogSeverity::Debug));
        assert_eq!(LogSeverity::parse("verbose"), None);
    }
}
