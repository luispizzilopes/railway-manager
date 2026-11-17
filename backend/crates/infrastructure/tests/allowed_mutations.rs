//! Guarda: os `.graphql` só podem declarar as mutations de desligar/iniciar.

use std::collections::BTreeSet;
use std::path::Path;

const ALLOWED: [&str; 3] = ["deploymentRemove", "deploymentStop", "deploymentRedeploy"];

/// Remove comentários (`# ...`) e strings, preservando a estrutura de chaves.
fn strip(source: &str) -> String {
    let mut out = String::with_capacity(source.len());
    let mut chars = source.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '#' => {
                for c in chars.by_ref() {
                    if c == '\n' {
                        out.push('\n');
                        break;
                    }
                }
            }
            '"' => {
                let mut escaped = false;
                for c in chars.by_ref() {
                    if c == '"' && !escaped {
                        break;
                    }
                    escaped = c == '\\' && !escaped;
                }
                out.push_str("\"\"");
            }
            c => out.push(c),
        }
    }
    out
}

/// Campos de primeiro nível de cada operação `mutation` do documento.
fn mutation_fields(source: &str) -> Vec<String> {
    let doc = strip(source);
    let bytes: Vec<char> = doc.chars().collect();
    let mut fields = Vec::new();
    let mut i = 0;
    let mut depth = 0usize;
    let mut in_mutation = false;
    let mut paren = 0usize;
    while i < bytes.len() {
        let c = bytes[i];
        if c.is_alphabetic() || c == '_' {
            let start = i;
            while i < bytes.len() && (bytes[i].is_alphanumeric() || bytes[i] == '_') {
                i += 1;
            }
            let word: String = bytes[start..i].iter().collect();
            if depth == 0 && paren == 0 && word == "mutation" {
                in_mutation = true;
            } else if in_mutation && depth == 1 && paren == 0 {
                // Alias (`alias: campo`) → o campo real vem depois dos dois-pontos.
                let mut j = i;
                while j < bytes.len() && bytes[j].is_whitespace() {
                    j += 1;
                }
                if bytes.get(j) != Some(&':') && word != "on" {
                    fields.push(word);
                }
            }
            continue;
        }
        match c {
            '(' => paren += 1,
            ')' => paren = paren.saturating_sub(1),
            '{' if paren == 0 => depth += 1,
            '}' if paren == 0 => {
                depth -= 1;
                if depth == 0 {
                    in_mutation = false;
                }
            }
            _ => {}
        }
        i += 1;
    }
    fields
}

#[test]
fn somente_mutations_permitidas() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("graphql");
    let mut found = BTreeSet::new();
    let mut files = 0;
    for entry in std::fs::read_dir(&dir).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().is_some_and(|e| e == "graphql") {
            files += 1;
            let source = std::fs::read_to_string(&path).unwrap();
            for field in mutation_fields(&source) {
                assert!(
                    ALLOWED.contains(&field.as_str()),
                    "{}: mutation `{field}` fora da lista permitida {ALLOWED:?}",
                    path.display()
                );
                found.insert(field);
            }
        }
    }
    assert!(files >= 13, "esperava os .graphql em {}", dir.display());
    assert_eq!(found, ALLOWED.iter().map(|s| s.to_string()).collect());
}

#[test]
fn detector_acusa_mutation_proibida() {
    let doc = r#"
        # deploymentRemove em comentário não conta
        mutation Bad($id: String!) {
          ok: deploymentRemove(id: $id)
          serviceDelete(id: $id)
          projectDelete(id: "x { y }")
        }
        query Q { project(id: "1") { id } }
    "#;
    assert_eq!(
        mutation_fields(doc),
        ["deploymentRemove", "serviceDelete", "projectDelete"]
    );
}
