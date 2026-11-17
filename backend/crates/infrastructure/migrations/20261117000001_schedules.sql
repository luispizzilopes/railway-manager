-- Agendas de ligar/desligar (change power-schedules, design decisão 1).

CREATE TABLE schedules (
    id             TEXT PRIMARY KEY NOT NULL,
    project_id     TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    name           TEXT NOT NULL,
    enabled        INTEGER NOT NULL DEFAULT 1,
    timezone       TEXT NOT NULL,
    -- bit 0 = segunda … bit 6 = domingo
    days_mask      INTEGER NOT NULL CHECK (days_mask BETWEEN 1 AND 127),
    target_kind    TEXT NOT NULL CHECK (target_kind IN ('project', 'instances')),
    environment_id TEXT REFERENCES environments (id) ON DELETE SET NULL,
    effective_from TEXT NOT NULL,
    paused_reason  TEXT,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
);

CREATE INDEX schedules_project ON schedules (project_id);

CREATE TABLE schedule_windows (
    schedule_id  TEXT NOT NULL REFERENCES schedules (id) ON DELETE CASCADE,
    position     INTEGER NOT NULL,
    start_minute INTEGER NOT NULL CHECK (start_minute BETWEEN 0 AND 1439),
    end_minute   INTEGER NOT NULL CHECK (end_minute BETWEEN 0 AND 1439),
    PRIMARY KEY (schedule_id, position)
);

CREATE TABLE schedule_instances (
    schedule_id         TEXT NOT NULL REFERENCES schedules (id) ON DELETE CASCADE,
    service_instance_id TEXT NOT NULL REFERENCES service_instances (id) ON DELETE CASCADE,
    PRIMARY KEY (schedule_id, service_instance_id)
);

CREATE TABLE schedule_runs (
    id            TEXT PRIMARY KEY NOT NULL,
    schedule_id   TEXT NOT NULL REFERENCES schedules (id) ON DELETE CASCADE,
    schedule_name TEXT NOT NULL,
    action        TEXT NOT NULL CHECK (action IN ('start', 'stop')),
    scheduled_for TEXT NOT NULL,
    processed_at  TEXT NOT NULL,
    status        TEXT NOT NULL
                  CHECK (status IN ('pending', 'executed', 'late', 'skipped', 'missed', 'failed')),
    operation_id  TEXT,
    message       TEXT,
    -- Exatamente-uma-vez por evento.
    UNIQUE (schedule_id, scheduled_for, action)
);

CREATE INDEX schedule_runs_recent ON schedule_runs (schedule_id, scheduled_for DESC);

CREATE TABLE scheduler_state (
    id                INTEGER PRIMARY KEY CHECK (id = 1),
    last_evaluated_at TEXT NOT NULL
);
