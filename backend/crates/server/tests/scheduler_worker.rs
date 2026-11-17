//! O worker do agendador, subindo com o estado completo, processa um evento sozinho.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use application::credentials::RegisterCredential;
use application::inventory::InstanceRef;
use application::railway::RailwayToken;
use application::schedules::spec;
use application::testkit::{FakeRailway, rid};
use chrono::{Timelike, Utc};
use domain::credential::CredentialKind;
use domain::schedule::{LocalTime, RunStatus, Weekdays, Window};
use railway_manager::config::Config;

const TOKEN: &str = "tok-worker-0123456789";

#[tokio::test]
async fn worker_processa_evento_no_horario() {
    let vars: HashMap<&str, &str> = [
        ("RM_ADMIN_PASSWORD", "x"),
        (
            "RM_MASTER_KEY",
            "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
        ),
        ("RM_SCHEDULER_TICK_SECS", "1"),
        ("RM_SCHEDULE_TIMEZONE", "UTC"),
        ("RM_POLL_INTERVAL_SECS", "1"),
        ("RM_POLL_MAX_INTERVAL_SECS", "1"),
    ]
    .into_iter()
    .collect();
    let config = Config::from_lookup(|k| vars.get(k).map(|v| v.to_string())).unwrap();
    let pool = infrastructure::sqlite::connect("sqlite::memory:")
        .await
        .unwrap();
    let railway = Arc::new(FakeRailway::new());
    railway
        .accept_token(TOKEN)
        .with_account("Ana", "ana@example.com", &[(900, "pessoal")])
        .add_project(1, "loja", Some(900))
        .add_environment(1, 10, "production", false)
        .add_service(1, 21, "worker")
        .add_stopped(1, 10, 21, 101);
    let state = railway_manager::build_state(&config, pool.clone(), railway.clone());

    state
        .credentials
        .register(RegisterCredential {
            kind: CredentialKind::Account,
            workspace_id: None,
            token: RailwayToken::new(TOKEN),
        })
        .await
        .unwrap();
    let project = state
        .projects
        .register(&rid::<String>(1), None)
        .await
        .unwrap()
        .id;
    state
        .inventory
        .import(
            project,
            &[InstanceRef {
                environment_id: rid(10),
                service_id: rid(21),
            }],
        )
        .await
        .unwrap();

    // Janela começando no minuto atual (UTC).
    let now = Utc::now();
    let floor = now.with_second(0).unwrap().with_nanosecond(0).unwrap();
    let start = LocalTime::from_minutes((floor.hour() * 60 + floor.minute()) as u16).unwrap();
    let end =
        LocalTime::from_minutes(((floor.hour() * 60 + floor.minute() + 60) % 1440) as u16).unwrap();
    let schedule = state
        .schedules
        .create(
            project,
            spec(
                "worker".into(),
                chrono_tz::UTC,
                Weekdays::ALL,
                vec![Window { start, end }],
                None,
                None,
            ),
        )
        .await
        .unwrap()
        .schedule
        .id;
    // Vigência e última avaliação logo antes do início da janela.
    let before =
        (floor - chrono::Duration::seconds(1)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    sqlx::query("UPDATE schedules SET effective_from = ? WHERE id = ?")
        .bind(&before)
        .bind(schedule.to_string())
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO scheduler_state (id, last_evaluated_at) VALUES (1, ?)")
        .bind(&before)
        .execute(&pool)
        .await
        .unwrap();

    let worker = railway_manager::spawn_scheduler(state.scheduler.clone(), state.clock.clone());
    let mut run = None;
    for _ in 0..50 {
        tokio::time::sleep(Duration::from_millis(100)).await;
        let latest = state
            .schedules
            .runs(schedule, None, None)
            .await
            .unwrap()
            .items
            .into_iter()
            .next();
        if let Some(r) = latest.filter(|r| r.status != RunStatus::Pending) {
            run = Some(r);
            break;
        }
    }
    worker.abort();
    let run = run.expect("o worker não processou o evento");
    assert!(
        matches!(run.status, RunStatus::Executed | RunStatus::Late),
        "{run:?}"
    );
    assert!(run.operation_id.is_some());
    state.power.wait_idle().await;
    assert_eq!(
        railway.mutation_calls(),
        [format!("deploymentRedeploy({})", rid::<String>(101))]
    );
}
