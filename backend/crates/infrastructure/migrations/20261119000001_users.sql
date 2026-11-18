-- Usuários cadastrados (o master vive no ambiente e não é gravado aqui) e sessões por usuário.

CREATE TABLE users (
    id            TEXT PRIMARY KEY NOT NULL,
    username      TEXT NOT NULL,
    username_key  TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('viewer', 'operator', 'admin')),
    is_active     INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);

-- Sessões antigas não sabem a quem pertencem: todos entram de novo uma vez.
DELETE FROM sessions;

-- `user_id` nulo identifica a sessão do master.
ALTER TABLE sessions ADD COLUMN user_id TEXT REFERENCES users (id) ON DELETE CASCADE;

CREATE INDEX sessions_user_id ON sessions (user_id);
