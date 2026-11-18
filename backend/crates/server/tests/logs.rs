//! Casos de uso de logs com Railway falso.

mod common;

use application::error::AppError;
use application::logs::{LogKind, LogsRequest};
use chrono::{DateTime, TimeZone, Utc};
use common::*;
use domain::deployment::{Deployment, DeploymentStatus};
use domain::ids::ServiceInstanceId;
use domain::logs::{LogLine, LogSeverity};
use domain::power::DeploymentRecord;

fn at(second: u32) -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 11, 18, 10, 0, second).unwrap()
}

fn line(second: u32, severity: Option<LogSeverity>, message: &str) -> LogLine {
    LogLine {
        timestamp: at(second),
        severity,
        message: message.into(),
    }
}

fn record(n: u32, status: DeploymentStatus, created: DateTime<Utc>) -> DeploymentRecord {
    DeploymentRecord {
        deployment: Deployment {
            id: rid(n),
            status,
            can_redeploy: true,
            stopped: false,
        },
        created_at: Some(created),
        is_redeploy: false,
    }
}

/// `loja` com api@production (deploy 100 ativo) e worker@production (parado); devolve `api`.
async fn api_instance(h: &Harness) -> ServiceInstanceId {
    h.with_account().await;
    h.seed_loja();
    let p = h
        .projects
        .register(&rid::<String>(1), None)
        .await
        .unwrap()
        .id;
    h.inventory
        .import(
            p,
            &[application::inventory::InstanceRef {
                environment_id: rid(10),
                service_id: rid(20),
            }],
        )
        .await
        .unwrap();
    h.inventory
        .local_instances(Some(p))
        .await
        .unwrap()
        .into_iter()
        .find(|v| v.service.name == "api" && v.environment.name == "production")
        .unwrap()
        .instance
        .id
}

fn runtime_lines() -> Vec<LogLine> {
    vec![
        line(3, Some(LogSeverity::Error), "falha ao conectar"),
        line(1, Some(LogSeverity::Info), "iniciando"),
        line(2, Some(LogSeverity::Warn), "lento"),
    ]
}

#[tokio::test]
async fn logs_do_deploy_mais_recente_em_ordem_crescente() {
    let h = harness().await;
    let instance = api_instance(&h).await;
    h.railway.with_runtime_logs(100, runtime_lines());

    let logs = h.logs.read(instance, LogsRequest::default()).await.unwrap();
    assert_eq!(logs.deployment_id, Some(rid(100)));
    assert_eq!(logs.deployment_status, Some(DeploymentStatus::Success));
    assert!(logs.is_current);
    assert!(!logs.truncated);
    let messages: Vec<_> = logs.lines.iter().map(|l| l.message.as_str()).collect();
    assert_eq!(messages, ["iniciando", "lento", "falha ao conectar"]);
}

#[tokio::test]
async fn logs_de_build_usam_a_fonte_de_build() {
    let h = harness().await;
    let instance = api_instance(&h).await;
    h.railway
        .with_runtime_logs(100, runtime_lines())
        .with_build_logs(100, vec![line(1, None, "npm install")]);

    let logs = h
        .logs
        .read(
            instance,
            LogsRequest {
                kind: LogKind::Build,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(logs.lines.len(), 1);
    assert_eq!(logs.lines[0].message, "npm install");
}

#[tokio::test]
async fn deploy_anterior_da_lista_nao_e_o_atual() {
    let h = harness().await;
    let instance = api_instance(&h).await;
    h.railway
        .with_history(
            10,
            20,
            vec![
                record(100, DeploymentStatus::Success, at(30)),
                record(90, DeploymentStatus::Failed, at(10)),
            ],
        )
        .with_runtime_logs(90, vec![line(1, Some(LogSeverity::Error), "crash antigo")]);

    let deployments = h.logs.deployments(instance).await.unwrap();
    assert_eq!(deployments.len(), 2);
    assert!(deployments[0].is_current && !deployments[1].is_current);

    let logs = h
        .logs
        .read(
            instance,
            LogsRequest {
                deployment_id: Some(rid::<String>(90)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(logs.deployment_id, Some(rid(90)));
    assert!(!logs.is_current);
    assert_eq!(logs.lines[0].message, "crash antigo");
}

#[tokio::test]
async fn deploy_de_outra_instancia_e_recusado_sem_consultar_logs() {
    let h = harness().await;
    let instance = api_instance(&h).await;
    h.railway.with_runtime_logs(102, runtime_lines()); // api@staging

    let err = h
        .logs
        .read(
            instance,
            LogsRequest {
                deployment_id: Some(rid::<String>(102)),
                ..Default::default()
            },
        )
        .await
        .unwrap_err();
    assert!(matches!(err, AppError::Unprocessable(_)), "{err:?}");
    assert!(
        !h.railway
            .calls()
            .iter()
            .any(|c| c.starts_with("deployment_logs")),
        "não deve ler logs de um deploy alheio"
    );
}

#[tokio::test]
async fn instancia_sem_deploy_devolve_lista_vazia() {
    let h = harness().await;
    let instance = api_instance(&h).await;
    h.railway.with_history(10, 20, vec![]);

    let logs = h.logs.read(instance, LogsRequest::default()).await.unwrap();
    assert_eq!(logs.deployment_id, None);
    assert!(logs.lines.is_empty() && !logs.truncated);
}

#[tokio::test]
async fn filtra_por_severidade_e_texto() {
    let h = harness().await;
    let instance = api_instance(&h).await;
    h.railway.with_runtime_logs(100, runtime_lines());

    let only_errors = h
        .logs
        .read(
            instance,
            LogsRequest {
                severities: vec![LogSeverity::Error],
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(only_errors.lines.len(), 1);
    assert_eq!(only_errors.lines[0].severity, Some(LogSeverity::Error));

    let searched = h
        .logs
        .read(
            instance,
            LogsRequest {
                search: Some("LENTO".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(searched.lines.len(), 1);
    assert_eq!(searched.lines[0].message, "lento");
}

#[tokio::test]
async fn parametros_invalidos_sao_recusados_antes_do_railway() {
    let h = harness().await;
    let instance = api_instance(&h).await;
    h.railway.with_runtime_logs(100, runtime_lines());
    let before = h.railway.calls().len();

    let bad = [
        LogsRequest {
            limit: Some(5000),
            ..Default::default()
        },
        LogsRequest {
            limit: Some(0),
            ..Default::default()
        },
        LogsRequest {
            start: Some("ontem".into()),
            ..Default::default()
        },
        LogsRequest {
            start: Some("2026-11-18T11:00:00Z".into()),
            end: Some("2026-11-18T10:00:00Z".into()),
            ..Default::default()
        },
        LogsRequest {
            deployment_id: Some("não-é-uuid".into()),
            ..Default::default()
        },
    ];
    for request in bad {
        let err = h.logs.read(instance, request.clone()).await.unwrap_err();
        assert!(
            matches!(err, AppError::Validation(_)),
            "{request:?}: {err:?}"
        );
    }
    assert_eq!(
        h.railway.calls().len(),
        before,
        "nenhuma chamada ao Railway"
    );
}

#[tokio::test]
async fn resultado_acima_do_limite_vem_truncado_com_as_mais_recentes() {
    let h = harness().await;
    let instance = api_instance(&h).await;
    let many: Vec<_> = (0..10)
        .map(|i| line(i, None, &format!("linha {i}")))
        .collect();
    h.railway.with_runtime_logs(100, many);

    let logs = h
        .logs
        .read(
            instance,
            LogsRequest {
                limit: Some(3),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert!(logs.truncated);
    let messages: Vec<_> = logs.lines.iter().map(|l| l.message.as_str()).collect();
    assert_eq!(messages, ["linha 7", "linha 8", "linha 9"]);
}

#[tokio::test]
async fn instancia_desconhecida_e_nao_encontrada_e_leitura_nao_cria_operacao() {
    let h = harness().await;
    let instance = api_instance(&h).await;
    h.railway.with_runtime_logs(100, runtime_lines());
    h.logs.read(instance, LogsRequest::default()).await.unwrap();

    let err = h
        .logs
        .read(rid(999), LogsRequest::default())
        .await
        .unwrap_err();
    assert!(matches!(err, AppError::NotFound(_)), "{err:?}");
    let operations: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM operations")
        .fetch_one(&h.pool)
        .await
        .unwrap();
    assert_eq!(operations, 0);
}
