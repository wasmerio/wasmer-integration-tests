#!/usr/bin/env node
/* global console, process */

import fs from "node:fs";
import path from "node:path";

const runDir = process.argv[2] ? path.resolve(process.argv[2]) : null;
const bootstrapOutputPath = process.argv[3]
  ? path.resolve(process.argv[3])
  : null;
const outputPath = process.argv[4] ? path.resolve(process.argv[4]) : null;

if (!runDir || !bootstrapOutputPath || !outputPath) {
  console.error(
    "usage: generate-edge-config.mjs <run-dir> <bootstrap-output> <output-path>",
  );
  process.exit(2);
}

function readRequired(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (err) {
    throw new Error(`Failed to read ${filePath}: ${err.message}`);
  }
}

function matchRequired(raw, regex, label) {
  const match = raw.match(regex);
  if (!match) {
    throw new Error(`Could not find ${label}`);
  }
  return match[1];
}

function indentBlock(raw, spaces) {
  const indent = " ".repeat(spaces);
  return raw
    .trimEnd()
    .split("\n")
    .map((line) => `${indent}${line}`)
    .join("\n");
}

const bootstrapOutput = readRequired(bootstrapOutputPath);
const backendEnv = readRequired(path.join(runDir, "backend.env"));
const publicKeyPem = readRequired(
  path.join(runDir, "state", "keys", "deploy_jwt_public_key.pem"),
).trimEnd();

const edgeToken = matchRequired(
  bootstrapOutput,
  /^EDGE_SYNC_TOKEN=(.+)$/m,
  "EDGE_SYNC_TOKEN in bootstrap output",
).trim();
const secretPrivateKey = matchRequired(
  backendEnv,
  /^export EDGE_SYMMETRIC_KEY="([^"]+)"$/m,
  "EDGE_SYMMETRIC_KEY in backend.env",
);

const backendBaseUrl =
  process.env.LOCAL_PLATFORM_EDGE_BACKEND_URL ?? "http://backend:8000";
const vectorEndpoint =
  process.env.LOCAL_PLATFORM_EDGE_VECTOR_ENDPOINT ?? "http://vector:9089";
const clickhouseUrl =
  process.env.LOCAL_PLATFORM_EDGE_CLICKHOUSE_URL ??
  "http://default:root@clickhouse:8123";
const clickhouseDatabase =
  process.env.LOCAL_PLATFORM_EDGE_CLICKHOUSE_DATABASE ?? "edge_metrics_local";
const useLlvmEngine = /^(1|true|yes|on)$/i.test(
  process.env.LOCAL_PLATFORM_EDGE_ENABLE_LLVM ?? "",
);
const additionalEngines = useLlvmEngine
  ? `
      - kind: wasmer_llvm
        threads_per_compilation: 1
        filter:
          or:
            - artifact_cached
            - package_match: php/php-eh
            - package_match: php/php-32
            - package_match: php/php-64
            - package_match: php/php
            - package_match: wasmer/bash
            - package_match: wasmer/coreutils
            - package_match: wasmer/python
            - package_match: python/python
            - package_match: wasmer/static-web-server
            - package_match: wasmer/winterjs
            - package_match: wasmer/s3-server
            - package_match: wasmer/edgejs
            - package_match: wasmer/phpix-32
            - package_match: wasmer/phpix-64`
  : " []";

const config = `listen_mode: wildcard

webc_directories: []

confdb:
  backend:
    lmdb: {}
  enable_wal_file: true
  enable_quantum: false
  fixture_dirs: []
  snapshots:
    enabled: true
  sync:
    backend: ${backendBaseUrl}
    config:
      poll_interval: 1s
      use_distinct_queries: false

package_cache:
  registry_fallback: true

module_compilation_timeout: 900s

package_registries:
  - url: ${backendBaseUrl}
    api_endpoint: ${backendBaseUrl}/graphql
    auth_token: "${edgeToken}"
    is_default: true
    secret_private_key: "${secretPrivateKey}"

module_cache:
  memory:
    max_size: 5gb

runtime:
  napi:
    enabled: true
  pingora_grace_period: 10s
  pingora_graceful_shutdown_timeout: 20s
  engines:
    default_engine:
      kind: wasmer_cranelift
      threads_per_compilation: 1
    engines:${additionalEngines}

instance_runtime:
  async_runtime_mode: instance_shared
  instance_threads_min: 8
  instance_threads_max: 2048
  default_thread_parallelism: 2
  per_workload_max_thread_count: 12
  module_compilation_timeout: 900s
  enable_panic_tainting: true
  tokio_worker_thread_priority: 50
  cpu_load_1m_rejection_threshold: null
  cpu_usage_rejection_threshold: null
  memory_usage_rejection_threshold: 98.0
  memory_usage_with_swap_rejection_threshold: 95.0
  memory_swap_usage_rejection_threshold: 60.0
  collect_accessed_external_ips: true
  atomic_wait_timeouts: false

instance_networking:
  allow_private_ips: true

geo_ttl: 120s

http_proxy:
  enabled: true
  verbose_errors: false
  request_retries: 2
  retry_delay: 1s
  overload_backoff: null
  package_compilation_timeout: 900s
  cdn_cache:
    enabled: false
    directory: /data/edge-cdn-cache
    max_disk_usage: 128Mb
    max_object_size: 10Mb
    debug_always_cache: false

pingora:
  dns_threads: 2
  node_api_threads: 2
  ssh_threads: 2
  metrics_background_threads: 2
  utilities_background_threads: 2
  domain_resolver_background_threads: 2

gateway:
  ignore_https_redirect: false
  limits:
    concurrency: 2000
    request_timeout_secs: 900
    cname_recursive_limit: 5
    max_buffered_requests: 100
    connection_ip_rate_limit:
      per_second: 100
      burst: 500
  acme:
    enabled: true
    url: https://localhost:14000/dir
    force_self_signed: true
    storage:
      primary:
        fs:
          path: /data/acme

geolite_token: "PUT_TOKEN_HERE"
master_network_key: "local-dev-master-network-key"

recursive_dns_server: 8.8.8.8
dns_cache_capacity: 10000
host_resolver_cache_duration_success: 90sec
host_resolver_cache_duration_notfound: 30sec
host_resolver_cache_duration_failed: 10sec

socket:
  timeout_secs: 50
  keep_alive_secs: 40
  overlay_mtu: 1400
  reuse_instance_ttl_secs: 1
  reuse_last_instance_ttl_secs: 60
  reuse_instance_socket_pool_size: 128
  reuse_instance_scale_out_threshold: 96
  reuse_instance_max_permits_per_instance: 512
  reuse_instance_max_instances_per_node: 1
  proxy_connect_init_timeout_secs: 15
  proxy_connect_nominal_timeout_secs: 3
  proxy_connect_retries: 3
  proxy_send_timeout_secs: 20
  proxy_recv_timeout_secs: 900
  proxy_instance_acquire_timeout_secs: 900
  enable_socket_tainting: true
  instance_max_lifetime_graceful: 10s
  instance_max_lifetime_hard: 15s

http_gateway:
  limits:
    concurrency: 2000
    request_timeout_secs: 900
    cname_recursive_limit: 5
    max_buffered_requests: 100
    connection_ip_rate_limit:
      per_second: 100
      burst: 500
    connection_ip_rate_limit_trusted:
      per_second: 1000
      burst: 5000
    per_app_rate_limit_default: 1000
    per_app_rate_limit_max: 10000
  reuse_last_instance_ttl_secs: 10
  reuse_instance_socket_pool_size: 128
  reuse_instance_scale_out_threshold: 96
  reuse_instance_max_permits_per_instance: 512
  reuse_instance_max_instances_per_node: 1
  proxy_connect_init_timeout_secs: 15
  proxy_connect_nominal_timeout_secs: 3
  proxy_connect_retries: 3
  proxy_send_timeout_secs: 60
  proxy_recv_timeout_secs: 900
  enable_socket_tainting: true
  block_native_rst: false

cluster_dns_zone: "my.edge"
dns_server:
  default_contact_email: "admin@localhost"
  canonical_nameserver_domains:
    - alpha.ns.my.edge
    - beta.ns.my.edge
  storage: {}

metering:
  publish_interval: 15s
  persist_accessed_external_ips: true
  clickhouse:
    url: ${clickhouseUrl}
    database: ${clickhouseDatabase}

api:
  http_port: 9050
  grpc_port: 9051
  gateway_hostname: nodeapi.local
  tls: false

observability:
  disable_all: false
  tracing: {}
  blocked_task_trace:
    enabled: false
    warn_poll_threshold: 1ms
  tokio_console:
    enabled: false

instance_logging:
  default_receiver:
    vector_http:
      endpoint: "${vectorEndpoint}"

journals:
  bootstrap:
    retain_uncompacted_journal: true
    max_total_disk_usage: 1Gb

token_public_keys:
  - |
${indentBlock(publicKeyPem, 4)}

workloads:
  default_capabilities:
    memory:
      limit: 512Mb
    wasi:
      env_vars:
        - name: ENCRYPTED_TEST
          value: "testvalue123"
    logging:
      enabled: true
      capture_stdout: true
      capture_stderr: true
      capture_trap: true

volumes:
  local:
    path: /data/volumes

jobs:
  enabled: true
  storage: in_memory
  cronjobs:
    enabled: false
    max_concurrency_per_node: 2
    minimum_interval: 1s
  fetch_allow_invalid_certs: false

quantum:
  enabled: false
  accounts:
    - username: "admin"
      tokens: ["admin"]

ip_blacklist:
  enable_ipset: false

ssh_server:
  enabled: true
  private_key: |
    -----BEGIN OPENSSH PRIVATE KEY-----
    b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
    QyNTUxOQAAACB7chaOffrcmqOd5PoucHHkrl8qFcBHBsriE1pONPtDeAAAAJCFK9BMhSvQ
    TAAAAAtzc2gtZWQyNTUxOQAAACB7chaOffrcmqOd5PoucHHkrl8qFcBHBsriE1pONPtDeA
    AAAEBdSl4S3zMv+s1AYWJ+N7N46s7FLHJqgvktM+x2AbLYHXtyFo59+tyao53k+i5wceSu
    XyoVwEcGyuITWk40+0N4AAAAC0VkZ2Ugc2VydmVyAQI=
    -----END OPENSSH PRIVATE KEY-----

cluster:
  default_density: 1
  global_anycast_ips: []
  regions:
    - region_index: 0
      virtual_ips: []
      vendor: "wasmer"
      identifier: "local"
      geo_location:
        latitude: 60.1695
        longitude: 24.9355
      description: "devserver"
      nodes:
        - name: "devserver-1"
          node_index: 0
          hostname: "localhost"
          internal_ip4: 127.0.0.1
          active: true
          is_nameserver: true
          is_confdb_master: true
          local_volumes:
            path: "/data/volumes"
            allow_create_root: true
          global_ip4: 127.0.0.1
          global_ip6: "::1"
          ip_set: []
          default_ip_set: null
`;

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, config);
console.log(
  `[local-platform] wrote Edge config ${outputPath} (compile profile: ${useLlvmEngine ? "cranelift+llvm" : "cranelift-only"})`,
);
