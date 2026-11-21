//! PostgreSQL connection lifecycle, automatic database/schema migration, async log writer,
//! demo telemetry seeder, and read-only aggregation queries.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::str::FromStr;

use anyhow::{Context, Result};
use chrono::{DateTime, Duration, FixedOffset, NaiveDate, Utc};
use rustls::RootCertStore;
use rustls::pki_types::CertificateDer;
use serde_json::{Value, json};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::{PgPool, Row};
use tokio::sync::mpsc;
use tracing::{debug, error, info, warn};
use uuid::Uuid;

use crate::catalog::RuntimeCatalog;
use crate::config::{DatabaseConfig, UiConfig};
use crate::metrics_cache::{MetricSample, MetricsCache};
use crate::models::{
    ContributionDayCell, DailyModelDay, DailyModelSlice, FilterEntityItem, LeaderboardItem,
    OverviewResponse, OverviewSummary, RecentRequestItem, RequestLogRecord, TopModelSummary,
    infer_model_icon, infer_provider_icon,
};

/// Embedded `SQLx` migrations from `./migrations`.
static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

/// Async handle used by the proxy gateway to enqueue completed request telemetry
/// without blocking HTTP response delivery.
#[derive(Debug, Clone)]
pub struct LogWriterHandle {
    /// Bounded MPSC sender feeding the background DB writer task.
    tx: mpsc::Sender<RequestLogRecord>,
}

impl LogWriterHandle {
    /// Spawns the background log writer task and returns a cloneable handle.
    #[must_use]
    pub fn spawn(pool: PgPool, config: DatabaseConfig, tz_offset_secs: i32) -> Self {
        let (tx, mut rx) = mpsc::channel::<RequestLogRecord>(1024);
        tokio::spawn(async move {
            while let Some(record) = rx.recv().await {
                if let Err(err) = persist_request_log(&pool, &config, tz_offset_secs, &record).await
                {
                    error!(
                        request_uid = %record.request_uid,
                        error = %err,
                        "failed to persist request telemetry to PostgreSQL"
                    );
                }
            }
        });
        Self { tx }
    }

    /// Enqueues a request log record for asynchronous database insertion.
    pub fn send(&self, record: RequestLogRecord) {
        if let Err(err) = self.tx.try_send(record) {
            warn!(error = %err, "telemetry log channel full or closed; dropping record");
        }
    }
}

/// Initializes the PostgreSQL connection pool, automatically creating the target
/// database if it does not yet exist, and executes embedded `SQLx` migrations.
///
/// # Errors
/// Returns an error if the URL is invalid, connection fails, database creation fails,
/// or migrations fail.
pub async fn init_db_pool(config: &DatabaseConfig) -> Result<PgPool> {
    let connect_opts = PgConnectOptions::from_str(&config.url)
        .with_context(|| format!("invalid PostgreSQL connection URL '{}'", config.url))?;
    let pg_ssl_root_cert = std::env::var_os("PGSSLROOTCERT")
        .and_then(|v| v.into_string().ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let connect_opts =
        apply_system_ca_roots(connect_opts, &config.url, pg_ssl_root_cert.as_deref());
    let target_db = connect_opts
        .get_database()
        .unwrap_or("linguist")
        .to_string();

    let pool = match PgPoolOptions::new()
        .max_connections(config.max_connections.max(1))
        .connect_with(connect_opts.clone())
        .await
    {
        Ok(pool) => pool,
        Err(first_err) => {
            // Note: on Windows non-UTF8 PostgreSQL locales, missing database errors arrive as
            // `sqlx::Error::Protocol` when ErrorResponse contains localized non-UTF8 text.
            if is_missing_database_error(&first_err)
                || matches!(first_err, sqlx::Error::Protocol(_))
            {
                let created = ensure_database_exists(&connect_opts, &target_db).await?;
                if !created {
                    return Err(first_err).with_context(|| {
                        format!("failed to connect to PostgreSQL database '{target_db}'")
                    });
                }
                PgPoolOptions::new()
                    .max_connections(config.max_connections.max(1))
                    .connect_with(connect_opts)
                    .await
                    .with_context(|| {
                        format!("failed to connect to newly created database '{target_db}'")
                    })?
            } else {
                return Err(first_err).with_context(|| {
                    format!("failed to connect to PostgreSQL database '{target_db}'")
                });
            }
        }
    };

    MIGRATOR
        .run(&pool)
        .await
        .context("failed to apply PostgreSQL migrations")?;

    Ok(pool)
}

/// Detects SQLSTATE `3D000` (`invalid_catalog_name` / database does not exist).
fn is_missing_database_error(err: &sqlx::Error) -> bool {
    if let sqlx::Error::Database(db_err) = err {
        return db_err.code().as_deref() == Some("3D000");
    }
    let msg = err.to_string();
    msg.contains("does not exist") || msg.contains("3D000")
}

/// Connects to the `postgres` maintenance database and creates `target_db` if absent.
/// Returns `Ok(true)` if the database was created, or `Ok(false)` if it already existed.
async fn ensure_database_exists(base_opts: &PgConnectOptions, target_db: &str) -> Result<bool> {
    let maint_opts = base_opts.clone().database("postgres");
    let maint_pool = PgPoolOptions::new()
        .max_connections(2)
        .connect_with(maint_opts)
        .await
        .context("failed to connect to 'postgres' maintenance database")?;

    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = $1)")
            .bind(target_db)
            .fetch_one(&maint_pool)
            .await
            .context("failed to query pg_database")?;

    if exists {
        maint_pool.close().await;
        return Ok(false);
    }

    info!(database = %target_db, "target PostgreSQL database missing; creating automatically");
    let escaped = target_db.replace('"', "\"\"");
    let sql = format!("CREATE DATABASE \"{escaped}\"");
    sqlx::query(&sql)
        .execute(&maint_pool)
        .await
        .with_context(|| format!("failed to create PostgreSQL database '{target_db}'"))?;

    maint_pool.close().await;
    Ok(true)
}

/// Base64 alphabet for encoding DER X.509 certificates as PEM blocks.
const B64_TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Checks whether a PostgreSQL connection URL explicitly sets a root CA query parameter.
fn url_has_ssl_root_cert(url: &str) -> bool {
    let Some((_, query_and_frag)) = url.split_once('?') else {
        return false;
    };
    let query = query_and_frag
        .split_once('#')
        .map_or(query_and_frag, |(q, _)| q);
    query.split('&').any(|pair| {
        let key = pair.split_once('=').map_or(pair, |(k, _)| k);
        matches!(
            key.to_ascii_lowercase().as_str(),
            "sslrootcert" | "ssl-root-cert" | "ssl-ca"
        )
    })
}

/// Applies `PGSSLROOTCERT` or OS/environment system CA certificates (`SSL_CERT_FILE`,
/// `SSL_CERT_DIR`, platform trust store) onto `connect_opts` when the URL does not
/// explicitly specify `sslrootcert`.
fn apply_system_ca_roots(
    connect_opts: PgConnectOptions,
    url: &str,
    pg_ssl_root_cert: Option<&str>,
) -> PgConnectOptions {
    if url_has_ssl_root_cert(url) {
        return connect_opts;
    }

    if let Some(pg_root) = pg_ssl_root_cert.map(str::trim).filter(|s| !s.is_empty()) {
        if pg_root.starts_with("-----BEGIN ") {
            return connect_opts.ssl_root_cert_from_pem(pg_root.as_bytes().to_vec());
        }
        return connect_opts.ssl_root_cert(pg_root);
    }

    let Some((pem, count)) = load_valid_native_certs_pem() else {
        return connect_opts;
    };
    debug!(count, "loaded system CA certificates for PostgreSQL TLS");
    connect_opts.ssl_root_cert_from_pem(pem)
}

/// Loads native system/env CA certificates, skips entries rejected by `rustls`, and
/// encodes valid certificates as PEM bytes for `PgConnectOptions::ssl_root_cert_from_pem`.
fn load_valid_native_certs_pem() -> Option<(Vec<u8>, usize)> {
    let load_results = rustls_native_certs::load_native_certs();
    for err in &load_results.errors {
        warn!(error = %err, "error loading system CA certificates");
    }

    let mut store = RootCertStore::empty();
    let mut valid_certs = Vec::new();
    for cert in load_results.certs {
        if store.add(cert.clone()).is_ok() {
            valid_certs.push(cert);
        }
    }

    if valid_certs.is_empty() {
        return None;
    }

    let count = valid_certs.len();
    Some((encode_certificates_pem(&valid_certs), count))
}

/// Encodes DER X.509 certificates as concatenated PEM certificate blocks.
fn encode_certificates_pem(certs: &[CertificateDer<'_>]) -> Vec<u8> {
    let mut pem = String::new();
    for cert in certs {
        pem.push_str("-----BEGIN CERTIFICATE-----\n");
        let mut col = 0usize;
        for chunk in cert.as_ref().chunks(3) {
            let b0 = usize::from(chunk[0]);
            let b1 = usize::from(chunk.get(1).copied().unwrap_or(0));
            let b2 = usize::from(chunk.get(2).copied().unwrap_or(0));
            let triple = (b0 << 16) | (b1 << 8) | b2;

            pem.push(char::from(B64_TABLE[(triple >> 18) & 0x3F]));
            pem.push(char::from(B64_TABLE[(triple >> 12) & 0x3F]));
            pem.push(if chunk.len() > 1 {
                char::from(B64_TABLE[(triple >> 6) & 0x3F])
            } else {
                '='
            });
            pem.push(if chunk.len() > 2 {
                char::from(B64_TABLE[triple & 0x3F])
            } else {
                '='
            });

            col += 4;
            if col >= 64 {
                pem.push('\n');
                col = 0;
            }
        }
        if col > 0 {
            pem.push('\n');
        }
        pem.push_str("-----END CERTIFICATE-----\n");
    }
    pem.into_bytes()
}

/// Records an operational lifecycle event into `system_events`.
pub async fn log_system_event(
    pool: &PgPool,
    event_type: &str,
    level: &str,
    message: &str,
    details: Value,
) {
    let res = sqlx::query(
        "INSERT INTO system_events (event_type, level, message, details) VALUES ($1, $2, $3, $4)",
    )
    .bind(event_type)
    .bind(level)
    .bind(message)
    .bind(details)
    .execute(pool)
    .await;

    if let Err(err) = res {
        warn!(event_type, error = %err, "failed to record system_events entry");
    }
}

/// Resolves display timezone offset seconds (`Asia/Shanghai` -> `+08:00`, fallback UTC `0`).
#[must_use]
pub fn timezone_offset_secs(timezone: &str) -> i32 {
    match timezone.trim() {
        "Asia/Shanghai" | "Asia/Hong_Kong" | "Asia/Taipei" | "Asia/Singapore" => 8 * 3600,
        "Asia/Tokyo" => 9 * 3600,
        _ => 0,
    }
}

/// Converts a UTC timestamp into a calendar `NaiveDate` in the configured display offset.
#[must_use]
pub fn local_stat_date(ts: DateTime<Utc>, offset_secs: i32) -> NaiveDate {
    let offset = FixedOffset::east_opt(offset_secs)
        .unwrap_or_else(|| FixedOffset::east_opt(0).unwrap_or_else(unreachable_fallback_offset));
    ts.with_timezone(&offset).date_naive()
}

/// Pure const fallback offset (+00:00) without `.unwrap()` / `.expect()`.
const fn unreachable_fallback_offset() -> FixedOffset {
    match FixedOffset::east_opt(0) {
        Some(off) => off,
        None => unreachable!(),
    }
}

/// Inserts a single request log row, optional payload row, and updates `daily_model_stats`.
async fn persist_request_log(
    pool: &PgPool,
    config: &DatabaseConfig,
    tz_offset_secs: i32,
    rec: &RequestLogRecord,
) -> Result<()> {
    let mut tx = pool.begin().await?;
    let log_id = insert_request_log_row(&mut tx, rec).await?;

    let should_log_payload =
        config.log_full_payload || (config.log_error_payload && rec.status_code >= 400);
    if should_log_payload
        && (rec.error_message.is_some()
            || rec.request_headers.is_some()
            || rec.request_body.is_some()
            || rec.response_body.is_some())
    {
        insert_request_payload_row(&mut tx, log_id, rec).await?;
    }

    let stat_date = local_stat_date(rec.created_at, tz_offset_secs);
    upsert_daily_stats(&mut tx, stat_date, rec).await?;

    tx.commit().await?;
    Ok(())
}

/// Inserts one row into `request_logs` and returns the generated primary key ID.
async fn insert_request_log_row(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    rec: &RequestLogRecord,
) -> Result<i64> {
    let row = sqlx::query(
        r"
        INSERT INTO request_logs (
            request_uid, parent_request_uid, attempt_index, created_at,
            project_id, project_name, call_model_id, call_model_name,
            provider_id, provider_name, model_id, model_name, route_rule_id,
            is_stream, status_code, input_tokens, output_tokens,
            cache_read_tokens, cache_creation_tokens, reasoning_tokens, total_tokens,
            ttft_ms, total_duration_ms, generation_duration_ms, decode_tps, e2e_tps,
            finish_reason, reasoning_effort, token_source, script_state
        )
        VALUES (
            $1, $2, $3, $4,
            $5, $6, $7, $8,
            $9, $10, $11, $12, $13,
            $14, $15, $16, $17,
            $18, $19, $20, $21,
            $22, $23, $24, $25, $26,
            $27, $28, $29, $30
        )
        RETURNING id
        ",
    )
    .bind(rec.request_uid)
    .bind(rec.parent_request_uid)
    .bind(rec.attempt_index)
    .bind(rec.created_at)
    .bind(&rec.project_id)
    .bind(&rec.project_name)
    .bind(&rec.call_model_id)
    .bind(&rec.call_model_name)
    .bind(&rec.provider_id)
    .bind(&rec.provider_name)
    .bind(&rec.model_id)
    .bind(&rec.model_name)
    .bind(&rec.route_rule_id)
    .bind(rec.is_stream)
    .bind(rec.status_code)
    .bind(rec.input_tokens)
    .bind(rec.output_tokens)
    .bind(rec.cache_read_tokens)
    .bind(rec.cache_creation_tokens)
    .bind(rec.reasoning_tokens)
    .bind(rec.total_tokens)
    .bind(rec.ttft_ms)
    .bind(rec.total_duration_ms)
    .bind(rec.generation_duration_ms)
    .bind(rec.decode_tps)
    .bind(rec.e2e_tps)
    .bind(&rec.finish_reason)
    .bind(&rec.reasoning_effort)
    .bind(&rec.token_source)
    .bind(&rec.script_state)
    .fetch_one(&mut **tx)
    .await?;

    Ok(row.try_get("id")?)
}

/// Inserts error/debug payload details into `request_payloads`.
async fn insert_request_payload_row(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    log_id: i64,
    rec: &RequestLogRecord,
) -> Result<()> {
    sqlx::query(
        r"
        INSERT INTO request_payloads (
            request_log_id, error_message, request_headers, request_body, response_body, created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        ",
    )
    .bind(log_id)
    .bind(&rec.error_message)
    .bind(&rec.request_headers)
    .bind(&rec.request_body)
    .bind(&rec.response_body)
    .bind(rec.created_at)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// Upserts daily aggregate counters in `daily_model_stats`.
async fn upsert_daily_stats(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    stat_date: NaiveDate,
    rec: &RequestLogRecord,
) -> Result<()> {
    let is_success: i64 = i64::from((200..300).contains(&rec.status_code));
    sqlx::query(
        r"
        INSERT INTO daily_model_stats (
            stat_date, project_id, provider_id, model_id, provider_name, model_name,
            request_count, success_count, input_tokens, output_tokens,
            cache_read_tokens, cache_creation_tokens, reasoning_tokens, total_tokens,
            sum_ttft_ms, sum_generation_duration_ms, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW())
        ON CONFLICT (stat_date, project_id, provider_id, model_id)
        DO UPDATE SET
            provider_name = EXCLUDED.provider_name,
            model_name = EXCLUDED.model_name,
            request_count = daily_model_stats.request_count + 1,
            success_count = daily_model_stats.success_count + EXCLUDED.success_count,
            input_tokens = daily_model_stats.input_tokens + EXCLUDED.input_tokens,
            output_tokens = daily_model_stats.output_tokens + EXCLUDED.output_tokens,
            cache_read_tokens = daily_model_stats.cache_read_tokens + EXCLUDED.cache_read_tokens,
            cache_creation_tokens = daily_model_stats.cache_creation_tokens + EXCLUDED.cache_creation_tokens,
            reasoning_tokens = daily_model_stats.reasoning_tokens + EXCLUDED.reasoning_tokens,
            total_tokens = daily_model_stats.total_tokens + EXCLUDED.total_tokens,
            sum_ttft_ms = daily_model_stats.sum_ttft_ms + EXCLUDED.sum_ttft_ms,
            sum_generation_duration_ms = daily_model_stats.sum_generation_duration_ms + EXCLUDED.sum_generation_duration_ms,
            updated_at = NOW()
        ",
    )
    .bind(stat_date)
    .bind(&rec.project_id)
    .bind(&rec.provider_id)
    .bind(&rec.model_id)
    .bind(&rec.provider_name)
    .bind(&rec.model_name)
    .bind(is_success)
    .bind(rec.input_tokens)
    .bind(rec.output_tokens)
    .bind(rec.cache_read_tokens)
    .bind(rec.cache_creation_tokens)
    .bind(rec.reasoning_tokens)
    .bind(rec.total_tokens)
    .bind(rec.ttft_ms)
    .bind(rec.generation_duration_ms)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// Loads recent historical samples from PostgreSQL to warm up `MetricsCache` on startup.
///
/// # Errors
/// Returns an error if the database query fails.
pub async fn warmup_metrics_cache(
    pool: &PgPool,
    cache: &MetricsCache,
    warmup_days: u32,
) -> Result<usize> {
    let days = i64::from(warmup_days.max(1));
    let cutoff = Utc::now() - Duration::days(days);

    let rows = sqlx::query(
        r"
        SELECT provider_id, model_id, created_at, decode_tps, ttft_ms, status_code
        FROM request_logs
        WHERE created_at >= $1
        ORDER BY created_at DESC
        LIMIT 5000
        ",
    )
    .bind(cutoff)
    .fetch_all(pool)
    .await?;

    let mut samples = Vec::with_capacity(rows.len());
    for row in rows {
        let provider_id: String = row.try_get("provider_id")?;
        let model_id: String = row.try_get("model_id")?;
        let created_at: DateTime<Utc> = row.try_get("created_at")?;
        let decode_tps: f64 = row.try_get("decode_tps")?;
        let ttft_ms: f64 = row.try_get("ttft_ms")?;
        let status_code: i32 = row.try_get("status_code")?;
        samples.push((
            provider_id,
            model_id,
            MetricSample {
                timestamp: created_at,
                decode_tps,
                ttft_ms,
                is_error: status_code >= 400 || status_code == 0,
            },
        ));
    }

    let count = samples.len();
    cache.warmup(samples);
    Ok(count)
}

/// Sample model profile used by `seed_demo`.
type DemoModelEntry<'a> = (&'a str, &'a str, &'a str, &'a str, f64, f64);

/// Builds sample `(provider_id, provider_name, model_id, model_name, base_tps, base_ttft)` entries.
fn collect_demo_entries(catalog: &RuntimeCatalog) -> Vec<DemoModelEntry<'_>> {
    let mut model_pool: Vec<DemoModelEntry<'_>> = Vec::new();
    for p in &catalog.providers {
        for m in p.models.iter().take(3) {
            let (base_tps, base_ttft) = match p.id.as_str() {
                "deepseek" => (92.0, 380.0),
                "opencode" => (138.0, 260.0),
                "bailian" => (154.0, 210.0),
                "antigravity" => (168.0, 190.0),
                "codex" => (118.0, 310.0),
                _ => (108.0, 320.0),
            };
            model_pool.push((&p.id, &p.name, &m.id, &m.name, base_tps, base_ttft));
            if model_pool.len() >= 10 {
                return model_pool;
            }
        }
    }

    if model_pool.is_empty() {
        vec![
            (
                "deepseek",
                "深度求索",
                "deepseek-v4-pro",
                "DeepSeek V4 Pro",
                92.0,
                380.0,
            ),
            (
                "opencode",
                "Opencode",
                "qwen3.8-max",
                "Qwen3.8 Max",
                138.0,
                260.0,
            ),
            ("opencode", "Opencode", "kimi-k3", "Kimi K3", 121.0, 295.0),
            (
                "antigravity",
                "Antigravity",
                "gemini-4-argon",
                "Gemini 4 Argon",
                168.0,
                190.0,
            ),
            (
                "bailian",
                "阿里云百炼",
                "qwen3.8-flash",
                "Qwen 3.8 Flash",
                154.0,
                210.0,
            ),
        ]
    } else {
        model_pool
    }
}

/// Deterministic Xorshift64 helper for reproducible demo telemetry.
fn next_demo_rand(state: &mut u64) -> u64 {
    *state ^= *state << 13;
    *state ^= *state >> 7;
    *state ^= *state << 17;
    *state
}

/// Synthesizes one realistic demo `RequestLogRecord` for `day_base`.
fn build_demo_record(
    entry: DemoModelEntry<'_>,
    day_base: DateTime<Utc>,
    idx: u64,
    rng_state: &mut u64,
) -> RequestLogRecord {
    let (pid, pname, mid, mname, base_tps, base_ttft) = entry;
    let is_coding = next_demo_rand(rng_state).is_multiple_of(3);
    let (project_id, project_name, call_model_id, call_model_name, rule_id) = if is_coding {
        (
            "coding",
            "VS Code Coding",
            "smart-coder",
            "Smart Coder",
            "coding-smart-coder",
        )
    } else {
        ("default", "默认项目", mid, mname, "default-passthrough")
    };

    let jitter_secs = i64::try_from((next_demo_rand(rng_state) % 43_200) + idx * 17).unwrap_or(60);
    let ts = day_base - Duration::seconds(jitter_secs);

    let input_tokens = i64::try_from(1_400 + (next_demo_rand(rng_state) % 28_000)).unwrap_or(2_000);
    let output_tokens = i64::try_from(220 + (next_demo_rand(rng_state) % 2_600)).unwrap_or(500);
    let cache_read_tokens = if next_demo_rand(rng_state) % 10 < 7 {
        (input_tokens * i64::try_from(25 + (next_demo_rand(rng_state) % 55)).unwrap_or(40)) / 100
    } else {
        0
    };
    let reasoning_tokens = if next_demo_rand(rng_state).is_multiple_of(2) {
        output_tokens / 3
    } else {
        0
    };
    let total_tokens = input_tokens + output_tokens;

    #[allow(clippy::cast_precision_loss)]
    let tps_factor = 0.82 + ((next_demo_rand(rng_state) % 38) as f64) / 100.0;
    let decode_tps = (base_tps * tps_factor).max(12.0);

    #[allow(clippy::cast_precision_loss)]
    let ttft_factor = 0.78 + ((next_demo_rand(rng_state) % 52) as f64) / 100.0;
    let ttft_ms = (base_ttft * ttft_factor).max(75.0);

    #[allow(clippy::cast_precision_loss)]
    let generation_duration_ms = (output_tokens as f64 / decode_tps) * 1000.0;
    let total_duration_ms = ttft_ms + generation_duration_ms;
    #[allow(clippy::cast_precision_loss)]
    let e2e_tps = (output_tokens as f64 / (total_duration_ms / 1000.0)).max(1.0);
    let attempt_index: i16 = if next_demo_rand(rng_state).is_multiple_of(25) {
        2
    } else {
        1
    };
    let uid = Uuid::new_v4();

    RequestLogRecord {
        request_uid: uid,
        parent_request_uid: Some(uid),
        attempt_index,
        created_at: ts,
        project_id: project_id.to_string(),
        project_name: project_name.to_string(),
        call_model_id: call_model_id.to_string(),
        call_model_name: call_model_name.to_string(),
        provider_id: pid.to_string(),
        provider_name: pname.to_string(),
        model_id: mid.to_string(),
        model_name: mname.to_string(),
        route_rule_id: rule_id.to_string(),
        is_stream: true,
        status_code: 200,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_creation_tokens: 0,
        reasoning_tokens,
        total_tokens,
        ttft_ms,
        total_duration_ms,
        generation_duration_ms,
        decode_tps,
        e2e_tps,
        finish_reason: Some("stop".to_string()),
        reasoning_effort: Some("high".to_string()),
        token_source: "upstream_usage".to_string(),
        script_state: json!({}),
        error_message: None,
        request_headers: None,
        request_body: None,
        response_body: None,
    }
}

/// Seeds `days` of realistic multi-model, multi-provider demo telemetry into PostgreSQL
/// so all 4 layers of the read-only telemetry dashboard display rich data immediately.
///
/// # Errors
/// Returns an error if database writes fail.
pub async fn seed_demo(
    pool: &PgPool,
    catalog: &RuntimeCatalog,
    tz_offset_secs: i32,
    days: u32,
) -> Result<usize> {
    let entries = collect_demo_entries(catalog);
    let now = Utc::now();
    let total_days = i64::from(days.max(1));
    let mut tx = pool.begin().await?;
    let mut inserted = 0usize;
    let mut rng_state: u64 = 0x5EED_CAFE_BABE_1234;

    for offset in (0..total_days).rev() {
        let activity_roll = next_demo_rand(&mut rng_state) % 10;
        if offset > 21 && activity_roll == 0 {
            continue;
        }

        let day_base = now - Duration::days(offset);
        let reqs_today = if offset < 7 {
            10 + (next_demo_rand(&mut rng_state) % 12)
        } else {
            4 + (next_demo_rand(&mut rng_state) % 14)
        };

        for idx in 0..reqs_today {
            let pick = usize::try_from(next_demo_rand(&mut rng_state)).unwrap_or(0) % entries.len();
            let rec = build_demo_record(entries[pick], day_base, idx, &mut rng_state);
            let stat_date = local_stat_date(rec.created_at, tz_offset_secs);
            insert_request_log_row(&mut tx, &rec).await?;
            upsert_daily_stats(&mut tx, stat_date, &rec).await?;
            inserted += 1;
        }
    }

    sqlx::query(
        "INSERT INTO system_events (event_type, level, message, details) VALUES ($1, $2, $3, $4)",
    )
    .bind("demo_seeded")
    .bind("info")
    .bind(format!(
        "Seeded {inserted} demo requests across {total_days} days"
    ))
    .bind(json!({ "days": total_days, "requests": inserted }))
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(inserted)
}

/// Queries the highest-volume model for `OverviewSummary`.
async fn query_top_model(
    pool: &PgPool,
    catalog: &RuntimeCatalog,
    start_date: NaiveDate,
    project_id: Option<&str>,
    provider_id: Option<&str>,
) -> Result<Option<TopModelSummary>> {
    let top_row = sqlx::query(
        r"
        SELECT
            provider_id,
            model_id,
            MAX(model_name) AS model_name,
            COALESCE(SUM(total_tokens), 0)::BIGINT AS total_tokens
        FROM daily_model_stats
        WHERE stat_date >= $1
          AND ($2::TEXT IS NULL OR project_id = $2)
          AND ($3::TEXT IS NULL OR provider_id = $3)
        GROUP BY provider_id, model_id
        ORDER BY total_tokens DESC
        LIMIT 1
        ",
    )
    .bind(start_date)
    .bind(project_id)
    .bind(provider_id)
    .fetch_optional(pool)
    .await?;

    let Some(row) = top_row else {
        return Ok(None);
    };

    let pid: String = row.try_get("provider_id")?;
    let mid: String = row.try_get("model_id")?;
    let mname: String = row.try_get("model_name")?;
    let total_tokens: i64 = row.try_get("total_tokens")?;
    let model_icon = catalog.find_model(&pid, &mid).map_or_else(
        || infer_model_icon(&mid, &mname, &pid),
        |(_, m)| m.icon.clone(),
    );

    Ok(Some(TopModelSummary {
        model_id: mid,
        model_name: mname,
        model_icon,
        total_tokens,
    }))
}

/// Queries overview KPIs, filter entities, and daily contribution wall data.
///
/// # Errors
/// Returns an error if any database query fails.
pub async fn query_overview(
    pool: &PgPool,
    catalog: &RuntimeCatalog,
    ui_cfg: &UiConfig,
    project_id: Option<&str>,
    provider_id: Option<&str>,
    days: u32,
) -> Result<OverviewResponse> {
    let offset_secs = timezone_offset_secs(&ui_cfg.timezone);
    let today = local_stat_date(Utc::now(), offset_secs);
    let clamped_days = i64::from(days.clamp(7, 371));
    let start_date = today - Duration::days(clamped_days - 1);

    let day_rows = sqlx::query(
        r"
        SELECT
            stat_date,
            COALESCE(SUM(total_tokens), 0)::BIGINT AS total_tokens,
            COALESCE(SUM(input_tokens), 0)::BIGINT AS input_tokens,
            COALESCE(SUM(output_tokens), 0)::BIGINT AS output_tokens,
            COALESCE(SUM(cache_read_tokens), 0)::BIGINT AS cache_read_tokens,
            COALESCE(SUM(request_count), 0)::BIGINT AS request_count
        FROM daily_model_stats
        WHERE stat_date >= $1
          AND ($2::TEXT IS NULL OR project_id = $2)
          AND ($3::TEXT IS NULL OR provider_id = $3)
        GROUP BY stat_date
        ORDER BY stat_date ASC
        ",
    )
    .bind(start_date)
    .bind(project_id)
    .bind(provider_id)
    .fetch_all(pool)
    .await?;

    let mut days_vec = Vec::with_capacity(day_rows.len());
    let mut active_dates = HashSet::new();
    let (mut sum_total, mut sum_input, mut sum_output, mut sum_cache, mut sum_requests) =
        (0i64, 0i64, 0i64, 0i64, 0i64);

    for row in day_rows {
        let cell = ContributionDayCell {
            date: row.try_get("stat_date")?,
            total_tokens: row.try_get("total_tokens")?,
            input_tokens: row.try_get("input_tokens")?,
            output_tokens: row.try_get("output_tokens")?,
            cache_read_tokens: row.try_get("cache_read_tokens")?,
            request_count: row.try_get("request_count")?,
        };
        if cell.request_count > 0 {
            active_dates.insert(cell.date);
        }
        sum_total += cell.total_tokens;
        sum_input += cell.input_tokens;
        sum_output += cell.output_tokens;
        sum_cache += cell.cache_read_tokens;
        sum_requests += cell.request_count;
        days_vec.push(cell);
    }

    let active_streak_days = compute_streak_days(&active_dates, today);
    #[allow(clippy::cast_precision_loss)]
    let cache_hit_rate = if sum_input > 0 {
        ((sum_cache as f64) * 100.0 / (sum_input as f64)).min(100.0)
    } else {
        0.0
    };
    let top_model = query_top_model(pool, catalog, start_date, project_id, provider_id).await?;

    let projects = catalog
        .projects
        .iter()
        .map(|p| FilterEntityItem {
            id: p.id.clone(),
            name: p.name.clone(),
            icon: p.icon.clone(),
        })
        .collect();
    let providers = catalog
        .providers
        .iter()
        .map(|p| FilterEntityItem {
            id: p.id.clone(),
            name: p.name.clone(),
            icon: p.icon.clone(),
        })
        .collect();

    Ok(OverviewResponse {
        title: ui_cfg.title.clone(),
        timezone: ui_cfg.timezone.clone(),
        projects,
        providers,
        summary: OverviewSummary {
            total_tokens: sum_total,
            input_tokens: sum_input,
            output_tokens: sum_output,
            cache_read_tokens: sum_cache,
            cache_hit_rate,
            total_requests: sum_requests,
            active_streak_days,
            top_model,
        },
        days: days_vec,
    })
}

/// Counts consecutive active days ending on `today` (or `today - 1` if today has no traffic yet).
fn compute_streak_days(active_dates: &HashSet<NaiveDate>, today: NaiveDate) -> i64 {
    let mut cursor = if active_dates.contains(&today) {
        today
    } else if active_dates.contains(&(today - Duration::days(1))) {
        today - Duration::days(1)
    } else {
        return 0;
    };

    let mut streak = 0i64;
    while active_dates.contains(&cursor) {
        streak += 1;
        cursor -= Duration::days(1);
    }
    streak
}

/// Queries per-model speed rankings for `GET /api/v1/stats/leaderboard`.
///
/// # Errors
/// Returns an error if the database query fails.
pub async fn query_leaderboard(
    pool: &PgPool,
    catalog: &RuntimeCatalog,
    project_id: Option<&str>,
    provider_id: Option<&str>,
    days: Option<u32>,
    sort_by: &str,
    min_requests: u64,
) -> Result<Vec<LeaderboardItem>> {
    let cutoff: Option<DateTime<Utc>> =
        days.map(|d| Utc::now() - Duration::days(i64::from(d.max(1))));

    let order_clause = match sort_by {
        "p50_decode_tps" => "p50_decode_tps DESC",
        "p90_decode_tps" => "p90_decode_tps DESC",
        "avg_ttft_ms" => "avg_ttft_ms ASC",
        _ => "avg_decode_tps DESC",
    };

    let min_req_i64 = i64::try_from(min_requests.max(1)).unwrap_or(1);

    let sql = format!(
        r"
        SELECT
            provider_id,
            MAX(provider_name) AS provider_name,
            model_id,
            MAX(model_name) AS model_name,
            COALESCE(AVG(decode_tps), 0)::DOUBLE PRECISION AS avg_decode_tps,
            COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY decode_tps), 0)::DOUBLE PRECISION AS p50_decode_tps,
            COALESCE(PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY decode_tps), 0)::DOUBLE PRECISION AS p90_decode_tps,
            COALESCE(AVG(e2e_tps), 0)::DOUBLE PRECISION AS avg_e2e_tps,
            COALESCE(AVG(ttft_ms), 0)::DOUBLE PRECISION AS avg_ttft_ms,
            COUNT(*)::BIGINT AS request_count,
            COALESCE(SUM(total_tokens), 0)::BIGINT AS total_tokens
        FROM request_logs
        WHERE status_code >= 200 AND status_code < 300
          AND decode_tps > 0
          AND ($1::TIMESTAMPTZ IS NULL OR created_at >= $1)
          AND ($2::TEXT IS NULL OR project_id = $2)
          AND ($3::TEXT IS NULL OR provider_id = $3)
        GROUP BY provider_id, model_id
        HAVING COUNT(*) >= $4
        ORDER BY {order_clause}, request_count DESC
        LIMIT 50
        "
    );

    let rows = sqlx::query(&sql)
        .bind(cutoff)
        .bind(project_id)
        .bind(provider_id)
        .bind(min_req_i64)
        .fetch_all(pool)
        .await?;

    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let pid: String = row.try_get("provider_id")?;
        let pname: String = row.try_get("provider_name")?;
        let mid: String = row.try_get("model_id")?;
        let mname: String = row.try_get("model_name")?;

        let provider_icon = catalog
            .find_provider(&pid)
            .map_or_else(|| infer_provider_icon(&pid, &pname), |p| p.icon.clone());
        let model_icon = catalog.find_model(&pid, &mid).map_or_else(
            || infer_model_icon(&mid, &mname, &provider_icon),
            |(_, m)| m.icon.clone(),
        );

        out.push(LeaderboardItem {
            model_id: mid,
            model_name: mname,
            model_icon,
            provider_id: pid,
            provider_name: pname,
            provider_icon,
            avg_decode_tps: row.try_get("avg_decode_tps")?,
            p50_decode_tps: row.try_get("p50_decode_tps")?,
            p90_decode_tps: row.try_get("p90_decode_tps")?,
            avg_e2e_tps: row.try_get("avg_e2e_tps")?,
            avg_ttft_ms: row.try_get("avg_ttft_ms")?,
            request_count: row.try_get("request_count")?,
            total_tokens: row.try_get("total_tokens")?,
        });
    }

    Ok(out)
}

/// Queries per-day, per-model token consumption for `GET /api/v1/stats/daily-models`.
///
/// # Errors
/// Returns an error if the database query fails.
pub async fn query_daily_models(
    pool: &PgPool,
    ui_cfg: &UiConfig,
    project_id: Option<&str>,
    provider_id: Option<&str>,
    days: u32,
) -> Result<Vec<DailyModelDay>> {
    let offset_secs = timezone_offset_secs(&ui_cfg.timezone);
    let today = local_stat_date(Utc::now(), offset_secs);
    let clamped_days = i64::from(days.clamp(1, 365));
    let start_date = today - Duration::days(clamped_days - 1);

    let rows = sqlx::query(
        r"
        SELECT
            stat_date,
            provider_id,
            model_id,
            MAX(model_name) AS model_name,
            COALESCE(SUM(total_tokens), 0)::BIGINT AS total_tokens,
            COALESCE(SUM(input_tokens), 0)::BIGINT AS input_tokens,
            COALESCE(SUM(output_tokens), 0)::BIGINT AS output_tokens,
            COALESCE(SUM(cache_read_tokens), 0)::BIGINT AS cache_read_tokens
        FROM daily_model_stats
        WHERE stat_date >= $1
          AND ($2::TEXT IS NULL OR project_id = $2)
          AND ($3::TEXT IS NULL OR provider_id = $3)
        GROUP BY stat_date, provider_id, model_id
        ORDER BY stat_date ASC, total_tokens DESC
        ",
    )
    .bind(start_date)
    .bind(project_id)
    .bind(provider_id)
    .fetch_all(pool)
    .await?;

    let mut by_date: BTreeMap<NaiveDate, Vec<DailyModelSlice>> = BTreeMap::new();
    for offset in 0..clamped_days {
        let d = start_date + Duration::days(offset);
        by_date.insert(d, Vec::new());
    }

    for row in rows {
        let bucket_date: NaiveDate = row.try_get("stat_date")?;
        let slice = DailyModelSlice {
            model_id: row.try_get("model_id")?,
            model_name: row.try_get("model_name")?,
            provider_id: row.try_get("provider_id")?,
            total_tokens: row.try_get("total_tokens")?,
            input_tokens: row.try_get("input_tokens")?,
            output_tokens: row.try_get("output_tokens")?,
            cache_read_tokens: row.try_get("cache_read_tokens")?,
        };
        by_date.entry(bucket_date).or_default().push(slice);
    }

    Ok(by_date
        .into_iter()
        .map(|(date, models)| DailyModelDay { date, models })
        .collect())
}

/// Queries recent requests for `GET /api/v1/stats/recent-requests`.
///
/// # Errors
/// Returns an error if the database query fails.
pub async fn query_recent_requests(
    pool: &PgPool,
    catalog: &RuntimeCatalog,
    project_id: Option<&str>,
    provider_id: Option<&str>,
    model_id: Option<&str>,
    limit: u32,
) -> Result<Vec<RecentRequestItem>> {
    let clamped_limit = i64::from(limit.clamp(1, 200));
    let rows = sqlx::query(
        r"
        SELECT
            request_uid, created_at,
            project_id, project_name, call_model_id, call_model_name,
            provider_id, provider_name, model_id, model_name,
            route_rule_id, attempt_index, status_code, is_stream,
            input_tokens, output_tokens, cache_read_tokens, reasoning_tokens, total_tokens,
            ttft_ms, total_duration_ms, decode_tps, e2e_tps
        FROM request_logs
        WHERE ($1::TEXT IS NULL OR project_id = $1)
          AND ($2::TEXT IS NULL OR provider_id = $2)
          AND ($3::TEXT IS NULL OR model_id = $3)
        ORDER BY created_at DESC
        LIMIT $4
        ",
    )
    .bind(project_id)
    .bind(provider_id)
    .bind(model_id)
    .bind(clamped_limit)
    .fetch_all(pool)
    .await?;

    let mut icon_cache: HashMap<(String, String), (String, String)> = HashMap::new();
    let mut items = Vec::with_capacity(rows.len());

    for row in rows {
        let pid: String = row.try_get("provider_id")?;
        let pname: String = row.try_get("provider_name")?;
        let mid: String = row.try_get("model_id")?;
        let mname: String = row.try_get("model_name")?;

        let (provider_icon, model_icon) = icon_cache
            .entry((pid.clone(), mid.clone()))
            .or_insert_with(|| {
                let p_icon = catalog
                    .find_provider(&pid)
                    .map_or_else(|| infer_provider_icon(&pid, &pname), |p| p.icon.clone());
                let m_icon = catalog.find_model(&pid, &mid).map_or_else(
                    || infer_model_icon(&mid, &mname, &p_icon),
                    |(_, m)| m.icon.clone(),
                );
                (p_icon, m_icon)
            })
            .clone();

        items.push(RecentRequestItem {
            request_uid: row.try_get("request_uid")?,
            created_at: row.try_get("created_at")?,
            project_id: row.try_get("project_id")?,
            project_name: row.try_get("project_name")?,
            call_model_id: row.try_get("call_model_id")?,
            call_model_name: row.try_get("call_model_name")?,
            provider_id: pid,
            provider_name: pname,
            provider_icon,
            model_id: mid,
            model_name: mname,
            model_icon,
            route_rule_id: row.try_get("route_rule_id")?,
            attempt_index: row.try_get("attempt_index")?,
            status_code: row.try_get("status_code")?,
            is_stream: row.try_get("is_stream")?,
            input_tokens: row.try_get("input_tokens")?,
            output_tokens: row.try_get("output_tokens")?,
            cache_read_tokens: row.try_get("cache_read_tokens")?,
            reasoning_tokens: row.try_get("reasoning_tokens")?,
            total_tokens: row.try_get("total_tokens")?,
            ttft_ms: row.try_get("ttft_ms")?,
            total_duration_ms: row.try_get("total_duration_ms")?,
            decode_tps: row.try_get("decode_tps")?,
            e2e_tps: row.try_get("e2e_tps")?,
        });
    }

    Ok(items)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rustls::pki_types::pem::PemObject;

    #[test]
    fn url_ssl_root_cert_detection_matches_sqlx_keys() {
        assert!(url_has_ssl_root_cert(
            "postgres://u:p@db:5432/linguist?sslmode=verify-full&sslrootcert=/config/ca.pem"
        ));
        assert!(url_has_ssl_root_cert(
            "postgres://u:p@db:5432/linguist?ssl-root-cert=/ca.pem"
        ));
        assert!(url_has_ssl_root_cert(
            "postgres://u:p@db:5432/linguist?SSL-CA=/ca.pem"
        ));
        assert!(!url_has_ssl_root_cert(
            "postgres://u:p@db:5432/linguist?sslmode=verify-full"
        ));
        assert!(!url_has_ssl_root_cert("postgres://u:p@db:5432/linguist"));
    }

    #[test]
    fn pem_encoding_roundtrips_der_certificates() {
        let sample_bytes: Vec<u8> = (0u8..=70).collect();
        let certs = [CertificateDer::from(sample_bytes.clone())];
        let pem = encode_certificates_pem(&certs);
        let decoded: Vec<CertificateDer<'static>> = CertificateDer::pem_slice_iter(&pem)
            .filter_map(Result::ok)
            .collect();
        assert_eq!(decoded.len(), 1);
        assert_eq!(decoded[0].as_ref(), sample_bytes.as_slice());
    }
}
