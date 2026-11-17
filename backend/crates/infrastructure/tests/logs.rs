//! Logs das chamadas ao Railway: operação, duração e resultado, nunca o token.

use std::io::Write;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use application::railway::{RailwayGateway, RailwayToken};
use domain::ids::RailwayDeploymentId;
use domain::power::StopMechanism;
use infrastructure::railway::{RailwayClient, Transport, TransportConfig};
use serde_json::json;
use wiremock::matchers::{body_string_contains, method};
use wiremock::{Mock, MockServer, ResponseTemplate};

const SECRET: &str = "tok-nao-pode-aparecer-0123456789";

#[derive(Clone, Default)]
struct Capture(Arc<Mutex<Vec<u8>>>);

impl Write for Capture {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[tokio::test]
async fn logs_nao_contem_token_nem_autorizacao() {
    let capture = Capture::default();
    let writer = capture.clone();
    let subscriber = tracing_subscriber::fmt()
        .with_env_filter("trace")
        .with_writer(move || writer.clone())
        .with_ansi(false)
        .finish();
    let _guard = tracing::subscriber::set_default(subscriber);

    let server = MockServer::start().await;
    let id = "00000000-0000-4000-8000-000000000001";
    Mock::given(method("POST"))
        .and(body_string_contains("\"operationName\":\"Deployment\""))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(json!({ "data": { "deployment": {
                "id": id, "status": "SUCCESS", "canRedeploy": true, "deploymentStopped": false
            }}})),
        )
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(body_string_contains("DeploymentRemove"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "data": null, "errors": [{ "message": format!("bad token {SECRET}") }]
        })))
        .mount(&server)
        .await;

    let mut config = TransportConfig::new(server.uri());
    config.retry_base = Duration::from_millis(1);
    let client = RailwayClient::new(Transport::new(config).unwrap());
    let token = RailwayToken::new(SECRET);
    let deployment = RailwayDeploymentId::parse(id).unwrap();

    client.get_deployment(&token, &deployment).await.unwrap();
    let err = client
        .stop_deployment(&token, &deployment, StopMechanism::Remove)
        .await
        .unwrap_err();
    assert!(!err.to_string().contains(SECRET), "{err}");
    assert!(!format!("{token:?}").contains(SECRET));

    let logs = String::from_utf8(capture.0.lock().unwrap().clone()).unwrap();
    assert!(logs.contains("operation=\"Deployment\""), "{logs}");
    assert!(logs.contains("operation=\"DeploymentRemove\""));
    assert!(logs.contains("duration_ms="));
    assert!(logs.contains("outcome=\"ok\""));
    for forbidden in [SECRET, "Bearer", "authorization", "Authorization"] {
        assert!(
            !logs.contains(forbidden),
            "log contém {forbidden:?}:\n{logs}"
        );
    }
}
