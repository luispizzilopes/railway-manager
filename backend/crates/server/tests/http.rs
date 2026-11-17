//! API HTTP de ponta a ponta (roteador real, SQLite em memória, Railway falso).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use application::railway::RailwayError;
use application::testkit::{FakeRailway, rid};
use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode, header};
use railway_manager::config::Config;
use serde_json::{Value, json};
use tower::ServiceExt;

const TOKEN: &str = "tok-http-0123456789abcdef";
const PASSWORD: &str = "senha-do-admin";

struct App {
    router: Router,
    railway: Arc<FakeRailway>,
    cookie: Mutex<Option<String>>,
    /// Todos os corpos de resposta, para provar que o token nunca sai.
    bodies: Mutex<Vec<String>>,
    _frontend: tempfile::TempDir,
}

struct Reply {
    status: StatusCode,
    headers: axum::http::HeaderMap,
    json: Value,
    text: String,
}

async fn app_with(extra: &[(&str, &str)]) -> App {
    let mut vars: HashMap<String, String> = [
        ("RM_ADMIN_PASSWORD", PASSWORD),
        (
            "RM_MASTER_KEY",
            "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
        ),
        ("RM_LOGIN_MAX_ATTEMPTS", "3"),
        ("RM_START_TIMEOUT_SECS", "2"),
        ("RM_STOP_TIMEOUT_SECS", "2"),
        ("RM_POLL_INTERVAL_SECS", "1"),
        ("RM_POLL_MAX_INTERVAL_SECS", "1"),
    ]
    .iter()
    .map(|(k, v)| (k.to_string(), v.to_string()))
    .collect();
    for (k, v) in extra {
        vars.insert(k.to_string(), v.to_string());
    }
    let config = Config::from_lookup(|k| vars.get(k).cloned()).unwrap();
    let pool = infrastructure::sqlite::connect("sqlite::memory:")
        .await
        .unwrap();
    let railway = Arc::new(FakeRailway::new());
    railway
        .accept_token(TOKEN)
        .with_account("Ana", "ana@example.com", &[(900, "pessoal")]);
    let state = railway_manager::build_state(&config, pool, railway.clone());

    let frontend = tempfile::tempdir().unwrap();
    std::fs::write(
        frontend.path().join("index.html"),
        "<!doctype html><title>Railway Manager</title>",
    )
    .unwrap();
    std::fs::create_dir_all(frontend.path().join("assets")).unwrap();
    std::fs::write(frontend.path().join("assets/app.js"), "console.log(1)").unwrap();
    App {
        router: api::router(state, Some(frontend.path())),
        railway,
        cookie: Mutex::new(None),
        bodies: Mutex::new(vec![]),
        _frontend: frontend,
    }
}

async fn app() -> App {
    app_with(&[]).await
}

impl App {
    async fn call(&self, method: &str, path: &str, body: Option<Value>) -> Reply {
        let mut req = Request::builder().method(method).uri(path);
        if let Some(cookie) = self.cookie.lock().unwrap().clone() {
            req = req.header(header::COOKIE, cookie);
        }
        let body = match body {
            Some(json) => {
                req = req.header(header::CONTENT_TYPE, "application/json");
                Body::from(json.to_string())
            }
            None if method != "GET" => {
                req = req.header(header::CONTENT_TYPE, "application/json");
                Body::empty()
            }
            None => Body::empty(),
        };
        let response = self
            .router
            .clone()
            .oneshot(req.body(body).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let text = String::from_utf8_lossy(&bytes).to_string();
        self.bodies.lock().unwrap().push(text.clone());
        Reply {
            status,
            headers,
            json: serde_json::from_str(&text).unwrap_or(Value::Null),
            text,
        }
    }

    async fn get(&self, path: &str) -> Reply {
        self.call("GET", path, None).await
    }

    async fn post(&self, path: &str, body: Value) -> Reply {
        self.call("POST", path, Some(body)).await
    }

    async fn login(&self) {
        let reply = self
            .post("/api/session", json!({ "password": PASSWORD }))
            .await;
        assert_eq!(reply.status, StatusCode::NO_CONTENT);
        let cookie = reply.headers[header::SET_COOKIE].to_str().unwrap();
        let pair = cookie.split(';').next().unwrap().to_owned();
        *self.cookie.lock().unwrap() = Some(pair);
    }

    async fn with_credential(&self) {
        self.login().await;
        let reply = self
            .call(
                "PUT",
                "/api/credential",
                Some(json!({ "kind": "account", "token": TOKEN })),
            )
            .await;
        assert_eq!(reply.status, StatusCode::OK, "{}", reply.text);
    }

    fn assert_token_never_leaked(&self) {
        for body in self.bodies.lock().unwrap().iter() {
            assert!(!body.contains(TOKEN), "token vazou em: {body}");
        }
    }

    /// Projeto `loja` cadastrado com api@production (running), worker@production (stopped).
    async fn seed(&self) -> String {
        self.railway
            .add_project(1, "loja", Some(900))
            .add_environment(1, 10, "production", false)
            .add_service(1, 20, "api")
            .add_service(1, 21, "worker")
            .add_running(1, 10, 20, 100)
            .add_stopped(1, 10, 21, 101);
        let reply = self
            .post(
                "/api/projects",
                json!({ "railway_project_id": rid::<String>(1) }),
            )
            .await;
        assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.text);
        let project = reply.json["project"]["id"].as_str().unwrap().to_owned();
        let reply = self
            .post(
                &format!("/api/projects/{project}/instances/import"),
                json!({ "instances": [
                    { "environment_id": rid::<String>(10), "service_id": rid::<String>(20) },
                    { "environment_id": rid::<String>(10), "service_id": rid::<String>(21) }
                ]}),
            )
            .await;
        assert_eq!(reply.status, StatusCode::OK, "{}", reply.text);
        project
    }

    async fn wait_operation(&self, id: &str) -> Value {
        for _ in 0..100 {
            let reply = self.get(&format!("/api/operations/{id}")).await;
            if reply.json["done"] == json!(true) {
                return reply.json;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("operação não terminou");
    }
}

// ---------- 5.3 acesso ----------

#[tokio::test]
async fn rotas_protegidas_exigem_sessao() {
    let app = app().await;
    for path in [
        "/api/dashboard",
        "/api/projects",
        "/api/credential",
        "/api/history",
        "/api/session",
    ] {
        let reply = app.get(path).await;
        assert_eq!(reply.status, StatusCode::UNAUTHORIZED, "{path}");
        assert_eq!(reply.json["code"], "unauthorized");
    }
    assert_eq!(app.get("/healthz").await.status, StatusCode::OK);
}

#[tokio::test]
async fn login_logout_e_cookie_seguro() {
    let app = app_with(&[("RM_COOKIE_SECURE", "true")]).await;
    let wrong = app
        .post("/api/session", json!({ "password": "errada" }))
        .await;
    assert_eq!(wrong.status, StatusCode::UNAUTHORIZED);
    assert_eq!(wrong.json["message"], "senha incorreta");

    let ok = app
        .post("/api/session", json!({ "password": PASSWORD }))
        .await;
    let cookie = ok.headers[header::SET_COOKIE].to_str().unwrap().to_owned();
    for part in ["rm_session=", "HttpOnly", "SameSite=Strict", "Secure"] {
        assert!(cookie.contains(part), "{cookie}");
    }
    *app.cookie.lock().unwrap() = Some(cookie.split(';').next().unwrap().to_owned());
    assert_eq!(app.get("/api/session").await.status, StatusCode::OK);

    let out = app.call("DELETE", "/api/session", None).await;
    assert_eq!(out.status, StatusCode::NO_CONTENT);
    assert!(
        out.headers[header::SET_COOKIE]
            .to_str()
            .unwrap()
            .contains("Max-Age=0")
    );
    assert_eq!(
        app.get("/api/session").await.status,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn excesso_de_tentativas_responde_429() {
    let app = app().await;
    for _ in 0..3 {
        assert_eq!(
            app.post("/api/session", json!({ "password": "x" }))
                .await
                .status,
            StatusCode::UNAUTHORIZED
        );
    }
    let blocked = app
        .post("/api/session", json!({ "password": PASSWORD }))
        .await;
    assert_eq!(blocked.status, StatusCode::TOO_MANY_REQUESTS);
    assert!(blocked.headers.contains_key(header::RETRY_AFTER));
}

#[tokio::test]
async fn mutacoes_exigem_json() {
    let app = app().await;
    app.login().await;
    let req = Request::builder()
        .method("POST")
        .uri("/api/projects")
        .header(header::COOKIE, app.cookie.lock().unwrap().clone().unwrap())
        .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
        .body(Body::from("railway_project_id=x"))
        .unwrap();
    let response = app.router.clone().oneshot(req).await.unwrap();
    assert_eq!(response.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
}

// ---------- 6.3 credencial, projetos e instâncias ----------

#[tokio::test]
async fn credencial_via_http_nunca_devolve_o_token() {
    let app = app().await;
    app.login().await;
    assert_eq!(
        app.get("/api/credential").await.json,
        json!({ "credential": null })
    );

    let project = app
        .call(
            "PUT",
            "/api/credential",
            Some(json!({ "kind": "project", "token": TOKEN })),
        )
        .await;
    assert_eq!(project.status, StatusCode::UNPROCESSABLE_ENTITY);
    let bad = app
        .call(
            "PUT",
            "/api/credential",
            Some(json!({ "kind": "account", "token": "tok-ruim-0000" })),
        )
        .await;
    assert_eq!(bad.status, StatusCode::UNPROCESSABLE_ENTITY);
    app.railway
        .fail_next("me", RailwayError::Unavailable("x".into()));
    let down = app
        .call(
            "PUT",
            "/api/credential",
            Some(json!({ "kind": "account", "token": TOKEN })),
        )
        .await;
    assert_eq!(down.status, StatusCode::SERVICE_UNAVAILABLE);
    let missing_ws = app
        .call(
            "PUT",
            "/api/credential",
            Some(json!({ "kind": "workspace", "token": TOKEN })),
        )
        .await;
    assert_eq!(missing_ws.status, StatusCode::BAD_REQUEST);

    let ok = app
        .call(
            "PUT",
            "/api/credential",
            Some(json!({ "kind": "account", "token": TOKEN })),
        )
        .await;
    assert_eq!(ok.status, StatusCode::OK);
    assert_eq!(ok.json["credential"]["masked_suffix"], "cdef");
    assert_eq!(ok.json["credential"]["kind"], "account");
    let get = app.get("/api/credential").await;
    assert_eq!(get.json["credential"]["label"], "Ana <ana@example.com>");

    assert_eq!(
        app.call("DELETE", "/api/credential", None).await.status,
        StatusCode::NO_CONTENT
    );
    let after = app
        .post(
            "/api/projects",
            json!({ "railway_project_id": rid::<String>(1) }),
        )
        .await;
    assert_eq!(after.status, StatusCode::CONFLICT);
    assert_eq!(after.json["code"], "integration_not_configured");
    app.assert_token_never_leaked();
}

#[tokio::test]
async fn projetos_e_instancias_via_http() {
    let app = app().await;
    app.with_credential().await;
    app.railway.add_project(2, "blog", Some(900));
    let project = app.seed().await;

    let discovered = app.get("/api/railway/projects").await;
    let names: Vec<_> = discovered.json["workspaces"][0]["projects"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| {
            (
                p["project"]["name"].as_str().unwrap().to_owned(),
                p["managed"].as_bool().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        names,
        [("blog".to_string(), false), ("loja".to_string(), true)]
    );

    let dup = app
        .post(
            "/api/projects",
            json!({ "railway_project_id": rid::<String>(1) }),
        )
        .await;
    assert_eq!(dup.status, StatusCode::CONFLICT);
    let invalid = app
        .post("/api/projects", json!({ "railway_project_id": "abc" }))
        .await;
    assert_eq!(invalid.status, StatusCode::BAD_REQUEST);
    let malformed = app.post("/api/projects", json!({ "nome": 1 })).await;
    assert_eq!(malformed.status, StatusCode::BAD_REQUEST);
    let import = app
        .post(
            "/api/projects/import",
            json!({ "railway_project_ids": [rid::<String>(1), rid::<String>(2)] }),
        )
        .await;
    assert_eq!(import.json["already_managed"], json!([rid::<String>(1)]));
    assert_eq!(import.json["imported"][0]["name"], "blog");

    let edited = app
        .call(
            "PATCH",
            &format!("/api/projects/{project}"),
            Some(json!({ "display_name": "Loja", "description": "e-commerce" })),
        )
        .await;
    assert_eq!(edited.json["project"]["display_name"], "Loja");
    assert_eq!(
        app.get("/api/projects").await.json["projects"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let synced = app
        .post(&format!("/api/projects/{project}/sync"), json!({}))
        .await;
    assert_eq!(synced.json["project"]["sync_status"], "ok");

    let envs = app
        .get(&format!("/api/projects/{project}/railway-instances"))
        .await;
    assert_eq!(
        envs.json["environments"][0]["instances"][0]["managed"],
        true
    );
    let dup = app
        .post(
            &format!("/api/projects/{project}/instances"),
            json!({ "environment_id": rid::<String>(10), "service_id": rid::<String>(20) }),
        )
        .await;
    assert_eq!(dup.status, StatusCode::CONFLICT);
    let foreign = app
        .post(
            &format!("/api/projects/{project}/instances"),
            json!({ "environment_id": rid::<String>(10), "service_id": rid::<String>(77) }),
        )
        .await;
    assert_eq!(foreign.status, StatusCode::UNPROCESSABLE_ENTITY);

    let instances = app.get(&format!("/api/projects/{project}/instances")).await;
    let list = instances.json["instances"].as_array().unwrap();
    assert_eq!(list.len(), 2);
    let worker = list
        .iter()
        .find(|i| i["service"]["name"] == "worker")
        .unwrap()["instance"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        app.call("DELETE", &format!("/api/instances/{worker}"), None)
            .await
            .status,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        app.call("DELETE", &format!("/api/instances/{worker}"), None)
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        app.get("/api/projects/nao-existe").await.status,
        StatusCode::NOT_FOUND
    );

    assert_eq!(
        app.call("DELETE", &format!("/api/projects/{project}"), None)
            .await
            .status,
        StatusCode::NO_CONTENT
    );
    app.assert_token_never_leaked();
}

// ---------- 7.4 operações ----------

#[tokio::test]
async fn fluxo_de_plano_e_execucao() {
    let app = app().await;
    app.with_credential().await;
    let project = app.seed().await;

    let plan = app
        .post(
            "/api/operations/plan",
            json!({ "kind": "stop", "target": { "type": "project", "project_id": project } }),
        )
        .await;
    assert_eq!(plan.status, StatusCode::OK, "{}", plan.text);
    let mut actions: Vec<_> = plan.json["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| {
            (
                e["service_name"].as_str().unwrap().to_owned(),
                e["action"].as_str().unwrap().to_owned(),
            )
        })
        .collect();
    actions.sort();
    assert_eq!(
        actions,
        [
            ("api".into(), "will_stop".into()),
            ("worker".into(), "will_skip".into())
        ]
    );
    let worker = plan.json["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["service_name"] == "worker")
        .unwrap();
    assert_eq!(worker["reason"], "já está no estado desejado");
    assert_eq!(worker["reason_code"], "already_in_desired_state");

    assert_eq!(
        app.post("/api/operations", json!({})).await.status,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        app.post("/api/operations", json!({ "plan_id": "x" }))
            .await
            .status,
        StatusCode::BAD_REQUEST
    );

    let plan_id = plan.json["plan_id"].as_str().unwrap();
    let accepted = app
        .post("/api/operations", json!({ "plan_id": plan_id }))
        .await;
    assert_eq!(accepted.status, StatusCode::ACCEPTED);
    let operation = accepted.json["operation_id"].as_str().unwrap().to_owned();

    let again = app
        .post("/api/operations", json!({ "plan_id": plan_id }))
        .await;
    assert_eq!(again.status, StatusCode::CONFLICT);
    assert_eq!(again.json["details"]["operation_id"], operation);

    let done = app.wait_operation(&operation).await;
    assert_eq!(done["operation"]["status"], "succeeded");
    let results: Vec<_> = done["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["result"].as_str().unwrap())
        .collect();
    assert_eq!(results, ["succeeded", "skipped"]);
    assert_eq!(
        app.get("/api/operations/00000000-0000-4000-8000-000000000999")
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    app.assert_token_never_leaked();
}

#[tokio::test]
async fn plano_expirado_responde_410() {
    let app = app_with(&[("RM_PLAN_TTL_SECS", "1")]).await;
    app.with_credential().await;
    let project = app.seed().await;
    let plan = app
        .post(
            "/api/operations/plan",
            json!({ "kind": "start", "target": { "type": "batch", "project_ids": [project] } }),
        )
        .await;
    tokio::time::sleep(Duration::from_millis(1100)).await;
    let expired = app
        .post(
            "/api/operations",
            json!({ "plan_id": plan.json["plan_id"] }),
        )
        .await;
    assert_eq!(expired.status, StatusCode::GONE);
    assert_eq!(expired.json["code"], "plan_expired");
}

// ---------- 8.1 histórico ----------

#[tokio::test]
async fn historico_com_filtros_e_paginacao() {
    let app = app().await;
    app.with_credential().await;
    let project = app.seed().await;
    for kind in ["stop", "start"] {
        let plan = app
            .post(
                "/api/operations/plan",
                json!({ "kind": kind, "target": { "type": "project", "project_id": project } }),
            )
            .await;
        let op = app
            .post(
                "/api/operations",
                json!({ "plan_id": plan.json["plan_id"] }),
            )
            .await;
        app.wait_operation(op.json["operation_id"].as_str().unwrap())
            .await;
    }

    let all = app.get("/api/history").await;
    assert_eq!(all.json["total"], 4);
    let first = &all.json["items"][0];
    assert_eq!(first["kind"], "start", "mais recente primeiro");

    let loja = rid::<String>(1);
    let stops = app
        .get(&format!(
            "/api/history?project={loja}&kind=stop&result=succeeded&from=2000-01-01&to=2999-12-31"
        ))
        .await;
    assert_eq!(stops.json["total"], 1, "{}", stops.text);
    assert_eq!(
        stops.json["items"][0]["item"]["label"]["service_name"],
        "api"
    );

    let paged = app.get("/api/history?per_page=1&page=2").await;
    assert_eq!(
        (
            paged.json["items"].as_array().unwrap().len(),
            paged.json["page"].as_u64()
        ),
        (1, Some(2))
    );

    let inverted = app.get("/api/history?from=2026-02-01&to=2026-01-01").await;
    assert_eq!(inverted.status, StatusCode::BAD_REQUEST);
    assert_eq!(
        app.get("/api/history?kind=pause").await.status,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        app.get("/api/history?from=ontem").await.status,
        StatusCode::BAD_REQUEST
    );
}

// ---------- 8.2 dashboard ----------

#[tokio::test]
async fn dashboard_conta_estados_do_cenario_da_spec() {
    let app = app().await;
    app.with_credential().await;
    // 2 projetos, 5 instâncias: 3 running, 1 stopped, 1 failed.
    app.railway
        .add_project(1, "loja", Some(900))
        .add_environment(1, 10, "production", false)
        .add_service(1, 20, "api")
        .add_service(1, 21, "worker")
        .add_service(1, 22, "web")
        .add_running(1, 10, 20, 100)
        .add_running(1, 10, 21, 101)
        .add_stopped(1, 10, 22, 102)
        .add_project(2, "blog", Some(900))
        .add_environment(2, 30, "production", false)
        .add_service(2, 40, "site")
        .add_service(2, 41, "cron")
        .add_running(2, 30, 40, 200);
    let crashed = domain::deployment::Deployment {
        id: rid(201),
        status: domain::deployment::DeploymentStatus::Crashed,
        can_redeploy: true,
        stopped: false,
    };
    app.railway.add_instance(
        2,
        30,
        41,
        domain::state::InstanceSnapshot {
            deleted: false,
            latest: Some(crashed),
            active: vec![],
        },
    );

    for (n, envs) in [
        (1, vec![(10, 20), (10, 21), (10, 22)]),
        (2, vec![(30, 40), (30, 41)]),
    ] {
        let created = app
            .post(
                "/api/projects",
                json!({ "railway_project_id": rid::<String>(n) }),
            )
            .await;
        let id = created.json["project"]["id"].as_str().unwrap().to_owned();
        let instances: Vec<_> = envs
            .iter()
            .map(|(e, s)| json!({ "environment_id": rid::<String>(*e), "service_id": rid::<String>(*s) }))
            .collect();
        app.post(
            &format!("/api/projects/{id}/instances/import"),
            json!({ "instances": instances }),
        )
        .await;
    }

    let dash = app.get("/api/dashboard").await;
    let i = &dash.json["indicators"];
    assert_eq!(
        (i["projects"].as_u64(), i["instances"].as_u64()),
        (Some(2), Some(5))
    );
    assert_eq!(
        (
            i["running"].as_u64(),
            i["stopped"].as_u64(),
            i["failed"].as_u64()
        ),
        (Some(3), Some(1), Some(1))
    );
    assert_eq!(dash.json["integration_ready"], true);
    assert_eq!(dash.json["alerts"], json!([]));
    let card = &dash.json["projects"][0]["environments"][0]["instances"][0];
    assert_eq!(card["freshness"], "fresh");

    // Railway indisponível: dados anteriores mantidos, frescor indisponível.
    app.railway.set_unavailable(true);
    let refresh = app.post("/api/dashboard/refresh", json!({})).await;
    assert_eq!(refresh.json["report"]["failed"], 5);
    let dash = app.get("/api/dashboard").await;
    let card = &dash.json["projects"][0]["environments"][0]["instances"][0];
    assert_eq!(card["freshness"], "unavailable");
    assert_eq!(dash.json["indicators"]["running"], 3);
}

#[tokio::test]
async fn dashboard_sem_credencial_alerta() {
    let app = app().await;
    app.login().await;
    let dash = app.get("/api/dashboard").await;
    assert_eq!(dash.json["integration_ready"], false);
    assert_eq!(dash.json["alerts"][0]["code"], "no_credential");
}

// ---------- 9.7 frontend estático ----------

#[tokio::test]
async fn frontend_com_fallback_spa_e_api_fora_dele() {
    let app = app().await;
    for path in ["/", "/projects/123", "/history"] {
        let reply = app.get(path).await;
        assert_eq!(reply.status, StatusCode::OK, "{path}");
        assert!(
            reply.text.contains("<title>Railway Manager</title>"),
            "{path}"
        );
    }
    assert_eq!(app.get("/assets/app.js").await.text, "console.log(1)");

    app.login().await;
    let api = app.get("/api/nao-existe").await;
    assert_eq!(api.status, StatusCode::NOT_FOUND);
    assert_eq!(api.json["code"], "not_found");
    assert!(!api.text.contains("<title>"));
}
