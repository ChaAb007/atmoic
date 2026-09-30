CREATE TABLE IF NOT EXISTS experience (
    id TEXT PRIMARY KEY,
    conversation_id TEXT,
    agent_id TEXT,
    prompt_summary TEXT,
    response_summary TEXT,
    created_on TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS object (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    UNIQUE (type, key)
);

CREATE TABLE IF NOT EXISTS atom (
    id TEXT PRIMARY KEY,
    experience_id TEXT,
    who TEXT,
    verb TEXT NOT NULL,
    at TEXT,
    product TEXT,
    task_id TEXT,
    result_json TEXT,
    evidence TEXT,
    created_on TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS atom_object (
    atom_id TEXT NOT NULL,
    object_id TEXT NOT NULL,
    PRIMARY KEY (atom_id, object_id)
);

CREATE TABLE IF NOT EXISTS mass (
    object_id TEXT PRIMARY KEY,
    value INTEGER NOT NULL,
    last_ref_on TEXT NOT NULL
);
