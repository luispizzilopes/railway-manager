-- no-transaction
-- Reconstrói `operations` para aceitar `trigger = 'scheduled_action'` e registrar a ação.
-- Mesmo procedimento de 20261117000002: com as chaves estrangeiras desligadas, o DROP
-- não apaga `operation_items` em cascata.

PRAGMA foreign_keys = OFF;

BEGIN;

CREATE TABLE operations_new (
    id                     TEXT PRIMARY KEY NOT NULL,
    kind                   TEXT NOT NULL CHECK (kind IN ('start', 'stop')),
    scope                  TEXT NOT NULL CHECK (scope IN ('instance', 'project', 'batch')),
    trigger                TEXT NOT NULL CHECK (trigger IN ('manual', 'schedule', 'scheduled_action')),
    schedule_id            TEXT,
    schedule_name          TEXT,
    scheduled_action_id    TEXT,
    scheduled_action_label TEXT,
    requested_by           TEXT NOT NULL,
    plan_id                TEXT NOT NULL UNIQUE REFERENCES operation_plans (id),
    status                 TEXT NOT NULL
                           CHECK (status IN ('pending', 'running', 'succeeded', 'partially_failed', 'failed')),
    created_at             TEXT NOT NULL,
    started_at             TEXT,
    finished_at            TEXT,
    CHECK ((trigger = 'schedule') = (schedule_name IS NOT NULL)),
    CHECK ((trigger = 'scheduled_action') = (scheduled_action_label IS NOT NULL))
);

INSERT INTO operations_new (id, kind, scope, trigger, schedule_id, schedule_name, requested_by,
                            plan_id, status, created_at, started_at, finished_at)
SELECT id, kind, scope, trigger, schedule_id, schedule_name, requested_by,
       plan_id, status, created_at, started_at, finished_at
  FROM operations;

DROP TABLE operations;

ALTER TABLE operations_new RENAME TO operations;

CREATE INDEX operations_created_at ON operations (created_at DESC);
CREATE INDEX operations_trigger ON operations (trigger);

COMMIT;

PRAGMA foreign_keys = ON;
