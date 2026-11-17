//! Configuração do processo, lida de variáveis `RM_*` e validada na inicialização.
//! A lista completa e documentada está em `.env.example`.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::str::FromStr;
use std::time::Duration;

use argon2::PasswordHash;
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use domain::power::StopMechanism;
use secrecy::{SecretBox, SecretString};

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ConfigError {
    #[error(
        "senha de administrador não configurada: defina RM_ADMIN_PASSWORD_HASH \
         (gere com `railway-manager hash-password`) ou RM_ADMIN_PASSWORD"
    )]
    MissingAdminPassword,
    #[error("{var} inválida: {reason}")]
    Invalid { var: &'static str, reason: String },
}

fn invalid(var: &'static str, reason: impl Into<String>) -> ConfigError {
    ConfigError::Invalid {
        var,
        reason: reason.into(),
    }
}

/// Senha do administrador, como hash argon2 (produção) ou texto claro (desenvolvimento).
#[derive(Debug)]
pub enum AdminPassword {
    Hash(String),
    Plain(SecretString),
}

/// Chave de 32 bytes usada para cifrar a credencial Railway.
pub type MasterKey = SecretBox<[u8; 32]>;

#[derive(Debug)]
pub struct RailwayConfig {
    pub api_url: String,
    pub rps: u32,
    pub connect_timeout: Duration,
    pub request_timeout: Duration,
    pub max_retries: u32,
    pub stop_mechanism: StopMechanism,
}

#[derive(Debug)]
pub struct OperationsConfig {
    pub max_concurrency: usize,
    pub plan_ttl: Duration,
    pub start_timeout: Duration,
    pub stop_timeout: Duration,
    pub poll_interval: Duration,
    pub poll_max_interval: Duration,
}

#[derive(Debug)]
pub struct Config {
    pub admin_password: AdminPassword,
    /// Ausente: o processo sobe sem integração ativa e a credencial fica "indecifrável".
    pub master_key: Option<MasterKey>,
    pub bind_addr: SocketAddr,
    pub frontend_dir: PathBuf,
    pub log: String,
    pub database_url: String,
    pub session_ttl: Duration,
    pub cookie_secure: bool,
    pub login_max_attempts: u32,
    pub login_window: Duration,
    pub railway: RailwayConfig,
    pub operations: OperationsConfig,
    pub stale_after: Duration,
    pub scheduler: SchedulerConfig,
}

#[derive(Debug)]
pub struct SchedulerConfig {
    /// Fuso usado quando a agenda não informa outro.
    pub timezone: chrono_tz::Tz,
    /// Evento perdido mais antigo que isto não é recuperado (0 = nunca recupera).
    pub catchup: Duration,
    pub tick: Duration,
}

impl Config {
    pub fn from_env() -> Result<Self, ConfigError> {
        Self::from_lookup(|key| std::env::var(key).ok())
    }

    /// Lê a configuração a partir de uma função de busca (permite testar sem tocar o ambiente).
    pub fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> Result<Self, ConfigError> {
        let env = Env(&lookup);

        let admin_password = match (
            env.get("RM_ADMIN_PASSWORD_HASH"),
            env.get("RM_ADMIN_PASSWORD"),
        ) {
            (Some(hash), _) => {
                PasswordHash::new(&hash).map_err(|_| {
                    invalid(
                        "RM_ADMIN_PASSWORD_HASH",
                        "não é um hash PHC (argon2) válido",
                    )
                })?;
                AdminPassword::Hash(hash)
            }
            (None, Some(plain)) => AdminPassword::Plain(plain.into()),
            (None, None) => return Err(ConfigError::MissingAdminPassword),
        };

        let master_key = env.get("RM_MASTER_KEY").map(parse_master_key).transpose()?;

        let operations = OperationsConfig {
            max_concurrency: env.positive("RM_MAX_CONCURRENCY", 3)?,
            plan_ttl: env.secs("RM_PLAN_TTL_SECS", 300)?,
            start_timeout: env.secs("RM_START_TIMEOUT_SECS", 600)?,
            stop_timeout: env.secs("RM_STOP_TIMEOUT_SECS", 180)?,
            poll_interval: env.secs("RM_POLL_INTERVAL_SECS", 5)?,
            poll_max_interval: env.secs("RM_POLL_MAX_INTERVAL_SECS", 15)?,
        };
        if operations.poll_interval > operations.poll_max_interval {
            return Err(invalid(
                "RM_POLL_INTERVAL_SECS",
                "não pode ser maior que RM_POLL_MAX_INTERVAL_SECS",
            ));
        }

        Ok(Self {
            admin_password,
            master_key,
            bind_addr: match (env.get("RM_BIND_ADDR"), env.get("PORT")) {
                // No Railway, a porta pública vem em `PORT`.
                (None, Some(port)) => {
                    env.parsed_value("PORT", &format!("0.0.0.0:{}", port.trim()))?
                }
                _ => env.parsed("RM_BIND_ADDR", "0.0.0.0:8080")?,
            },
            frontend_dir: env.or("RM_FRONTEND_DIR", "./frontend/dist").into(),
            log: env.or("RM_LOG", "info"),
            database_url: env.or("RM_DATABASE_URL", "sqlite://railway-manager.db"),
            session_ttl: env.secs("RM_SESSION_TTL_SECS", 43_200)?,
            cookie_secure: env.parsed("RM_COOKIE_SECURE", "false")?,
            login_max_attempts: env.positive("RM_LOGIN_MAX_ATTEMPTS", 5)?,
            login_window: env.secs("RM_LOGIN_WINDOW_SECS", 300)?,
            railway: RailwayConfig {
                api_url: env.or(
                    "RM_RAILWAY_API_URL",
                    "https://backboard.railway.com/graphql/v2",
                ),
                rps: env.positive("RM_RAILWAY_RPS", 5)?,
                connect_timeout: env.secs("RM_RAILWAY_CONNECT_TIMEOUT_SECS", 5)?,
                request_timeout: env.secs("RM_RAILWAY_REQUEST_TIMEOUT_SECS", 20)?,
                max_retries: env.parsed("RM_RAILWAY_MAX_RETRIES", "3")?,
                stop_mechanism: env.parsed("RM_STOP_MECHANISM", "remove")?,
            },
            operations,
            stale_after: env.secs("RM_STALE_AFTER_SECS", 300)?,
            scheduler: SchedulerConfig {
                timezone: env
                    .parsed::<chrono_tz::Tz>("RM_SCHEDULE_TIMEZONE", "America/Sao_Paulo")?,
                catchup: Duration::from_secs(env.parsed("RM_SCHEDULE_CATCHUP_SECS", "1800")?),
                tick: env.secs("RM_SCHEDULER_TICK_SECS", 30)?,
            },
        })
    }
}

fn parse_master_key(raw: String) -> Result<MasterKey, ConfigError> {
    let bytes = BASE64.decode(raw.trim()).map_err(|_| {
        invalid(
            "RM_MASTER_KEY",
            "não é base64 válido (gere com `openssl rand -base64 32`)",
        )
    })?;
    let key: [u8; 32] = bytes.try_into().map_err(|b: Vec<u8>| {
        invalid(
            "RM_MASTER_KEY",
            format!("deve ter 32 bytes, tem {}", b.len()),
        )
    })?;
    Ok(SecretBox::new(Box::new(key)))
}

struct Env<'a, F: Fn(&str) -> Option<String>>(&'a F);

impl<F: Fn(&str) -> Option<String>> Env<'_, F> {
    /// Valor da variável; vazio conta como ausente (como em `.env.example`).
    fn get(&self, key: &str) -> Option<String> {
        (self.0)(key).filter(|v| !v.trim().is_empty())
    }

    fn or(&self, key: &str, default: &str) -> String {
        self.get(key).unwrap_or_else(|| default.to_owned())
    }

    fn parsed<T: FromStr>(&self, key: &'static str, default: &str) -> Result<T, ConfigError>
    where
        T::Err: std::fmt::Display,
    {
        let raw = self.or(key, default);
        raw.trim()
            .parse()
            .map_err(|e| invalid(key, format!("'{raw}': {e}")))
    }

    fn parsed_value<T: FromStr>(&self, key: &'static str, raw: &str) -> Result<T, ConfigError>
    where
        T::Err: std::fmt::Display,
    {
        raw.parse()
            .map_err(|e| invalid(key, format!("'{raw}': {e}")))
    }

    fn positive<T: FromStr + PartialEq + Default>(
        &self,
        key: &'static str,
        default: u32,
    ) -> Result<T, ConfigError>
    where
        T::Err: std::fmt::Display,
    {
        let value: T = self.parsed(key, &default.to_string())?;
        if value == T::default() {
            return Err(invalid(key, "deve ser maior que zero"));
        }
        Ok(value)
    }

    fn secs(&self, key: &'static str, default: u32) -> Result<Duration, ConfigError> {
        self.positive::<u64>(key, default).map(Duration::from_secs)
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use secrecy::ExposeSecret;

    use super::*;

    const KEY: &str = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";

    fn load(vars: &[(&str, &str)]) -> Result<Config, ConfigError> {
        let map: HashMap<String, String> = vars
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        Config::from_lookup(|k| map.get(k).cloned())
    }

    #[test]
    fn sem_senha_falha_citando_as_variaveis() {
        let err = load(&[("RM_MASTER_KEY", KEY)]).unwrap_err();
        assert_eq!(err, ConfigError::MissingAdminPassword);
        let msg = err.to_string();
        assert!(msg.contains("RM_ADMIN_PASSWORD_HASH") && msg.contains("RM_ADMIN_PASSWORD"));
    }

    #[test]
    fn senha_vazia_conta_como_ausente() {
        let err = load(&[("RM_ADMIN_PASSWORD", "  ")]).unwrap_err();
        assert_eq!(err, ConfigError::MissingAdminPassword);
    }

    #[test]
    fn hash_invalido_falha() {
        let err = load(&[("RM_ADMIN_PASSWORD_HASH", "nao-e-hash")]).unwrap_err();
        assert!(matches!(
            err,
            ConfigError::Invalid {
                var: "RM_ADMIN_PASSWORD_HASH",
                ..
            }
        ));
    }

    #[test]
    fn master_key_nao_base64_falha() {
        let err = load(&[("RM_ADMIN_PASSWORD", "x"), ("RM_MASTER_KEY", "%%%")]).unwrap_err();
        assert!(matches!(
            err,
            ConfigError::Invalid {
                var: "RM_MASTER_KEY",
                ..
            }
        ));
        assert!(err.to_string().contains("base64"));
    }

    #[test]
    fn master_key_tamanho_errado_falha() {
        let err = load(&[("RM_ADMIN_PASSWORD", "x"), ("RM_MASTER_KEY", "AAAA")]).unwrap_err();
        assert!(err.to_string().contains("32 bytes, tem 3"), "{err}");
    }

    #[test]
    fn master_key_ausente_sobe_sem_integracao() {
        let cfg = load(&[("RM_ADMIN_PASSWORD", "x")]).unwrap();
        assert!(cfg.master_key.is_none());
    }

    #[test]
    fn defaults_e_master_key_valida() {
        let cfg = load(&[("RM_ADMIN_PASSWORD", "x"), ("RM_MASTER_KEY", KEY)]).unwrap();
        assert_eq!(cfg.master_key.unwrap().expose_secret()[31], 31);
        assert_eq!(cfg.operations.max_concurrency, 3);
        assert_eq!(cfg.railway.rps, 5);
        assert_eq!(cfg.railway.stop_mechanism, StopMechanism::Remove);
        assert_eq!(cfg.stale_after, Duration::from_secs(300));
        assert_eq!(cfg.scheduler.timezone, chrono_tz::America::Sao_Paulo);
        assert_eq!(cfg.scheduler.catchup, Duration::from_secs(1800));
        assert_eq!(cfg.scheduler.tick, Duration::from_secs(30));
        assert_eq!(cfg.bind_addr.port(), 8080);
    }

    #[test]
    fn valores_numericos_invalidos_falham() {
        for (var, value) in [
            ("RM_MAX_CONCURRENCY", "0"),
            ("RM_RAILWAY_RPS", "abc"),
            ("RM_STALE_AFTER_SECS", "-1"),
            ("RM_STOP_MECHANISM", "pause"),
            ("RM_COOKIE_SECURE", "talvez"),
            ("RM_SCHEDULE_TIMEZONE", "Lua/Base"),
            ("RM_SCHEDULE_CATCHUP_SECS", "-5"),
            ("RM_SCHEDULER_TICK_SECS", "0"),
        ] {
            let err = load(&[("RM_ADMIN_PASSWORD", "x"), (var, value)]).unwrap_err();
            assert!(
                matches!(&err, ConfigError::Invalid { var: v, .. } if *v == var),
                "{var}: {err}"
            );
        }
    }

    #[test]
    fn porta_do_railway_quando_nao_ha_bind_explicito() {
        let cfg = load(&[("RM_ADMIN_PASSWORD", "x"), ("PORT", "3000")]).unwrap();
        assert_eq!(cfg.bind_addr.to_string(), "0.0.0.0:3000");
        let cfg = load(&[
            ("RM_ADMIN_PASSWORD", "x"),
            ("PORT", "3000"),
            ("RM_BIND_ADDR", "127.0.0.1:9"),
        ])
        .unwrap();
        assert_eq!(cfg.bind_addr.to_string(), "127.0.0.1:9");
        assert!(load(&[("RM_ADMIN_PASSWORD", "x"), ("PORT", "abc")]).is_err());
    }

    #[test]
    fn poll_interval_maior_que_maximo_falha() {
        let err = load(&[
            ("RM_ADMIN_PASSWORD", "x"),
            ("RM_POLL_INTERVAL_SECS", "20"),
            ("RM_POLL_MAX_INTERVAL_SECS", "15"),
        ])
        .unwrap_err();
        assert!(matches!(
            err,
            ConfigError::Invalid {
                var: "RM_POLL_INTERVAL_SECS",
                ..
            }
        ));
    }
}
