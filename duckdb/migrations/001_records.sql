-- Apply this while connected to the herodotus database.
-- One id is one row. The Worker upserts on that primary key.

CREATE TABLE IF NOT EXISTS records (
    id UUID PRIMARY KEY,
    kind VARCHAR NOT NULL,
    via VARCHAR NOT NULL,
    actor VARCHAR NOT NULL,
    agent VARCHAR,
    url VARCHAR,
    title VARCHAR,
    author VARCHAR,
    site VARCHAR,
    published_at TIMESTAMPTZ,
    about_id UUID,
    text VARCHAR NOT NULL DEFAULT '',
    tags VARCHAR[] NOT NULL,
    ts TIMESTAMPTZ NOT NULL,
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    raw VARCHAR NOT NULL DEFAULT ''
);
