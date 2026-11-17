use std::io::{BufRead, Write};
use std::process::ExitCode;
use std::sync::Arc;

use railway_manager::config::Config;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> ExitCode {
    if std::env::args().nth(1).as_deref() == Some("hash-password") {
        return hash_password();
    }

    let config = match Config::from_env() {
        Ok(config) => config,
        Err(err) => {
            eprintln!("erro de configuração: {err}");
            return ExitCode::from(2);
        }
    };

    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_new(&config.log).unwrap_or_else(|_| EnvFilter::new("info")))
        .init();

    match run(config).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            tracing::error!("{err}");
            ExitCode::FAILURE
        }
    }
}

async fn run(config: Config) -> Result<(), String> {
    let pool = infrastructure::sqlite::connect(&config.database_url)
        .await
        .map_err(|e| format!("banco de dados ({}): {e}", config.database_url))?;
    let interrupted = railway_manager::recover(&pool).await?;
    if interrupted > 0 {
        tracing::warn!(interrupted, "itens de operação interrompidos por reinício");
    }

    let railway = Arc::new(railway_manager::railway_client(&config)?);
    let state = railway_manager::build_state(&config, pool, railway);
    if config.master_key.is_none() {
        tracing::warn!("RM_MASTER_KEY ausente: a integração com o Railway fica inativa");
    }
    // Detecta cedo um token indecifrável com a chave atual.
    if let Err(err) = state.credentials.current().await {
        tracing::warn!(%err, "não foi possível verificar a credencial");
    }

    let frontend = config
        .frontend_dir
        .join("index.html")
        .exists()
        .then_some(config.frontend_dir.as_path());
    if frontend.is_none() {
        tracing::warn!(dir = %config.frontend_dir.display(), "frontend não encontrado; servindo só a API");
    }
    let power = state.power.clone();
    let scheduler = railway_manager::spawn_scheduler(state.scheduler.clone(), state.clock.clone());
    let app = api::router(state, frontend);

    let listener = tokio::net::TcpListener::bind(config.bind_addr)
        .await
        .map_err(|e| format!("não foi possível escutar em {}: {e}", config.bind_addr))?;
    tracing::info!(addr = %config.bind_addr, "Railway Manager no ar");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown())
        .await
        .map_err(|e| e.to_string())?;
    scheduler.abort();
    // Operações em andamento que não terminarem viram `interrupted` no próximo início.
    let _ = tokio::time::timeout(std::time::Duration::from_secs(10), power.wait_idle()).await;
    Ok(())
}

async fn shutdown() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut signal) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            signal.recv().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        () = ctrl_c => {},
        () = terminate => {},
    }
    tracing::info!("encerrando");
}

/// `railway-manager hash-password`: lê a senha da entrada padrão e imprime o hash argon2.
fn hash_password() -> ExitCode {
    eprint!("senha: ");
    let _ = std::io::stderr().flush();
    let mut line = String::new();
    if std::io::stdin().lock().read_line(&mut line).is_err() {
        eprintln!("erro ao ler a senha");
        return ExitCode::FAILURE;
    }
    let password = line.trim_end_matches(['\r', '\n']);
    if password.is_empty() {
        eprintln!("a senha não pode ser vazia");
        return ExitCode::FAILURE;
    }
    match api::hash_password(password) {
        Ok(hash) => {
            println!("{hash}");
            ExitCode::SUCCESS
        }
        Err(err) => {
            eprintln!("erro: {err}");
            ExitCode::FAILURE
        }
    }
}
