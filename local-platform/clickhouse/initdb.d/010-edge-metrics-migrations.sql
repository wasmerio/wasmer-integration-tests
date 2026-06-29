-- Generated from wasmer/edge crates/metrics/src/store/clickhouse/migrations.rs
-- Local-platform loads these on fresh ClickHouse startup for isolated CI runs.
USE edge_metrics_local;

-- 0000_create_workload_metrics_summary_table
CREATE TABLE IF NOT EXISTS workload_metrics_summary
(
    node_id UUID,
    node_global_ipv4 IPv4,
    workload_id UUID,
    workload_type LowCardinality(String),
    token_id UUID,
    agent LowCardinality(String),
    external_id LowCardinality(String),

    created_at DateTime64(3),
    started_at DateTime64(3),
    completed_at DateTime64(3),
    network_ingress_kb UInt64,
    network_egress_kb UInt64,
    memory_time_kbs UInt64,
    cpu_time_millis UInt64,

    status LowCardinality(String),
    failure_reason LowCardinality(String)
)
ENGINE = ReplacingMergeTree
ORDER BY (workload_id, node_id, created_at)
;

-- 0001_create_workload_metrics_snapshot_table
CREATE TABLE IF NOT EXISTS workload_metrics_snapshot
(
    node_id UUID,
    node_global_ipv4 IPv4,
    workload_id UUID,
    workload_type LowCardinality(String),
    token_id UUID,
    agent LowCardinality(String),
    external_id LowCardinality(String),

    recorded_at DateTime64(3) DEFAULT now(),
    workload_created_at DateTime64(3),
    network_ingress_gauge_bytes UInt64,
    network_egress_gauge_bytes UInt64,
    cpu_time_gauge_millis UInt64,
    memory_usage_gauge_bytes UInt64
)
ENGINE = MergeTree
ORDER BY (recorded_at, workload_id)
;

-- 0002_create_request_log_table
CREATE TABLE IF NOT EXISTS request_log
(
    node_id UUID,
    node_global_ipv4 IPv4,
    workload_id UUID,
    request_id UUID,
    external_id LowCardinality(String),
    received_at DateTime64(3),
    total_duration_microseconds UInt64,
    client_ipv4 IPv4,
    client_ipv6 LowCardinality(String),
    http_version LowCardinality(String),
    http_method LowCardinality(String),
    request_domain LowCardinality(String) DEFAULT '',
    url_path LowCardinality(String) DEFAULT '',
    url_query String,
    user_agent LowCardinality(String),
    outcome LowCardinality(String),
    response_http_status UInt16
)
ENGINE = MergeTree
ORDER BY (node_id, workload_id, received_at);

-- 0003_add_flow_metrics_to_request_log_table
ALTER TABLE request_log
ADD COLUMN IF NOT EXISTS init_to_tcp UInt32 CODEC(Delta, ZSTD),
ADD COLUMN IF NOT EXISTS init_to_handshake UInt32 CODEC(Delta, ZSTD),
ADD COLUMN IF NOT EXISTS handshake_to_acme UInt32 CODEC(Delta, ZSTD),
ADD COLUMN IF NOT EXISTS handshake_to_touching UInt32 CODEC(Delta, ZSTD),
ADD COLUMN IF NOT EXISTS acme_to_converting UInt32 CODEC(Delta, ZSTD),
ADD COLUMN IF NOT EXISTS touching_to_converting UInt32 CODEC(Delta, ZSTD),
ADD COLUMN IF NOT EXISTS converting_to_tls UInt32 CODEC(Delta, ZSTD),
ADD COLUMN IF NOT EXISTS tls_to_init_service UInt32 CODEC(Delta, ZSTD),
ADD COLUMN IF NOT EXISTS tcp_to_init_service UInt32 CODEC(Delta, ZSTD),
ADD COLUMN IF NOT EXISTS tracing_to_process UInt32 CODEC(Delta, ZSTD),
ADD COLUMN IF NOT EXISTS process_to_wiring UInt32 CODEC(Delta, ZSTD),
ADD COLUMN IF NOT EXISTS wiring_to_acme_start UInt32 CODEC(Delta, ZSTD),
ADD COLUMN IF NOT EXISTS wiring_to_hit UInt32 CODEC(Delta, ZSTD),
ADD COLUMN IF NOT EXISTS wiring_to_miss UInt32 CODEC(Delta, ZSTD),
ADD COLUMN IF NOT EXISTS acme_start_to_acme_finish UInt32 CODEC(Delta, ZSTD),
ADD COLUMN IF NOT EXISTS hit_to_wasi UInt32 CODEC(Delta, ZSTD),
ADD COLUMN IF NOT EXISTS hit_to_wcgi UInt32 CODEC(Delta, ZSTD),
ADD COLUMN IF NOT EXISTS hit_to_dcgi UInt32 CODEC(Delta, ZSTD),
ADD COLUMN IF NOT EXISTS hit_to_dproxy UInt32 CODEC(Delta, ZSTD),
ADD COLUMN IF NOT EXISTS wasi_to_acquire_socket UInt32 CODEC(Delta, ZSTD),
ADD COLUMN IF NOT EXISTS acquire_socket_to_get_instance UInt32 CODEC(Delta, ZSTD),
ADD COLUMN IF NOT EXISTS get_instance_to_execute UInt32 CODEC(Delta, ZSTD),
ADD COLUMN IF NOT EXISTS execute_to_streaming_trailers UInt32 CODEC(Delta, ZSTD),
ADD COLUMN IF NOT EXISTS wcgi_to_spin_up UInt32 CODEC(Delta, ZSTD),
ADD COLUMN IF NOT EXISTS spin_up_to_create_network UInt32 CODEC(Delta, ZSTD),
ADD COLUMN IF NOT EXISTS create_network_to_create_runtime UInt32 CODEC(Delta, ZSTD),
ADD COLUMN IF NOT EXISTS create_runtime_to_create_console UInt32 CODEC(Delta, ZSTD),
ADD COLUMN IF NOT EXISTS create_console_to_spawn_main_thread UInt32 CODEC(Delta, ZSTD),
ADD COLUMN IF NOT EXISTS spawn_main_thread_to_booting UInt32 CODEC(Delta, ZSTD),
ADD COLUMN IF NOT EXISTS booting_to_streaming_trailers UInt32 CODEC(Delta, ZSTD),
ADD COLUMN IF NOT EXISTS streaming_trailers_to_finished UInt32 CODEC(Delta, ZSTD);

-- 0004_add_volume_info_table
CREATE TABLE IF NOT EXISTS volume_info
(
    node_global_ipv4 IPv4,
    node_id UUID,
    volume_id UUID,
    size UInt64,
    timestamp DateTime64(3) DEFAULT now(),
)
ENGINE = MergeTree
ORDER BY (volume_id, timestamp, node_id);

-- 0005_add_engine_to_workload_metrics_summary_table
ALTER TABLE workload_metrics_summary
ADD COLUMN IF NOT EXISTS engine LowCardinality(String) DEFAULT '';

-- 0006_request_log_drop_timnig_columns
ALTER TABLE request_log
DROP COLUMN IF EXISTS init_to_tcp,
DROP COLUMN IF EXISTS init_to_handshake,
DROP COLUMN IF EXISTS handshake_to_acme,
DROP COLUMN IF EXISTS handshake_to_touching,
DROP COLUMN IF EXISTS acme_to_converting,
DROP COLUMN IF EXISTS touching_to_converting,
DROP COLUMN IF EXISTS converting_to_tls,
DROP COLUMN IF EXISTS tls_to_init_service,
DROP COLUMN IF EXISTS tcp_to_init_service,
DROP COLUMN IF EXISTS tracing_to_process,
DROP COLUMN IF EXISTS process_to_wiring,
DROP COLUMN IF EXISTS wiring_to_acme_start,
DROP COLUMN IF EXISTS wiring_to_hit,
DROP COLUMN IF EXISTS wiring_to_miss,
DROP COLUMN IF EXISTS acme_start_to_acme_finish,
DROP COLUMN IF EXISTS hit_to_wasi,
DROP COLUMN IF EXISTS hit_to_wcgi,
DROP COLUMN IF EXISTS hit_to_dcgi,
DROP COLUMN IF EXISTS hit_to_dproxy,
DROP COLUMN IF EXISTS wasi_to_acquire_socket,
DROP COLUMN IF EXISTS acquire_socket_to_get_instance,
DROP COLUMN IF EXISTS get_instance_to_execute,
DROP COLUMN IF EXISTS execute_to_streaming_trailers,
DROP COLUMN IF EXISTS wcgi_to_spin_up,
DROP COLUMN IF EXISTS spin_up_to_create_network,
DROP COLUMN IF EXISTS create_network_to_create_runtime,
DROP COLUMN IF EXISTS create_runtime_to_create_console,
DROP COLUMN IF EXISTS create_console_to_spawn_main_thread,
DROP COLUMN IF EXISTS spawn_main_thread_to_booting,
DROP COLUMN IF EXISTS booting_to_streaming_trailers,
DROP COLUMN IF EXISTS streaming_trailers_to_finished;

-- 0006_request_log_add_column_request_body_size
ALTER TABLE request_log
ADD COLUMN IF NOT EXISTS request_body_size UInt64;

-- 0007_request_log_add_column_response_from_cache
ALTER TABLE request_log
ADD COLUMN IF NOT EXISTS response_from_cache Bool;

-- 0008_add_real_cpu_metrics_snapshot
ALTER TABLE workload_metrics_snapshot
ADD COLUMN IF NOT EXISTS real_cpu_time_gauge_millis UInt64 DEFAULT 0;

-- 0009_add_real_cpu_metrics_summary
ALTER TABLE workload_metrics_summary
ADD COLUMN IF NOT EXISTS real_cpu_time_millis UInt64 DEFAULT 0;

-- 0010_add_memory_time_metrics_summary
ALTER TABLE volume_info
  ADD COLUMN IF NOT EXISTS iops_read UInt64 DEFAULT 0,
  ADD COLUMN IF NOT EXISTS iops_write UInt64 DEFAULT 0;

-- 0011_request_log_add_column_response_body_size
ALTER TABLE request_log
ADD COLUMN IF NOT EXISTS response_body_size UInt64;

-- 0012_add_app_metadata_to_request_log
ALTER TABLE request_log
    ADD COLUMN IF NOT EXISTS app_id UInt64 DEFAULT 0,
    ADD COLUMN IF NOT EXISTS app_version_id UInt64 DEFAULT 0,
    ADD COLUMN IF NOT EXISTS app_owner_id UInt64 DEFAULT 0,
    ADD COLUMN IF NOT EXISTS app_owner_is_user Bool DEFAULT false;

-- 0013_add_app_metadata_to_workload_snapshot
ALTER TABLE workload_metrics_snapshot
    ADD COLUMN IF NOT EXISTS app_id UInt64 DEFAULT 0,
    ADD COLUMN IF NOT EXISTS app_version_id UInt64 DEFAULT 0,
    ADD COLUMN IF NOT EXISTS app_owner_id UInt64 DEFAULT 0,
    ADD COLUMN IF NOT EXISTS app_owner_is_user Bool DEFAULT false;

-- 0014_add_app_metadata_to_workload_summary
ALTER TABLE workload_metrics_summary
    ADD COLUMN IF NOT EXISTS app_id UInt64 DEFAULT 0,
    ADD COLUMN IF NOT EXISTS app_version_id UInt64 DEFAULT 0,
    ADD COLUMN IF NOT EXISTS app_owner_id UInt64 DEFAULT 0,
    ADD COLUMN IF NOT EXISTS app_owner_is_user Bool DEFAULT false;

-- 0015_request_log_add_column_protocol
ALTER TABLE request_log
ADD COLUMN IF NOT EXISTS protocol LowCardinality(String) DEFAULT 'http';

-- 0016_add_distinct_accessed_ips_to_workload_metrics
ALTER TABLE workload_metrics_summary
    ADD COLUMN IF NOT EXISTS distinct_accessed_ip_count UInt64 DEFAULT 0,
    ADD COLUMN IF NOT EXISTS distinct_accessed_ips Array(IPv6) DEFAULT [];

-- 0017_add_recorded_at_to_workload_metrics_summary
ALTER TABLE workload_metrics_summary
    ADD COLUMN IF NOT EXISTS recorded_at DateTime64(3) DEFAULT now();

-- 0018_add_request_log_hourly
CREATE TABLE IF NOT EXISTS request_log_hourly
(
    `external_id` LowCardinality(String),
    `grouped_at_hour` DateTime,
    `http_total_count` AggregateFunction(count),
    `http_2xx_count` AggregateFunction(sum, UInt64),
    `http_3xx_count` AggregateFunction(sum, UInt64),
    `http_4xx_count` AggregateFunction(sum, UInt64),
    `http_5xx_count` AggregateFunction(sum, UInt64),
    `http_other_count` AggregateFunction(sum, UInt64),
    `http_total_duration_millis` AggregateFunction(sum, UInt64),
    `edge_outcome_success` AggregateFunction(sum, UInt8)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(grouped_at_hour)
ORDER BY (external_id, grouped_at_hour)
SETTINGS index_granularity = 8192
;

-- 0019_add_request_log_hourly_by_owner_app
CREATE TABLE IF NOT EXISTS request_log_hourly_by_owner_app
(
    `app_owner_id` UInt64,
    `app_owner_is_user` UInt8,
    `app_id` UInt64,
    `grouped_at_hour` DateTime,
    `http_total_count` AggregateFunction(count),
    `cached_count` AggregateFunction(sum, UInt64),
    `http_2xx_count` AggregateFunction(sum, UInt64),
    `http_3xx_count` AggregateFunction(sum, UInt64),
    `http_4xx_count` AggregateFunction(sum, UInt64),
    `http_5xx_count` AggregateFunction(sum, UInt64),
    `http_other_count` AggregateFunction(sum, UInt64),
    `http_total_duration_millis` AggregateFunction(sum, UInt64),
    `unique_users_ipv6` AggregateFunction(uniqCombined64, UInt64),
    `total_data_served_bytes` AggregateFunction(sum, UInt64),
    `total_data_cached_bytes` AggregateFunction(sum, UInt64),
    `total_data_received_bytes` AggregateFunction(sum, UInt64),
    `edge_outcome_success` AggregateFunction(sum, UInt8)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(grouped_at_hour)
ORDER BY (app_owner_id, app_id, grouped_at_hour)
SETTINGS index_granularity = 8192
;

-- 0020_add_request_log_hourly_by_owner
CREATE TABLE IF NOT EXISTS request_log_hourly_by_owner
(
    `app_owner_id` UInt64,
    `app_owner_is_user` UInt8,
    `grouped_at_hour` DateTime,
    `http_total_count` AggregateFunction(count),
    `cached_count` AggregateFunction(sum, UInt64),
    `http_2xx_count` AggregateFunction(sum, UInt64),
    `http_3xx_count` AggregateFunction(sum, UInt64),
    `http_4xx_count` AggregateFunction(sum, UInt64),
    `http_5xx_count` AggregateFunction(sum, UInt64),
    `http_other_count` AggregateFunction(sum, UInt64),
    `http_total_duration_millis` AggregateFunction(sum, UInt64),
    `unique_users_ipv6` AggregateFunction(uniqCombined64, UInt64),
    `total_data_served_bytes` AggregateFunction(sum, UInt64),
    `total_data_cached_bytes` AggregateFunction(sum, UInt64),
    `total_data_received_bytes` AggregateFunction(sum, UInt64),
    `edge_outcome_success` AggregateFunction(sum, UInt8)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(grouped_at_hour)
ORDER BY (app_owner_id, app_owner_is_user, grouped_at_hour)
SETTINGS index_granularity = 8192
;

-- 0021_add_request_log_daily_by_owner_app
CREATE TABLE IF NOT EXISTS request_log_daily_by_owner_app
(
    `app_owner_id` UInt64,
    `app_owner_is_user` UInt8,
    `app_id` UInt64,
    `grouped_at_day` Date,
    `http_total_count` AggregateFunction(count),
    `cached_count` AggregateFunction(sum, UInt64),
    `http_2xx_count` AggregateFunction(sum, UInt64),
    `http_3xx_count` AggregateFunction(sum, UInt64),
    `http_4xx_count` AggregateFunction(sum, UInt64),
    `http_5xx_count` AggregateFunction(sum, UInt64),
    `http_other_count` AggregateFunction(sum, UInt64),
    `http_total_duration_millis` AggregateFunction(sum, UInt64),
    `unique_users_ipv6` AggregateFunction(uniqCombined64, UInt64),
    `total_data_served_bytes` AggregateFunction(sum, UInt64),
    `total_data_cached_bytes` AggregateFunction(sum, UInt64),
    `total_data_received_bytes` AggregateFunction(sum, UInt64),
    `edge_outcome_success` AggregateFunction(sum, UInt8)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(grouped_at_day)
ORDER BY (app_owner_id, app_owner_is_user, app_id, grouped_at_day)
SETTINGS index_granularity = 8192
;

-- 0022_add_request_log_daily_by_owner
CREATE TABLE IF NOT EXISTS request_log_daily_by_owner
(
    `app_owner_id` UInt64,
    `app_owner_is_user` UInt8,
    `grouped_at_day` Date,
    `http_total_count` AggregateFunction(count),
    `cached_count` AggregateFunction(sum, UInt64),
    `http_2xx_count` AggregateFunction(sum, UInt64),
    `http_3xx_count` AggregateFunction(sum, UInt64),
    `http_4xx_count` AggregateFunction(sum, UInt64),
    `http_5xx_count` AggregateFunction(sum, UInt64),
    `http_other_count` AggregateFunction(sum, UInt64),
    `http_total_duration_millis` AggregateFunction(sum, UInt64),
    `unique_users_ipv6` AggregateFunction(uniqCombined64, UInt64),
    `total_data_served_bytes` AggregateFunction(sum, UInt64),
    `total_data_cached_bytes` AggregateFunction(sum, UInt64),
    `total_data_received_bytes` AggregateFunction(sum, UInt64),
    `edge_outcome_success` AggregateFunction(sum, UInt8)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(grouped_at_day)
ORDER BY (app_owner_id, app_owner_is_user, grouped_at_day)
SETTINGS index_granularity = 8192
;

-- 0023_add_request_log_hourly_by_owner_app_final
CREATE VIEW IF NOT EXISTS request_log_hourly_by_owner_app_final
(
    `app_owner_id` UInt64,
    `app_owner_is_user` UInt8,
    `app_id` UInt64,
    `grouped_at_hour` DateTime,
    `total_requests` UInt64,
    `cached_requests` UInt64,
    `pct_cached` Float64,
    `http_2xx` UInt64,
    `http_3xx` UInt64,
    `http_4xx` UInt64,
    `http_5xx` UInt64,
    `http_other` UInt64,
    `total_duration_millis` UInt64,
    `unique_users` UInt64,
    `total_data_served_bytes` UInt64,
    `total_data_cached_bytes` UInt64,
    `total_data_received_bytes` UInt64,
    `edge_outcome_success` UInt64
)
AS SELECT
    app_owner_id,
    app_owner_is_user,
    app_id,
    grouped_at_hour,
    countMerge(http_total_count) AS total_requests,
    sumMerge(cached_count) AS cached_requests,
    if(countMerge(http_total_count) = 0, 0., sumMerge(cached_count) / countMerge(http_total_count)) AS pct_cached,
    sumMerge(http_2xx_count) AS http_2xx,
    sumMerge(http_3xx_count) AS http_3xx,
    sumMerge(http_4xx_count) AS http_4xx,
    sumMerge(http_5xx_count) AS http_5xx,
    sumMerge(http_other_count) AS http_other,
    sumMerge(http_total_duration_millis) AS total_duration_millis,
    uniqCombined64Merge(unique_users_ipv6) AS unique_users,
    sumMerge(total_data_served_bytes) AS total_data_served_bytes,
    sumMerge(total_data_cached_bytes) AS total_data_cached_bytes,
    sumMerge(total_data_received_bytes) AS total_data_received_bytes,
    sumMerge(edge_outcome_success) AS edge_outcome_success
FROM request_log_hourly_by_owner_app
GROUP BY
    app_owner_id,
    app_owner_is_user,
    app_id,
    grouped_at_hour
;

-- 0024_add_request_log_hourly_by_owner_final
CREATE VIEW IF NOT EXISTS request_log_hourly_by_owner_final
(
    `app_owner_id` UInt64,
    `app_owner_is_user` UInt8,
    `grouped_at_hour` DateTime,
    `total_requests` UInt64,
    `cached_requests` UInt64,
    `pct_cached` Float64,
    `http_2xx` UInt64,
    `http_3xx` UInt64,
    `http_4xx` UInt64,
    `http_5xx` UInt64,
    `http_other` UInt64,
    `total_duration_millis` UInt64,
    `unique_users` UInt64,
    `total_data_served_bytes` UInt64,
    `total_data_cached_bytes` UInt64,
    `total_data_received_bytes` UInt64
)
AS SELECT
    app_owner_id,
    app_owner_is_user,
    grouped_at_hour,
    countMerge(http_total_count) AS total_requests,
    sumMerge(cached_count) AS cached_requests,
    if(countMerge(http_total_count) = 0, 0., sumMerge(cached_count) / countMerge(http_total_count)) AS pct_cached,
    sumMerge(http_2xx_count) AS http_2xx,
    sumMerge(http_3xx_count) AS http_3xx,
    sumMerge(http_4xx_count) AS http_4xx,
    sumMerge(http_5xx_count) AS http_5xx,
    sumMerge(http_other_count) AS http_other,
    sumMerge(http_total_duration_millis) AS total_duration_millis,
    uniqCombined64Merge(unique_users_ipv6) AS unique_users,
    sumMerge(total_data_served_bytes) AS total_data_served_bytes,
    sumMerge(total_data_cached_bytes) AS total_data_cached_bytes,
    sumMerge(total_data_received_bytes) AS total_data_received_bytes
FROM request_log_hourly_by_owner
GROUP BY
    app_owner_id,
    app_owner_is_user,
    grouped_at_hour
;

-- 0025_add_request_log_daily_by_owner_app_final
CREATE VIEW IF NOT EXISTS request_log_daily_by_owner_app_final
(
    `app_owner_id` UInt64,
    `app_owner_is_user` UInt8,
    `app_id` UInt64,
    `grouped_at_day` Date,
    `total_requests` UInt64,
    `cached_requests` UInt64,
    `pct_cached` Float64,
    `http_2xx` UInt64,
    `http_3xx` UInt64,
    `http_4xx` UInt64,
    `http_5xx` UInt64,
    `http_other` UInt64,
    `total_duration_millis` UInt64,
    `unique_users` UInt64,
    `total_data_served_bytes` UInt64,
    `total_data_cached_bytes` UInt64,
    `total_data_received_bytes` UInt64,
    `edge_outcome_success` UInt64
)
AS SELECT
    app_owner_id,
    app_owner_is_user,
    app_id,
    grouped_at_day,
    countMerge(http_total_count) AS total_requests,
    sumMerge(cached_count) AS cached_requests,
    if(countMerge(http_total_count) = 0, 0., sumMerge(cached_count) / countMerge(http_total_count)) AS pct_cached,
    sumMerge(http_2xx_count) AS http_2xx,
    sumMerge(http_3xx_count) AS http_3xx,
    sumMerge(http_4xx_count) AS http_4xx,
    sumMerge(http_5xx_count) AS http_5xx,
    sumMerge(http_other_count) AS http_other,
    sumMerge(http_total_duration_millis) AS total_duration_millis,
    uniqCombined64Merge(unique_users_ipv6) AS unique_users,
    sumMerge(total_data_served_bytes) AS total_data_served_bytes,
    sumMerge(total_data_cached_bytes) AS total_data_cached_bytes,
    sumMerge(total_data_received_bytes) AS total_data_received_bytes,
    sumMerge(edge_outcome_success) AS edge_outcome_success
FROM request_log_daily_by_owner_app
GROUP BY
    app_owner_id,
    app_owner_is_user,
    app_id,
    grouped_at_day
;

-- 0026_add_request_log_daily_by_owner_final
CREATE VIEW IF NOT EXISTS request_log_daily_by_owner_final
(
    `app_owner_id` UInt64,
    `app_owner_is_user` UInt8,
    `grouped_at_day` Date,
    `total_requests` UInt64,
    `cached_requests` UInt64,
    `pct_cached` Float64,
    `http_2xx` UInt64,
    `http_3xx` UInt64,
    `http_4xx` UInt64,
    `http_5xx` UInt64,
    `http_other` UInt64,
    `total_duration_millis` UInt64,
    `unique_users` UInt64,
    `total_data_served_bytes` UInt64,
    `total_data_cached_bytes` UInt64,
    `total_data_received_bytes` UInt64,
    `edge_outcome_success` UInt64
)
AS SELECT
    app_owner_id,
    app_owner_is_user,
    grouped_at_day,
    countMerge(http_total_count) AS total_requests,
    sumMerge(cached_count) AS cached_requests,
    if(countMerge(http_total_count) = 0, 0., sumMerge(cached_count) / countMerge(http_total_count)) AS pct_cached,
    sumMerge(http_2xx_count) AS http_2xx,
    sumMerge(http_3xx_count) AS http_3xx,
    sumMerge(http_4xx_count) AS http_4xx,
    sumMerge(http_5xx_count) AS http_5xx,
    sumMerge(http_other_count) AS http_other,
    sumMerge(http_total_duration_millis) AS total_duration_millis,
    uniqCombined64Merge(unique_users_ipv6) AS unique_users,
    sumMerge(total_data_served_bytes) AS total_data_served_bytes,
    sumMerge(total_data_cached_bytes) AS total_data_cached_bytes,
    sumMerge(total_data_received_bytes) AS total_data_received_bytes,
    sumMerge(edge_outcome_success) AS edge_outcome_success
FROM request_log_daily_by_owner
GROUP BY
    app_owner_id,
    app_owner_is_user,
    grouped_at_day
;

-- 0027_add_mv_request_log_to_hourly
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_request_log_to_hourly TO request_log_hourly
(
    `external_id` LowCardinality(String),
    `grouped_at_hour` DateTime,
    `http_total_count` AggregateFunction(count),
    `http_2xx_count` AggregateFunction(sum, UInt64),
    `http_3xx_count` AggregateFunction(sum, UInt64),
    `http_4xx_count` AggregateFunction(sum, UInt64),
    `http_5xx_count` AggregateFunction(sum, UInt64),
    `http_other_count` AggregateFunction(sum, UInt64),
    `http_total_duration_millis` AggregateFunction(sum, UInt64),
    `edge_outcome_success` AggregateFunction(sum, UInt8)
)
AS SELECT
    external_id,
    toStartOfHour(received_at) AS grouped_at_hour,
    countState() AS http_total_count,
    sumState(toUInt64((response_http_status >= 200) AND (response_http_status < 300))) AS http_2xx_count,
    sumState(toUInt64((response_http_status >= 300) AND (response_http_status < 400))) AS http_3xx_count,
    sumState(toUInt64((response_http_status >= 400) AND (response_http_status < 500))) AS http_4xx_count,
    sumState(toUInt64((response_http_status >= 500) AND (response_http_status < 600))) AS http_5xx_count,
    sumState(toUInt64((response_http_status < 200) OR (response_http_status >= 600))) AS http_other_count,
    sumState(toUInt64(total_duration_microseconds / 1000)) AS http_total_duration_millis,
    sumState(toUInt8(outcome = 'success')) AS edge_outcome_success
FROM request_log
GROUP BY
    external_id,
    grouped_at_hour
;

-- 0028_add_mv_request_log_to_hourly_by_owner_app
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_request_log_to_hourly_by_owner_app TO request_log_hourly_by_owner_app
(
    `app_owner_id` UInt64,
    `app_owner_is_user` Bool,
    `app_id` UInt64,
    `grouped_at_hour` DateTime,
    `http_total_count` AggregateFunction(count),
    `cached_count` AggregateFunction(sum, UInt64),
    `http_2xx_count` AggregateFunction(sum, UInt64),
    `http_3xx_count` AggregateFunction(sum, UInt64),
    `http_4xx_count` AggregateFunction(sum, UInt64),
    `http_5xx_count` AggregateFunction(sum, UInt64),
    `http_other_count` AggregateFunction(sum, UInt64),
    `http_total_duration_millis` AggregateFunction(sum, UInt64),
    `unique_users_ipv6` AggregateFunction(uniqCombined64, UInt64),
    `total_data_served_bytes` AggregateFunction(sum, UInt64),
    `total_data_cached_bytes` AggregateFunction(sum, UInt64),
    `total_data_received_bytes` AggregateFunction(sum, UInt64),
    `edge_outcome_success` AggregateFunction(sum, UInt8)
)
AS SELECT
    app_owner_id,
    app_owner_is_user,
    app_id,
    toStartOfHour(received_at) AS grouped_at_hour,
    countState() AS http_total_count,
    sumState(toUInt64(response_from_cache)) AS cached_count,
    sumState(toUInt64((response_http_status >= 200) AND (response_http_status < 300))) AS http_2xx_count,
    sumState(toUInt64((response_http_status >= 300) AND (response_http_status < 400))) AS http_3xx_count,
    sumState(toUInt64((response_http_status >= 400) AND (response_http_status < 500))) AS http_4xx_count,
    sumState(toUInt64((response_http_status >= 500) AND (response_http_status < 600))) AS http_5xx_count,
    sumState(toUInt64((response_http_status < 200) OR (response_http_status >= 600))) AS http_other_count,
    sumState(toUInt64(total_duration_microseconds / 1000)) AS http_total_duration_millis,
    uniqCombined64State(cityHash64(client_ipv6)) AS unique_users_ipv6,
    sumState(response_body_size) AS total_data_served_bytes,
    sumState(if(response_from_cache, response_body_size, toUInt64(0))) AS total_data_cached_bytes,
    sumState(toUInt64(greatest(ifNull(request_body_size, 0), 0))) AS total_data_received_bytes,
    sumState(toUInt8(outcome = 'success')) AS edge_outcome_success
FROM request_log
WHERE (app_id != 0) AND (app_owner_id != 0)
GROUP BY
    app_owner_id,
    app_owner_is_user,
    app_id,
    grouped_at_hour
;

-- 0029_add_mv_request_log_hourly_owner_app_to_owner
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_request_log_hourly_owner_app_to_owner TO request_log_hourly_by_owner
(
    `app_owner_id` UInt64,
    `app_owner_is_user` UInt8,
    `grouped_at_hour` DateTime,
    `http_total_count` AggregateFunction(count),
    `cached_count` AggregateFunction(sum, UInt64),
    `http_2xx_count` AggregateFunction(sum, UInt64),
    `http_3xx_count` AggregateFunction(sum, UInt64),
    `http_4xx_count` AggregateFunction(sum, UInt64),
    `http_5xx_count` AggregateFunction(sum, UInt64),
    `http_other_count` AggregateFunction(sum, UInt64),
    `http_total_duration_millis` AggregateFunction(sum, UInt64),
    `unique_users_ipv6` AggregateFunction(uniqCombined64, UInt64),
    `total_data_served_bytes` AggregateFunction(sum, UInt64),
    `total_data_cached_bytes` AggregateFunction(sum, UInt64),
    `total_data_received_bytes` AggregateFunction(sum, UInt64),
    `edge_outcome_success` AggregateFunction(sum, UInt8)
)
AS SELECT
    app_owner_id,
    app_owner_is_user,
    grouped_at_hour,
    countMergeState(http_total_count) AS http_total_count,
    sumMergeState(cached_count) AS cached_count,
    sumMergeState(http_2xx_count) AS http_2xx_count,
    sumMergeState(http_3xx_count) AS http_3xx_count,
    sumMergeState(http_4xx_count) AS http_4xx_count,
    sumMergeState(http_5xx_count) AS http_5xx_count,
    sumMergeState(http_other_count) AS http_other_count,
    sumMergeState(http_total_duration_millis) AS http_total_duration_millis,
    uniqCombined64MergeState(unique_users_ipv6) AS unique_users_ipv6,
    sumMergeState(total_data_served_bytes) AS total_data_served_bytes,
    sumMergeState(total_data_cached_bytes) AS total_data_cached_bytes,
    sumMergeState(total_data_received_bytes) AS total_data_received_bytes,
    sumMergeState(edge_outcome_success) AS edge_outcome_success
FROM request_log_hourly_by_owner_app
GROUP BY
    app_owner_id,
    app_owner_is_user,
    grouped_at_hour
;

-- 0030_add_mv_request_log_hourly_to_daily_by_owner_app
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_request_log_hourly_to_daily_by_owner_app TO request_log_daily_by_owner_app
(
    `app_owner_id` UInt64,
    `app_owner_is_user` UInt8,
    `app_id` UInt64,
    `grouped_at_day` Date,
    `http_total_count` AggregateFunction(count),
    `cached_count` AggregateFunction(sum, UInt64),
    `http_2xx_count` AggregateFunction(sum, UInt64),
    `http_3xx_count` AggregateFunction(sum, UInt64),
    `http_4xx_count` AggregateFunction(sum, UInt64),
    `http_5xx_count` AggregateFunction(sum, UInt64),
    `http_other_count` AggregateFunction(sum, UInt64),
    `http_total_duration_millis` AggregateFunction(sum, UInt64),
    `unique_users_ipv6` AggregateFunction(uniqCombined64, UInt64),
    `total_data_served_bytes` AggregateFunction(sum, UInt64),
    `total_data_cached_bytes` AggregateFunction(sum, UInt64),
    `total_data_received_bytes` AggregateFunction(sum, UInt64),
    `edge_outcome_success` AggregateFunction(sum, UInt8)
)
AS SELECT
    app_owner_id,
    app_owner_is_user,
    app_id,
    toDate(grouped_at_hour) AS grouped_at_day,
    countMergeState(http_total_count) AS http_total_count,
    sumMergeState(cached_count) AS cached_count,
    sumMergeState(http_2xx_count) AS http_2xx_count,
    sumMergeState(http_3xx_count) AS http_3xx_count,
    sumMergeState(http_4xx_count) AS http_4xx_count,
    sumMergeState(http_5xx_count) AS http_5xx_count,
    sumMergeState(http_other_count) AS http_other_count,
    sumMergeState(http_total_duration_millis) AS http_total_duration_millis,
    uniqCombined64MergeState(unique_users_ipv6) AS unique_users_ipv6,
    sumMergeState(total_data_served_bytes) AS total_data_served_bytes,
    sumMergeState(total_data_cached_bytes) AS total_data_cached_bytes,
    sumMergeState(total_data_received_bytes) AS total_data_received_bytes,
    sumMergeState(edge_outcome_success) AS edge_outcome_success
FROM request_log_hourly_by_owner_app
GROUP BY
    app_owner_id,
    app_owner_is_user,
    app_id,
    grouped_at_day
;

-- 0031_add_mv_request_log_hourly_owner_to_daily_owner
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_request_log_hourly_owner_to_daily_owner TO request_log_daily_by_owner
(
    `app_owner_id` UInt64,
    `app_owner_is_user` UInt8,
    `grouped_at_day` Date,
    `http_total_count` AggregateFunction(count),
    `cached_count` AggregateFunction(sum, UInt64),
    `http_2xx_count` AggregateFunction(sum, UInt64),
    `http_3xx_count` AggregateFunction(sum, UInt64),
    `http_4xx_count` AggregateFunction(sum, UInt64),
    `http_5xx_count` AggregateFunction(sum, UInt64),
    `http_other_count` AggregateFunction(sum, UInt64),
    `http_total_duration_millis` AggregateFunction(sum, UInt64),
    `unique_users_ipv6` AggregateFunction(uniqCombined64, UInt64),
    `total_data_served_bytes` AggregateFunction(sum, UInt64),
    `total_data_cached_bytes` AggregateFunction(sum, UInt64),
    `total_data_received_bytes` AggregateFunction(sum, UInt64),
    `edge_outcome_success` AggregateFunction(sum, UInt8)
)
AS SELECT
    app_owner_id,
    app_owner_is_user,
    toDate(grouped_at_hour) AS grouped_at_day,
    countMergeState(http_total_count) AS http_total_count,
    sumMergeState(cached_count) AS cached_count,
    sumMergeState(http_2xx_count) AS http_2xx_count,
    sumMergeState(http_3xx_count) AS http_3xx_count,
    sumMergeState(http_4xx_count) AS http_4xx_count,
    sumMergeState(http_5xx_count) AS http_5xx_count,
    sumMergeState(http_other_count) AS http_other_count,
    sumMergeState(http_total_duration_millis) AS http_total_duration_millis,
    uniqCombined64MergeState(unique_users_ipv6) AS unique_users_ipv6,
    sumMergeState(total_data_served_bytes) AS total_data_served_bytes,
    sumMergeState(total_data_cached_bytes) AS total_data_cached_bytes,
    sumMergeState(total_data_received_bytes) AS total_data_received_bytes,
    sumMergeState(edge_outcome_success) AS edge_outcome_success
FROM request_log_hourly_by_owner
GROUP BY
    app_owner_id,
    app_owner_is_user,
    grouped_at_day
;

-- 0032_add_workload_metrics_summary_hourly_by_owner_app
CREATE TABLE IF NOT EXISTS workload_metrics_summary_hourly_by_owner_app
(
    `app_owner_id` UInt64,
    `app_owner_is_user` UInt8,
    `app_id` UInt64,
    `grouped_at_hour` DateTime,
    `workloads_total` AggregateFunction(count),
    `workloads_llvm` AggregateFunction(sum, UInt64),
    `workloads_cranelift` AggregateFunction(sum, UInt64),
    `wall_cpu_time_millis` AggregateFunction(sum, UInt64),
    `real_cpu_time_millis` AggregateFunction(sum, UInt64),
    `network_ingress_bytes` AggregateFunction(sum, UInt64),
    `network_egress_bytes` AggregateFunction(sum, UInt64),
    `memory_time_kbs` AggregateFunction(sum, UInt64)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(grouped_at_hour)
ORDER BY (app_owner_id, app_owner_is_user, app_id, grouped_at_hour)
SETTINGS index_granularity = 8192
;

-- 0033_add_workload_metrics_summary_hourly_by_owner
CREATE TABLE IF NOT EXISTS workload_metrics_summary_hourly_by_owner
(
    `app_owner_id` UInt64,
    `app_owner_is_user` UInt8,
    `grouped_at_hour` DateTime,
    `workloads_total` AggregateFunction(count),
    `workloads_llvm` AggregateFunction(sum, UInt64),
    `workloads_cranelift` AggregateFunction(sum, UInt64),
    `wall_cpu_time_millis` AggregateFunction(sum, UInt64),
    `real_cpu_time_millis` AggregateFunction(sum, UInt64),
    `network_ingress_bytes` AggregateFunction(sum, UInt64),
    `network_egress_bytes` AggregateFunction(sum, UInt64),
    `memory_time_kbs` AggregateFunction(sum, UInt64)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(grouped_at_hour)
ORDER BY (app_owner_id, app_owner_is_user, grouped_at_hour)
SETTINGS index_granularity = 8192
;

-- 0034_add_workload_metrics_summary_daily_by_owner_app
CREATE TABLE IF NOT EXISTS workload_metrics_summary_daily_by_owner_app
(
    `app_owner_id` UInt64,
    `app_owner_is_user` UInt8,
    `app_id` UInt64,
    `grouped_at_day` Date,
    `workloads_total` AggregateFunction(count),
    `workloads_llvm` AggregateFunction(sum, UInt64),
    `workloads_cranelift` AggregateFunction(sum, UInt64),
    `wall_cpu_time_millis` AggregateFunction(sum, UInt64),
    `real_cpu_time_millis` AggregateFunction(sum, UInt64),
    `network_ingress_bytes` AggregateFunction(sum, UInt64),
    `network_egress_bytes` AggregateFunction(sum, UInt64),
    `memory_time_kbs` AggregateFunction(sum, UInt64)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(grouped_at_day)
ORDER BY (app_owner_id, app_owner_is_user, app_id, grouped_at_day)
SETTINGS index_granularity = 8192
;

-- 0035_add_workload_metrics_summary_daily_by_owner
CREATE TABLE IF NOT EXISTS workload_metrics_summary_daily_by_owner
(
    `app_owner_id` UInt64,
    `app_owner_is_user` UInt8,
    `grouped_at_day` Date,
    `workloads_total` AggregateFunction(count),
    `workloads_llvm` AggregateFunction(sum, UInt64),
    `workloads_cranelift` AggregateFunction(sum, UInt64),
    `wall_cpu_time_millis` AggregateFunction(sum, UInt64),
    `real_cpu_time_millis` AggregateFunction(sum, UInt64),
    `network_ingress_bytes` AggregateFunction(sum, UInt64),
    `network_egress_bytes` AggregateFunction(sum, UInt64),
    `memory_time_kbs` AggregateFunction(sum, UInt64)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(grouped_at_day)
ORDER BY (app_owner_id, app_owner_is_user, grouped_at_day)
SETTINGS index_granularity = 8192
;

-- 0036_add_workload_metrics_summary_hourly_by_owner_app_final
CREATE VIEW IF NOT EXISTS workload_metrics_summary_hourly_by_owner_app_final
(
    `app_owner_id` UInt64,
    `app_owner_is_user` UInt8,
    `app_id` UInt64,
    `grouped_at_hour` DateTime,
    `workloads_total` UInt64,
    `workloads_llvm` UInt64,
    `workloads_cranelift` UInt64,
    `wall_cpu_time_millis` UInt64,
    `real_cpu_time_millis` UInt64,
    `network_ingress_bytes` UInt64,
    `network_egress_bytes` UInt64,
    `memory_time_kbs` UInt64
)
AS SELECT
    app_owner_id,
    app_owner_is_user,
    app_id,
    grouped_at_hour,
    countMerge(workloads_total) AS workloads_total,
    sumMerge(workloads_llvm) AS workloads_llvm,
    sumMerge(workloads_cranelift) AS workloads_cranelift,
    sumMerge(wall_cpu_time_millis) AS wall_cpu_time_millis,
    sumMerge(real_cpu_time_millis) AS real_cpu_time_millis,
    sumMerge(network_ingress_bytes) AS network_ingress_bytes,
    sumMerge(network_egress_bytes) AS network_egress_bytes,
    sumMerge(memory_time_kbs) AS memory_time_kbs
FROM workload_metrics_summary_hourly_by_owner_app
GROUP BY
    app_owner_id,
    app_owner_is_user,
    app_id,
    grouped_at_hour
;

-- 0037_add_workload_metrics_summary_hourly_by_owner_final
CREATE VIEW IF NOT EXISTS workload_metrics_summary_hourly_by_owner_final
(
    `app_owner_id` UInt64,
    `app_owner_is_user` UInt8,
    `grouped_at_hour` DateTime,
    `workloads_total` UInt64,
    `workloads_llvm` UInt64,
    `workloads_cranelift` UInt64,
    `wall_cpu_time_millis` UInt64,
    `real_cpu_time_millis` UInt64,
    `network_ingress_bytes` UInt64,
    `network_egress_bytes` UInt64,
    `memory_time_kbs` UInt64
)
AS SELECT
    app_owner_id,
    app_owner_is_user,
    grouped_at_hour,
    countMerge(workloads_total) AS workloads_total,
    sumMerge(workloads_llvm) AS workloads_llvm,
    sumMerge(workloads_cranelift) AS workloads_cranelift,
    sumMerge(wall_cpu_time_millis) AS wall_cpu_time_millis,
    sumMerge(real_cpu_time_millis) AS real_cpu_time_millis,
    sumMerge(network_ingress_bytes) AS network_ingress_bytes,
    sumMerge(network_egress_bytes) AS network_egress_bytes,
    sumMerge(memory_time_kbs) AS memory_time_kbs
FROM workload_metrics_summary_hourly_by_owner
GROUP BY
    app_owner_id,
    app_owner_is_user,
    grouped_at_hour
;

-- 0038_add_workload_metrics_summary_daily_by_owner_app_final
CREATE VIEW IF NOT EXISTS workload_metrics_summary_daily_by_owner_app_final
(
    `app_owner_id` UInt64,
    `app_owner_is_user` UInt8,
    `app_id` UInt64,
    `grouped_at_day` Date,
    `workloads_total` UInt64,
    `workloads_llvm` UInt64,
    `workloads_cranelift` UInt64,
    `wall_cpu_time_millis` UInt64,
    `real_cpu_time_millis` UInt64,
    `network_ingress_bytes` UInt64,
    `network_egress_bytes` UInt64,
    `memory_time_kbs` UInt64
)
AS SELECT
    app_owner_id,
    app_owner_is_user,
    app_id,
    grouped_at_day,
    countMerge(workloads_total) AS workloads_total,
    sumMerge(workloads_llvm) AS workloads_llvm,
    sumMerge(workloads_cranelift) AS workloads_cranelift,
    sumMerge(wall_cpu_time_millis) AS wall_cpu_time_millis,
    sumMerge(real_cpu_time_millis) AS real_cpu_time_millis,
    sumMerge(network_ingress_bytes) AS network_ingress_bytes,
    sumMerge(network_egress_bytes) AS network_egress_bytes,
    sumMerge(memory_time_kbs) AS memory_time_kbs
FROM workload_metrics_summary_daily_by_owner_app
GROUP BY
    app_owner_id,
    app_owner_is_user,
    app_id,
    grouped_at_day
;

-- 0039_add_workload_metrics_summary_daily_by_owner_final
CREATE VIEW IF NOT EXISTS workload_metrics_summary_daily_by_owner_final
(
    `app_owner_id` UInt64,
    `app_owner_is_user` UInt8,
    `grouped_at_day` Date,
    `workloads_total` UInt64,
    `workloads_llvm` UInt64,
    `workloads_cranelift` UInt64,
    `wall_cpu_time_millis` UInt64,
    `real_cpu_time_millis` UInt64,
    `network_ingress_bytes` UInt64,
    `network_egress_bytes` UInt64,
    `memory_time_kbs` UInt64
)
AS SELECT
    app_owner_id,
    app_owner_is_user,
    grouped_at_day,
    countMerge(workloads_total) AS workloads_total,
    sumMerge(workloads_llvm) AS workloads_llvm,
    sumMerge(workloads_cranelift) AS workloads_cranelift,
    sumMerge(wall_cpu_time_millis) AS wall_cpu_time_millis,
    sumMerge(real_cpu_time_millis) AS real_cpu_time_millis,
    sumMerge(network_ingress_bytes) AS network_ingress_bytes,
    sumMerge(network_egress_bytes) AS network_egress_bytes,
    sumMerge(memory_time_kbs) AS memory_time_kbs
FROM workload_metrics_summary_daily_by_owner
GROUP BY
    app_owner_id,
    app_owner_is_user,
    grouped_at_day
;

-- 0040_add_mv_workload_metrics_summary_to_hourly_by_owner_app
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_workload_metrics_summary_to_hourly_by_owner_app TO workload_metrics_summary_hourly_by_owner_app
(
    `app_owner_id` UInt64,
    `app_owner_is_user` Bool,
    `app_id` UInt64,
    `grouped_at_hour` DateTime,
    `workloads_total` AggregateFunction(count),
    `workloads_llvm` AggregateFunction(sum, UInt64),
    `workloads_cranelift` AggregateFunction(sum, UInt64),
    `wall_cpu_time_millis` AggregateFunction(sum, UInt64),
    `real_cpu_time_millis` AggregateFunction(sum, UInt64),
    `network_ingress_bytes` AggregateFunction(sum, UInt64),
    `network_egress_bytes` AggregateFunction(sum, UInt64),
    `memory_time_kbs` AggregateFunction(sum, UInt64)
)
AS SELECT
    app_owner_id,
    app_owner_is_user,
    app_id,
    toStartOfHour(completed_at) AS grouped_at_hour,
    countState() AS workloads_total,
    sumState(toUInt64(engine = 'wasmer-llvm')) AS workloads_llvm,
    sumState(toUInt64(engine = 'wasmer-cranelift')) AS workloads_cranelift,
    sumState(cpu_time_millis) AS wall_cpu_time_millis,
    sumState(real_cpu_time_millis) AS real_cpu_time_millis,
    sumState(network_ingress_kb * 1024) AS network_ingress_bytes,
    sumState(network_egress_kb * 1024) AS network_egress_bytes,
    sumState(memory_time_kbs) AS memory_time_kbs
FROM workload_metrics_summary
WHERE (app_id != 0) AND (app_owner_id != 0) AND (status = 'finished')
GROUP BY
    app_owner_id,
    app_owner_is_user,
    app_id,
    grouped_at_hour
;

-- 0041_add_mv_workload_metrics_summary_hourly_owner_app_to_owner
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_workload_metrics_summary_hourly_owner_app_to_owner TO workload_metrics_summary_hourly_by_owner
(
    `app_owner_id` UInt64,
    `app_owner_is_user` UInt8,
    `grouped_at_hour` DateTime,
    `workloads_total` AggregateFunction(count),
    `workloads_llvm` AggregateFunction(sum, UInt64),
    `workloads_cranelift` AggregateFunction(sum, UInt64),
    `wall_cpu_time_millis` AggregateFunction(sum, UInt64),
    `real_cpu_time_millis` AggregateFunction(sum, UInt64),
    `network_ingress_bytes` AggregateFunction(sum, UInt64),
    `network_egress_bytes` AggregateFunction(sum, UInt64),
    `memory_time_kbs` AggregateFunction(sum, UInt64)
)
AS SELECT
    app_owner_id,
    app_owner_is_user,
    grouped_at_hour,
    countMergeState(workloads_total) AS workloads_total,
    sumMergeState(workloads_llvm) AS workloads_llvm,
    sumMergeState(workloads_cranelift) AS workloads_cranelift,
    sumMergeState(wall_cpu_time_millis) AS wall_cpu_time_millis,
    sumMergeState(real_cpu_time_millis) AS real_cpu_time_millis,
    sumMergeState(network_ingress_bytes) AS network_ingress_bytes,
    sumMergeState(network_egress_bytes) AS network_egress_bytes,
    sumMergeState(memory_time_kbs) AS memory_time_kbs
FROM workload_metrics_summary_hourly_by_owner_app
GROUP BY
    app_owner_id,
    app_owner_is_user,
    grouped_at_hour
;

-- 0042_add_mv_workload_metrics_summary_hourly_to_daily_by_owner_app
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_workload_metrics_summary_hourly_to_daily_by_owner_app TO workload_metrics_summary_daily_by_owner_app
(
    `app_owner_id` UInt64,
    `app_owner_is_user` UInt8,
    `app_id` UInt64,
    `grouped_at_day` Date,
    `workloads_total` AggregateFunction(count),
    `workloads_llvm` AggregateFunction(sum, UInt64),
    `workloads_cranelift` AggregateFunction(sum, UInt64),
    `wall_cpu_time_millis` AggregateFunction(sum, UInt64),
    `real_cpu_time_millis` AggregateFunction(sum, UInt64),
    `network_ingress_bytes` AggregateFunction(sum, UInt64),
    `network_egress_bytes` AggregateFunction(sum, UInt64),
    `memory_time_kbs` AggregateFunction(sum, UInt64)
)
AS SELECT
    app_owner_id,
    app_owner_is_user,
    app_id,
    toDate(grouped_at_hour) AS grouped_at_day,
    countMergeState(workloads_total) AS workloads_total,
    sumMergeState(workloads_llvm) AS workloads_llvm,
    sumMergeState(workloads_cranelift) AS workloads_cranelift,
    sumMergeState(wall_cpu_time_millis) AS wall_cpu_time_millis,
    sumMergeState(real_cpu_time_millis) AS real_cpu_time_millis,
    sumMergeState(network_ingress_bytes) AS network_ingress_bytes,
    sumMergeState(network_egress_bytes) AS network_egress_bytes,
    sumMergeState(memory_time_kbs) AS memory_time_kbs
FROM workload_metrics_summary_hourly_by_owner_app
GROUP BY
    app_owner_id,
    app_owner_is_user,
    app_id,
    grouped_at_day
;

-- 0043_add_mv_workload_metrics_summary_hourly_owner_to_daily_owner
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_workload_metrics_summary_hourly_owner_to_daily_owner TO workload_metrics_summary_daily_by_owner
(
    `app_owner_id` UInt64,
    `app_owner_is_user` UInt8,
    `grouped_at_day` Date,
    `workloads_total` AggregateFunction(count),
    `workloads_llvm` AggregateFunction(sum, UInt64),
    `workloads_cranelift` AggregateFunction(sum, UInt64),
    `wall_cpu_time_millis` AggregateFunction(sum, UInt64),
    `real_cpu_time_millis` AggregateFunction(sum, UInt64),
    `network_ingress_bytes` AggregateFunction(sum, UInt64),
    `network_egress_bytes` AggregateFunction(sum, UInt64),
    `memory_time_kbs` AggregateFunction(sum, UInt64)
)
AS SELECT
    app_owner_id,
    app_owner_is_user,
    toDate(grouped_at_hour) AS grouped_at_day,
    countMergeState(workloads_total) AS workloads_total,
    sumMergeState(workloads_llvm) AS workloads_llvm,
    sumMergeState(workloads_cranelift) AS workloads_cranelift,
    sumMergeState(wall_cpu_time_millis) AS wall_cpu_time_millis,
    sumMergeState(real_cpu_time_millis) AS real_cpu_time_millis,
    sumMergeState(network_ingress_bytes) AS network_ingress_bytes,
    sumMergeState(network_egress_bytes) AS network_egress_bytes,
    sumMergeState(memory_time_kbs) AS memory_time_kbs
FROM workload_metrics_summary_hourly_by_owner
GROUP BY
    app_owner_id,
    app_owner_is_user,
    grouped_at_day
;

-- 0044_create_app_logs_table
CREATE TABLE IF NOT EXISTS app_logs
(
    timestamp DateTime64(9) CODEC(Delta(8), ZSTD(1)),
    app_id UInt64,
    app_version_id UInt64 DEFAULT 0,
    stream Enum8('Unknown' = 0, 'Stdout' = 1, 'Stderr' = 2, 'Runtime' = 3),
    message String CODEC(ZSTD(1)),
    instance_id UUID,
    job_uid UUID,
    -- Supports case-insensitive substring searches on message via lower(message) LIKE '%...%'.
    -- Review against ClickHouse ngrambf_v1 skipping-index guidance if search patterns change.
    INDEX idx_message_ngram lower(message) TYPE ngrambf_v1(3, 10000, 3, 7) GRANULARITY 1
)
ENGINE = MergeTree
PARTITION BY toDate(timestamp)
ORDER BY (app_id, timestamp, app_version_id, instance_id)
TTL toDateTime(timestamp) + toIntervalDay(14)
SETTINGS ttl_only_drop_parts = 1
;
