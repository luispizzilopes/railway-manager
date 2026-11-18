//! Papel mínimo exigido por cada rota. Fonte única da matriz de permissões: rota sem
//! entrada aqui só é acessível ao master (negado por padrão).

use axum::http::Method;
use domain::user::Role;

use Role::{Admin, Master, Operator, Viewer};

/// `(método, padrão do caminho sem o prefixo /api, papel mínimo)`. `{x}` casa um segmento.
pub const ROUTES: &[(&str, &str, Role)] = &[
    ("GET", "/session", Viewer),
    ("GET", "/credential", Viewer),
    ("PUT", "/credential", Admin),
    ("DELETE", "/credential", Admin),
    ("GET", "/railway/projects", Admin),
    ("GET", "/projects", Viewer),
    ("POST", "/projects", Admin),
    ("POST", "/projects/import", Admin),
    ("GET", "/projects/{id}", Viewer),
    ("PATCH", "/projects/{id}", Admin),
    ("DELETE", "/projects/{id}", Admin),
    ("POST", "/projects/{id}/sync", Operator),
    ("GET", "/projects/{id}/environments", Viewer),
    ("GET", "/projects/{id}/railway-instances", Admin),
    ("GET", "/projects/{id}/instances", Viewer),
    ("POST", "/projects/{id}/instances", Admin),
    ("POST", "/projects/{id}/instances/import", Admin),
    ("DELETE", "/instances/{id}", Admin),
    ("GET", "/instances/{id}/logs", Viewer),
    ("GET", "/instances/{id}/deployments", Viewer),
    ("DELETE", "/services/{id}", Admin),
    ("POST", "/operations/plan", Operator),
    ("POST", "/operations", Operator),
    ("GET", "/operations/{id}", Viewer),
    ("GET", "/history", Viewer),
    ("GET", "/schedules", Viewer),
    ("POST", "/schedules", Admin),
    ("GET", "/schedules/{id}", Viewer),
    ("PUT", "/schedules/{id}", Admin),
    ("DELETE", "/schedules/{id}", Admin),
    ("POST", "/schedules/{id}/pause", Operator),
    ("POST", "/schedules/{id}/resume", Operator),
    ("GET", "/schedules/{id}/runs", Viewer),
    ("GET", "/scheduled-actions", Viewer),
    ("POST", "/scheduled-actions", Operator),
    ("GET", "/scheduled-actions/{id}", Viewer),
    ("POST", "/scheduled-actions/{id}/cancel", Operator),
    ("GET", "/dashboard", Viewer),
    ("POST", "/dashboard/refresh", Operator),
    ("GET", "/users", Master),
    ("POST", "/users", Master),
    ("PATCH", "/users/{id}", Master),
    ("DELETE", "/users/{id}", Master),
    ("POST", "/users/{id}/password", Master),
];

fn matches(pattern: &str, path: &str) -> bool {
    let mut pattern = pattern.split('/');
    let mut path = path.split('/');
    loop {
        match (pattern.next(), path.next()) {
            (None, None) => return true,
            (Some(p), Some(s)) if p == s || (p.starts_with('{') && !s.is_empty()) => {}
            _ => return false,
        }
    }
}

/// Papel mínimo para `método` + `caminho` (com ou sem o prefixo `/api`).
pub fn required_role(method: &Method, path: &str) -> Role {
    let path = path.strip_prefix("/api").unwrap_or(path);
    let path = if path.len() > 1 {
        path.trim_end_matches('/')
    } else {
        path
    };
    let method = if method == Method::HEAD {
        &Method::GET
    } else {
        method
    };
    ROUTES
        .iter()
        .find(|(m, pattern, _)| *m == method.as_str() && matches(pattern, path))
        .map_or(Master, |(_, _, role)| *role)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn casa_segmentos_variaveis() {
        assert_eq!(required_role(&Method::GET, "/projects/abc"), Viewer);
        assert_eq!(required_role(&Method::POST, "/projects/abc/sync"), Operator);
        assert_eq!(required_role(&Method::DELETE, "/api/projects/abc"), Admin);
        assert_eq!(required_role(&Method::GET, "/projects/"), Viewer);
        assert_eq!(required_role(&Method::HEAD, "/dashboard"), Viewer);
    }

    #[test]
    fn rota_desconhecida_exige_master() {
        assert_eq!(required_role(&Method::GET, "/nova-rota"), Master);
        assert_eq!(required_role(&Method::PUT, "/dashboard"), Master);
        assert_eq!(required_role(&Method::GET, "/projects/a/b/c"), Master);
    }
}
