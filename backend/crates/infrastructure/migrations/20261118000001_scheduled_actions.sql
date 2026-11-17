-- Ações agendadas pontuais (change command-console, design decisão 6).

CREATE TABLE scheduled_actions (
    id               TEXT PRIMARY KEY NOT NULL,
    kind             TEXT NOT NULL CHECK (kind IN ('start', 'stop')),
    run_at           TEXT NOT NULL,
    target_kind      TEXT NOT NULL CHECK (target_kind IN ('all', 'projects', 'instances')),
    environment_name TEXT,
    note             TEXT,
    label            TEXT NOT NULL,
    status           TEXT NOT NULL
                     CHECK (status IN ('pending', 'processing', 'executed', 'late', 'skipped',
                                       'missed', 'failed', 'cancelled')),
    message          TEXT,
    operation_id     TEXT,
    created_at       TEXT NOT NULL,
    processed_at     TEXT,
    CHECK (target_kind <> 'instances' OR environment_name IS NULL)
);

CREATE INDEX scheduled_actions_due ON scheduled_actions (status, run_at);

CREATE TABLE scheduled_action_projects (
    action_id  TEXT NOT NULL REFERENCES scheduled_actions (id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    PRIMARY KEY (action_id, project_id)
);

CREATE TABLE scheduled_action_instances (
    action_id           TEXT NOT NULL REFERENCES scheduled_actions (id) ON DELETE CASCADE,
    service_instance_id TEXT NOT NULL REFERENCES service_instances (id) ON DELETE CASCADE,
    PRIMARY KEY (action_id, service_instance_id)
);
