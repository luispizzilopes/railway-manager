-- Modelo inicial do Railway Manager (design, Decisão 4).
-- Datas em TEXT (RFC 3339, UTC). IDs internos são UUID em TEXT.

CREATE TABLE credentials (
    id            TEXT PRIMARY KEY NOT NULL,
    kind          TEXT NOT NULL CHECK (kind IN ('account', 'workspace')),
    workspace_id  TEXT,
    ciphertext    BLOB NOT NULL,
    nonce         BLOB NOT NULL,
    key_version   INTEGER NOT NULL,
    label         TEXT NOT NULL,
    masked_suffix TEXT NOT NULL,
    status        TEXT NOT NULL CHECK (status IN ('valid', 'invalid', 'undecipherable')),
    validated_at  TEXT,
    created_at    TEXT NOT NULL,
    CHECK ((kind = 'workspace') = (workspace_id IS NOT NULL))
);

CREATE TABLE projects (
    id                 TEXT PRIMARY KEY NOT NULL,
    credential_id      TEXT REFERENCES credentials (id) ON DELETE SET NULL,
    railway_project_id TEXT NOT NULL UNIQUE,
    name               TEXT NOT NULL,
    display_name       TEXT,
    description        TEXT,
    created_at         TEXT NOT NULL,
    last_synced_at     TEXT,
    sync_status        TEXT NOT NULL DEFAULT 'never'
                       CHECK (sync_status IN ('never', 'ok', 'failed', 'not_found'))
);

CREATE TABLE environments (
    id                     TEXT PRIMARY KEY NOT NULL,
    project_id             TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    railway_environment_id TEXT NOT NULL UNIQUE,
    name                   TEXT NOT NULL,
    is_ephemeral           INTEGER NOT NULL DEFAULT 0,
    UNIQUE (project_id, id)
);

CREATE TABLE services (
    id                 TEXT PRIMARY KEY NOT NULL,
    project_id         TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    railway_service_id TEXT NOT NULL,
    name               TEXT NOT NULL,
    UNIQUE (project_id, railway_service_id),
    UNIQUE (project_id, id)
);

CREATE TABLE service_instances (
    id                       TEXT PRIMARY KEY NOT NULL,
    -- project_id garante, via FKs compostas, que serviço e ambiente são do mesmo projeto.
    project_id               TEXT NOT NULL,
    service_id               TEXT NOT NULL,
    environment_id           TEXT NOT NULL,
    observed_state           TEXT NOT NULL DEFAULT 'unknown'
                             CHECK (observed_state IN ('running', 'stopped', 'sleeping',
                                    'transitioning', 'failed', 'awaiting_approval', 'unknown')),
    not_found                INTEGER NOT NULL DEFAULT 0,
    latest_deployment_id     TEXT,
    latest_deployment_status TEXT,
    last_observed_at         TEXT,
    last_sync_error          TEXT,
    UNIQUE (service_id, environment_id),
    FOREIGN KEY (project_id, service_id) REFERENCES services (project_id, id) ON DELETE CASCADE,
    FOREIGN KEY (project_id, environment_id) REFERENCES environments (project_id, id) ON DELETE CASCADE
);

CREATE TABLE operation_plans (
    id           TEXT PRIMARY KEY NOT NULL,
    payload_json TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    expires_at   TEXT NOT NULL,
    consumed_at  TEXT
);

CREATE TABLE operations (
    id           TEXT PRIMARY KEY NOT NULL,
    kind         TEXT NOT NULL CHECK (kind IN ('start', 'stop')),
    scope        TEXT NOT NULL CHECK (scope IN ('instance', 'project', 'batch')),
    trigger      TEXT NOT NULL CHECK (trigger IN ('manual')),
    requested_by TEXT NOT NULL,
    plan_id      TEXT NOT NULL UNIQUE REFERENCES operation_plans (id),
    status       TEXT NOT NULL
                 CHECK (status IN ('pending', 'running', 'succeeded', 'partially_failed', 'failed')),
    created_at   TEXT NOT NULL,
    started_at   TEXT,
    finished_at  TEXT
);

CREATE INDEX operations_created_at ON operations (created_at DESC);

CREATE TABLE operation_items (
    id                     TEXT PRIMARY KEY NOT NULL,
    operation_id           TEXT NOT NULL REFERENCES operations (id) ON DELETE CASCADE,
    service_instance_id    TEXT REFERENCES service_instances (id) ON DELETE SET NULL,
    -- Cópias do momento da operação: o histórico sobrevive à remoção local.
    project_id             TEXT NOT NULL,
    project_name           TEXT NOT NULL,
    railway_project_id     TEXT NOT NULL,
    service_name           TEXT NOT NULL,
    railway_service_id     TEXT NOT NULL,
    environment_name       TEXT NOT NULL,
    railway_environment_id TEXT NOT NULL,
    previous_state         TEXT NOT NULL,
    desired_state          TEXT NOT NULL,
    final_state            TEXT,
    deployment_id          TEXT,
    result                 TEXT NOT NULL
                           CHECK (result IN ('pending', 'running', 'verifying', 'succeeded',
                                  'failed', 'skipped', 'timed_out', 'interrupted')),
    error_message          TEXT,
    started_at             TEXT,
    finished_at            TEXT,
    duration_ms            INTEGER
);

-- Bloqueio persistente: uma instância participa de no máximo uma operação ativa.
CREATE UNIQUE INDEX operation_items_active_instance
    ON operation_items (service_instance_id)
    WHERE result IN ('pending', 'running', 'verifying');

CREATE INDEX operation_items_operation ON operation_items (operation_id);
CREATE INDEX operation_items_railway_project ON operation_items (railway_project_id);

CREATE TABLE sessions (
    id_hash    TEXT PRIMARY KEY NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);
