//! O binário deve recusar iniciar com configuração inválida, explicando o motivo.

use std::process::{Command, Output};

fn run(vars: &[(&str, &str)]) -> Output {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_railway-manager"));
    for (key, _) in std::env::vars() {
        if key.starts_with("RM_") {
            cmd.env_remove(key);
        }
    }
    cmd.envs(vars.iter().copied())
        .output()
        .expect("executa o binário")
}

#[test]
fn sem_senha_encerra_com_mensagem() {
    let out = run(&[]);
    assert_eq!(out.status.code(), Some(2));
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("RM_ADMIN_PASSWORD"), "{stderr}");
}

#[test]
fn master_key_invalida_encerra_com_mensagem() {
    let out = run(&[("RM_ADMIN_PASSWORD", "x"), ("RM_MASTER_KEY", "curta")]);
    assert_eq!(out.status.code(), Some(2));
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("RM_MASTER_KEY"), "{stderr}");
}
