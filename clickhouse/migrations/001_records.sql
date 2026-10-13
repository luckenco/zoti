CREATE DATABASE IF NOT EXISTS herodotus;

CREATE TABLE IF NOT EXISTS herodotus.records
(
    id UUID,
    kind LowCardinality(String),
    via LowCardinality(String),
    actor LowCardinality(String),
    agent Nullable(String),
    url Nullable(String),
    title Nullable(String),
    author Nullable(String),
    site Nullable(String),
    published_at Nullable(DateTime64(3, 'UTC')),
    about_id Nullable(UUID),
    text String DEFAULT '',
    tags Array(String),
    ts DateTime64(3, 'UTC'),
    ingested_at DateTime64(3, 'UTC') DEFAULT now64(3),
    raw String DEFAULT ''
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(ts)
ORDER BY (id)
SETTINGS index_granularity = 8192;
