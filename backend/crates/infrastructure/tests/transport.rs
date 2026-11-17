//! Transporte Railway contra um servidor simulado: classificação de erros,
//! retry só para queries e respeito ao rate limit.

use std::time::{Duration, Instant};

use application::railway::{RailwayError, RailwayToken};
use infrastructure::railway::ops::{self, DeploymentRemove};
use infrastructure::railway::{Transport, TransportConfig};
use serde_json::{Value, json};
use wiremock::matchers::{body_string_contains, header, method};
use wiremock::{Mock, MockServer, ResponseTemplate};

const DEPLOYMENT_ID: &str = "00000000-0000-4000-8000-000000000001";

fn token() -> RailwayToken {
    RailwayToken::new("tok-super-secreto-123")
}

fn transport(server: &MockServer) -> Transport {
    let mut config = TransportConfig::new(server.uri());
    config.request_timeout = Duration::from_millis(300);
    config.retry_base = Duration::from_millis(1);
    config.max_retries = 2;
    config.rps = 100;
    Transport::new(config).unwrap()
}

async fn query(t: &Transport) -> Result<ops::deployment::ResponseData, RailwayError> {
    t.execute::<ops::Deployment>(
        &token(),
        ops::deployment::Variables {
            id: DEPLOYMENT_ID.into(),
        },
    )
    .await
}

async fn mutation(t: &Transport) -> Result<ops::deployment_remove::ResponseData, RailwayError> {
    t.execute::<DeploymentRemove>(
        &token(),
        ops::deployment_remove::Variables {
            id: DEPLOYMENT_ID.into(),
        },
    )
    .await
}

fn deployment_ok() -> Value {
    json!({ "data": { "deployment": {
        "id": DEPLOYMENT_ID, "status": "SUCCESS", "canRedeploy": true, "deploymentStopped": false
    }}})
}

fn graphql_error(message: &str, code: Option<&str>) -> Value {
    let mut error = json!({ "message": message });
    if let Some(code) = code {
        error["extensions"] = json!({ "code": code });
    }
    json!({ "data": null, "errors": [error] })
}

async fn mount(server: &MockServer, response: ResponseTemplate, times: u64) {
    Mock::given(method("POST"))
        .respond_with(response)
        .expect(times)
        .mount(server)
        .await;
}

#[tokio::test]
async fn sucesso_envia_bearer_e_decodifica() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(header("authorization", "Bearer tok-super-secreto-123"))
        .and(body_string_contains("\"operationName\":\"Deployment\""))
        .respond_with(ResponseTemplate::new(200).set_body_json(deployment_ok()))
        .expect(1)
        .mount(&server)
        .await;

    let data = query(&transport(&server)).await.unwrap();
    assert_eq!(data.deployment.id, DEPLOYMENT_ID);
    assert!(data.deployment.can_redeploy);
}

#[tokio::test]
async fn http_200_com_erro_de_autorizacao_e_falha() {
    let server = MockServer::start().await;
    let body = graphql_error("Not Authorized", None);
    mount(&server, ResponseTemplate::new(200).set_body_json(body), 1).await;
    assert_eq!(
        query(&transport(&server)).await.unwrap_err(),
        RailwayError::Unauthorized
    );
}

#[tokio::test]
async fn http_200_com_recurso_inexistente() {
    let server = MockServer::start().await;
    let body = graphql_error("Deployment not found", None);
    mount(&server, ResponseTemplate::new(200).set_body_json(body), 1).await;
    let err = query(&transport(&server)).await.unwrap_err();
    assert_eq!(err, RailwayError::NotFound("Deployment not found".into()));
}

#[tokio::test]
async fn http_400_de_validacao() {
    let server = MockServer::start().await;
    let body = graphql_error("Unknown argument", Some("GRAPHQL_VALIDATION_FAILED"));
    mount(&server, ResponseTemplate::new(400).set_body_json(body), 1).await;
    let err = query(&transport(&server)).await.unwrap_err();
    assert_eq!(err, RailwayError::Validation("Unknown argument".into()));
}

#[tokio::test]
async fn http_401_e_403_sao_nao_autorizados() {
    for status in [401, 403] {
        let server = MockServer::start().await;
        mount(&server, ResponseTemplate::new(status), 1).await;
        assert_eq!(
            query(&transport(&server)).await.unwrap_err(),
            RailwayError::Unauthorized
        );
    }
}

#[tokio::test]
async fn mensagem_do_railway_nao_vaza_o_token() {
    let server = MockServer::start().await;
    let body = graphql_error("token tok-super-secreto-123 rejected", Some("INTERNAL"));
    mount(&server, ResponseTemplate::new(200).set_body_json(body), 1).await;
    let err = query(&transport(&server)).await.unwrap_err();
    assert_eq!(
        err,
        RailwayError::Unknown("token [REDACTED] rejected".into())
    );
}

#[tokio::test]
async fn query_5xx_e_repetida_ate_o_limite() {
    let server = MockServer::start().await;
    // 1 tentativa + 2 retries.
    mount(&server, ResponseTemplate::new(503), 3).await;
    let err = query(&transport(&server)).await.unwrap_err();
    assert_eq!(err, RailwayError::Unavailable("HTTP 503".into()));
}

#[tokio::test]
async fn query_recupera_apos_falha_transitoria() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(502))
        .up_to_n_times(1)
        .expect(1)
        .mount(&server)
        .await;
    mount(
        &server,
        ResponseTemplate::new(200).set_body_json(deployment_ok()),
        1,
    )
    .await;
    assert!(query(&transport(&server)).await.is_ok());
}

#[tokio::test]
async fn query_com_timeout_e_repetida_e_vira_indisponivel() {
    let server = MockServer::start().await;
    let slow = ResponseTemplate::new(200)
        .set_body_json(deployment_ok())
        .set_delay(Duration::from_secs(2));
    mount(&server, slow, 3).await;
    let err = query(&transport(&server)).await.unwrap_err();
    assert!(matches!(err, RailwayError::Unavailable(_)), "{err:?}");
}

#[tokio::test]
async fn mutation_5xx_nunca_e_reenviada() {
    let server = MockServer::start().await;
    mount(&server, ResponseTemplate::new(500), 1).await;
    let err = mutation(&transport(&server)).await.unwrap_err();
    assert!(matches!(err, RailwayError::Unavailable(_)));
}

#[tokio::test]
async fn mutation_com_timeout_e_resultado_incerto_sem_reenvio() {
    let server = MockServer::start().await;
    let slow = ResponseTemplate::new(200)
        .set_body_json(json!({ "data": { "deploymentRemove": true } }))
        .set_delay(Duration::from_secs(2));
    mount(&server, slow, 1).await;
    let err = mutation(&transport(&server)).await.unwrap_err();
    assert_eq!(err, RailwayError::Uncertain("DeploymentRemove".into()));
}

#[tokio::test]
async fn sem_conexao_e_indisponivel() {
    let mut config = TransportConfig::new("http://127.0.0.1:9");
    config.retry_base = Duration::from_millis(1);
    config.max_retries = 1;
    let t = Transport::new(config).unwrap();
    let err = query(&t).await.unwrap_err();
    assert!(matches!(err, RailwayError::Unavailable(_)), "{err:?}");
}

#[tokio::test]
async fn http_429_bloqueia_novas_chamadas_pelo_retry_after() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(429).insert_header("retry-after", "1"))
        .up_to_n_times(1)
        .expect(1)
        .mount(&server)
        .await;
    mount(
        &server,
        ResponseTemplate::new(200).set_body_json(deployment_ok()),
        1,
    )
    .await;

    let t = transport(&server);
    // Mutation recebe 429 e não é reenviada.
    let err = mutation(&t).await.unwrap_err();
    assert_eq!(
        err,
        RailwayError::RateLimited {
            retry_after_secs: 1
        }
    );
    assert!(t.rate_limit_status().paused_until.is_some());

    // A próxima chamada aguarda a pausa em vez de falhar.
    let start = Instant::now();
    query(&t).await.unwrap();
    assert!(
        start.elapsed() >= Duration::from_millis(900),
        "{:?}",
        start.elapsed()
    );
}

#[tokio::test]
async fn query_com_429_aguarda_e_repete() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(429).insert_header("retry-after", "1"))
        .up_to_n_times(1)
        .expect(1)
        .mount(&server)
        .await;
    mount(
        &server,
        ResponseTemplate::new(200).set_body_json(deployment_ok()),
        1,
    )
    .await;
    let start = Instant::now();
    query(&transport(&server)).await.unwrap();
    assert!(start.elapsed() >= Duration::from_millis(900));
}

#[tokio::test]
async fn cota_zerada_e_exposta_e_pausa() {
    let server = MockServer::start().await;
    let response = ResponseTemplate::new(200)
        .set_body_json(deployment_ok())
        .insert_header("x-ratelimit-remaining", "0")
        .insert_header("x-ratelimit-limit", "1000")
        .insert_header("x-ratelimit-reset", "1");
    mount(&server, response, 2).await;
    let t = transport(&server);
    query(&t).await.unwrap();
    let status = t.rate_limit_status();
    assert_eq!((status.remaining, status.limit), (Some(0), Some(1000)));
    assert!(status.paused_until.is_some());
    let start = Instant::now();
    query(&t).await.unwrap();
    assert!(start.elapsed() >= Duration::from_millis(900));
}
