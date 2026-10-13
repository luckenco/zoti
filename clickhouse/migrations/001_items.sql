CREATE DATABASE IF NOT EXISTS private_life;

CREATE TABLE IF NOT EXISTS private_life.items
(
    id UUID,
    url Nullable(String),
    text String,
    type LowCardinality(String),
    source LowCardinality(String),
    tags Array(String),
    ts DateTime64(3, 'UTC'),
    ingested_at DateTime64(3, 'UTC') DEFAULT now64(3),
    raw String DEFAULT ''
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(ts)
ORDER BY (id)
SETTINGS index_granularity = 8192;
