//! Zero-hook SSE and JSON response inspector measuring TTFT, `decode_tps`, `e2e_tps`,
//! token usage extraction, fallback estimation, and optional response `model` rewriting.

use std::collections::BTreeMap;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Instant;

use bytes::Bytes;
use chrono::Utc;
use futures::Stream;
use serde_json::Value;
use uuid::Uuid;

use crate::metrics_cache::{MetricSample, MetricsCache};
use crate::models::RequestLogRecord;

/// Static context metadata passed to the inspector when finalizing telemetry.
#[derive(Debug, Clone)]
pub struct InspectionMetadata {
    /// Unique UID for this upstream attempt.
    pub request_uid: Uuid,
    /// Root request UID shared across primary + fallback attempts.
    pub parent_request_uid: Uuid,
    /// 1-based attempt index.
    pub attempt_index: i16,
    /// Project ID.
    pub project_id: String,
    /// Project display name.
    pub project_name: String,
    /// Call model ID.
    pub call_model_id: String,
    /// Call model display name.
    pub call_model_name: String,
    /// Upstream provider ID.
    pub provider_id: String,
    /// Upstream provider display name.
    pub provider_name: String,
    /// Upstream model ID.
    pub model_id: String,
    /// Upstream model display name.
    pub model_name: String,
    /// Matched route rule ID.
    pub route_rule_id: String,
    /// Upstream HTTP status code.
    pub status_code: i32,
    /// Whether the response was streaming.
    pub is_stream: bool,
    /// Whether to rewrite `model` field back to `call_model_id`.
    pub rewrite_response_model: bool,
    /// Estimated prompt char count from incoming request signals (for fallback estimation).
    pub estimated_input_chars: usize,
    /// Effective `reasoning_effort` parameter if supplied.
    pub reasoning_effort: Option<String>,
    /// Serialized Stage ⑤ `ctx.state` snapshot.
    pub script_state: Value,
    /// Optional serialized request headers for payload logging.
    pub request_headers: Option<Value>,
    /// Optional serialized request body for payload logging.
    pub request_body: Option<Value>,
    /// Timestamp when upstream HTTP call started.
    pub t_start: Instant,
    /// UTC timestamp when upstream HTTP call started.
    pub started_at: chrono::DateTime<chrono::Utc>,
    /// Catalog snapshot captured when the request started (used for async billing).
    pub catalog_snapshot: Option<Arc<crate::catalog::RuntimeCatalog>>,
    /// Gateway internal pre-send overhead in milliseconds.
    pub gateway_overhead_ms: f64,
    /// Stages ①..③ routing duration in milliseconds.
    pub routing_ms: f64,
    /// Stages ④..⑤ attempt preparation duration in milliseconds.
    pub attempt_prep_ms: f64,
    /// Upstream HTTP response header establishment latency in milliseconds.
    pub upstream_header_ms: f64,
}

/// Extracted token counters and timing results computed by the inspector.
#[derive(Debug, Clone, PartialEq)]
pub struct InspectedMetrics {
    /// Input/prompt tokens.
    pub input_tokens: i64,
    /// Output/completion tokens.
    pub output_tokens: i64,
    /// Cached prompt tokens read.
    pub cache_read_tokens: i64,
    /// Cached prompt tokens created.
    pub cache_creation_tokens: i64,
    /// Reasoning/thinking tokens.
    pub reasoning_tokens: i64,
    /// Total tokens (`input + output` or upstream `total_tokens`).
    pub total_tokens: i64,
    /// Time to first token in milliseconds.
    pub ttft_ms: f64,
    /// Total request elapsed duration in milliseconds.
    pub total_duration_ms: f64,
    /// Net decode generation duration in milliseconds (`total - ttft`).
    pub generation_duration_ms: f64,
    /// Net decode tokens per second (`output_tokens / generation_secs`).
    pub decode_tps: f64,
    /// End-to-end tokens per second (`output_tokens / total_secs`).
    pub e2e_tps: f64,
    /// Finish reason extracted from upstream choice.
    pub finish_reason: Option<String>,
    /// Accounting mode (`"upstream_usage"` or `"fallback_estimated"`).
    pub token_source: String,
}

/// Stateful incremental inspector processing raw SSE byte chunks or JSON responses.
#[derive(Debug)]
pub struct StreamTelemetryTracker {
    /// Immutable metadata for this attempt.
    meta: InspectionMetadata,
    /// Line buffer for partial SSE frames split across TCP chunks.
    line_buffer: Vec<u8>,
    /// Timestamp when the first non-empty token delta was observed.
    t_first_token: Option<Instant>,
    /// Accumulated output character count (used for fallback estimation).
    output_chars: usize,
    /// Extracted finish reason.
    finish_reason: Option<String>,
    /// Extracted upstream usage fields when reported.
    usage: Option<ParsedUsage>,
    /// Full raw `usage` JSON object from the final upstream chunk/response.
    raw_usage: Option<Value>,
    /// Non-standard numeric token counters extracted from `usage.*_details`.
    extra_tokens: BTreeMap<String, i64>,
    /// Whether telemetry has already been finalized and emitted.
    finalized: bool,
}

/// Parsed `OpenAI` `usage` block.
#[derive(Debug, Clone, Default)]
struct ParsedUsage {
    /// Prompt tokens.
    prompt: i64,
    /// Completion tokens.
    completion: i64,
    /// Cached read tokens.
    cache_read: i64,
    /// Cache creation tokens.
    cache_creation: i64,
    /// Reasoning tokens.
    reasoning: i64,
    /// Combined total tokens.
    combined_total: i64,
}

impl StreamTelemetryTracker {
    /// Creates a new tracker for a single upstream request attempt.
    #[must_use]
    pub const fn new(meta: InspectionMetadata) -> Self {
        Self {
            meta,
            line_buffer: Vec::new(),
            t_first_token: None,
            output_chars: 0,
            finish_reason: None,
            usage: None,
            raw_usage: None,
            extra_tokens: BTreeMap::new(),
            finalized: false,
        }
    }

    /// Processes an incoming SSE byte chunk, rewriting `"model"` inside `data: {...}`
    /// lines if `rewrite_response_model` is enabled, and returns transformed bytes
    /// ready to forward immediately downstream.
    pub fn process_sse_chunk(&mut self, chunk: &[u8]) -> Bytes {
        let now = Instant::now();
        self.line_buffer.extend_from_slice(chunk);

        let mut output = Vec::with_capacity(chunk.len() + 64);

        while let Some(newline_pos) = self
            .line_buffer
            .iter()
            .position(|&b| b == b'\n' || b == b'\r')
        {
            let mut line_bytes: Vec<u8> = self.line_buffer.drain(..=newline_pos).collect();
            let delimiter = line_bytes[newline_pos];
            line_bytes.truncate(newline_pos);

            if let Ok(line_str) = std::str::from_utf8(&line_bytes)
                && let Some(rewritten) = self.inspect_sse_line(line_str, now)
            {
                output.extend_from_slice(rewritten.as_bytes());
            } else if self.meta.rewrite_response_model {
                output.extend_from_slice(&line_bytes);
            }

            if self.meta.rewrite_response_model {
                output.push(delimiter);
            }
        }

        if self.meta.rewrite_response_model {
            Bytes::from(output)
        } else {
            Bytes::copy_from_slice(chunk)
        }
    }

    /// Flushes any trailing incomplete SSE line when the upstream stream closes.
    pub fn finish_sse_tail(&mut self) -> Bytes {
        if self.line_buffer.is_empty() {
            return Bytes::new();
        }
        let now = Instant::now();
        let remaining = std::mem::take(&mut self.line_buffer);
        if let Ok(line_str) = std::str::from_utf8(&remaining)
            && let Some(rewritten) = self.inspect_sse_line(line_str, now)
        {
            return Bytes::from(rewritten.into_bytes());
        }
        if self.meta.rewrite_response_model {
            Bytes::from(remaining)
        } else {
            Bytes::new()
        }
    }

    /// Inspects a complete non-streaming JSON response body, updates metrics, and
    /// rewrites `"model"` if configured.
    pub fn process_json_response(&mut self, raw_bytes: &[u8]) -> Bytes {
        let now = Instant::now();
        self.t_first_token = Some(now);

        let Ok(mut val) = serde_json::from_slice::<Value>(raw_bytes) else {
            return Bytes::copy_from_slice(raw_bytes);
        };

        self.extract_from_json_value(&val, now, false);

        if self.meta.rewrite_response_model
            && let Some(obj) = val.as_object_mut()
            && obj.contains_key("model")
        {
            obj.insert(
                "model".to_string(),
                Value::String(self.meta.call_model_id.clone()),
            );
            if let Ok(serialized) = serde_json::to_vec(&val) {
                return Bytes::from(serialized);
            }
        }

        Bytes::copy_from_slice(raw_bytes)
    }

    /// Finalizes timing and usage metrics and builds a `RequestLogRecord`.
    /// Returns `None` if already finalized.
    pub fn finalize(
        &mut self,
        error_message: Option<String>,
        response_body: Option<Value>,
    ) -> Option<(InspectedMetrics, RequestLogRecord)> {
        if self.finalized {
            return None;
        }
        self.finalized = true;

        let t_end = Instant::now();
        let total_duration_ms = t_end
            .saturating_duration_since(self.meta.t_start)
            .as_secs_f64()
            * 1000.0;
        let (ttft_ms, generation_duration_ms) = self.compute_timings(t_end, total_duration_ms);
        let (input, output, cache_read, cache_creation, reasoning, total, token_source) =
            self.compute_token_accounting();

        #[allow(clippy::cast_precision_loss)]
        let decode_tps = if generation_duration_ms > 0.1 && output > 0 {
            (output as f64) / (generation_duration_ms / 1000.0)
        } else {
            0.0
        };
        #[allow(clippy::cast_precision_loss)]
        let e2e_tps = if total_duration_ms > 0.1 && output > 0 {
            (output as f64) / (total_duration_ms / 1000.0)
        } else {
            0.0
        };

        let metrics = InspectedMetrics {
            input_tokens: input,
            output_tokens: output,
            cache_read_tokens: cache_read,
            cache_creation_tokens: cache_creation,
            reasoning_tokens: reasoning,
            total_tokens: total,
            ttft_ms,
            total_duration_ms,
            generation_duration_ms,
            decode_tps,
            e2e_tps,
            finish_reason: self.finish_reason.clone(),
            token_source: token_source.clone(),
        };

        let record = RequestLogRecord {
            request_uid: self.meta.request_uid,
            parent_request_uid: Some(self.meta.parent_request_uid),
            attempt_index: self.meta.attempt_index,
            started_at: self.meta.started_at,
            created_at: Utc::now(),
            interrupted: error_message.is_some(),
            raw_usage: self.raw_usage.clone(),
            catalog_snapshot: self.meta.catalog_snapshot.clone(),
            project_id: self.meta.project_id.clone(),
            project_name: self.meta.project_name.clone(),
            call_model_id: self.meta.call_model_id.clone(),
            call_model_name: self.meta.call_model_name.clone(),
            provider_id: self.meta.provider_id.clone(),
            provider_name: self.meta.provider_name.clone(),
            model_id: self.meta.model_id.clone(),
            model_name: self.meta.model_name.clone(),
            route_rule_id: self.meta.route_rule_id.clone(),
            is_stream: self.meta.is_stream,
            status_code: self.meta.status_code,
            input_tokens: input,
            output_tokens: output,
            cache_read_tokens: cache_read,
            cache_creation_tokens: cache_creation,
            reasoning_tokens: reasoning,
            total_tokens: total,
            extra_tokens: self.extra_tokens.clone(),
            ttft_ms,
            total_duration_ms,
            generation_duration_ms,
            decode_tps,
            e2e_tps,
            gateway_overhead_ms: self.meta.gateway_overhead_ms,
            routing_ms: self.meta.routing_ms,
            attempt_prep_ms: self.meta.attempt_prep_ms,
            upstream_header_ms: self.meta.upstream_header_ms,
            finish_reason: self.finish_reason.clone(),
            reasoning_effort: self.meta.reasoning_effort.clone(),
            token_source,
            script_state: self.meta.script_state.clone(),
            error_message,
            request_headers: self.meta.request_headers.clone(),
            request_body: self.meta.request_body.clone(),
            response_body,
        };

        Some((metrics, record))
    }

    /// Computes `(ttft_ms, generation_duration_ms)` from recorded instants.
    fn compute_timings(&self, t_end: Instant, total_duration_ms: f64) -> (f64, f64) {
        if let Some(t_first) = self.t_first_token {
            let ttft = t_first
                .saturating_duration_since(self.meta.t_start)
                .as_secs_f64()
                * 1000.0;
            let gen_ms = if self.meta.is_stream {
                t_end.saturating_duration_since(t_first).as_secs_f64() * 1000.0
            } else {
                total_duration_ms
            };
            (ttft, gen_ms)
        } else {
            (total_duration_ms, 0.0)
        }
    }

    /// Resolves token counts from upstream `usage` or falls back to char-based estimation.
    fn compute_token_accounting(&self) -> (i64, i64, i64, i64, i64, i64, String) {
        if let Some(u) = &self.usage {
            let total = if u.combined_total > 0 {
                u.combined_total
            } else {
                u.prompt.saturating_add(u.completion)
            };
            return (
                u.prompt,
                u.completion,
                u.cache_read,
                u.cache_creation,
                u.reasoning,
                total,
                "upstream_usage".to_string(),
            );
        }

        let est_in = if self.meta.estimated_input_chars > 0 {
            i64::try_from((self.meta.estimated_input_chars / 4).max(1)).unwrap_or(1)
        } else {
            0
        };
        let est_out = if self.output_chars > 0 {
            i64::try_from((self.output_chars / 4).max(1)).unwrap_or(1)
        } else {
            0
        };
        (
            est_in,
            est_out,
            0,
            0,
            0,
            est_in + est_out,
            "fallback_estimated".to_string(),
        )
    }

    /// Inspects a single SSE line (`data: {...}`), returning a rewritten `data: ...` line
    /// when `rewrite_response_model` changed the payload.
    fn inspect_sse_line(&mut self, line: &str, now: Instant) -> Option<String> {
        let trimmed = line.trim();
        let data_payload = trimmed.strip_prefix("data:").map(str::trim_start)?;

        if data_payload == "[DONE]" || data_payload.is_empty() {
            return None;
        }

        let mut val: Value = serde_json::from_str(data_payload).ok()?;
        self.extract_from_json_value(&val, now, true);

        if self.meta.rewrite_response_model
            && let Some(obj) = val.as_object_mut()
            && obj.contains_key("model")
        {
            obj.insert(
                "model".to_string(),
                Value::String(self.meta.call_model_id.clone()),
            );
            if let Ok(encoded) = serde_json::to_string(&val) {
                return Some(format!("data: {encoded}"));
            }
        }
        None
    }

    /// Extracts delta content length, first-token timestamp, finish reason, and usage
    /// counters from a parsed `OpenAI` JSON payload.
    fn extract_from_json_value(&mut self, val: &Value, now: Instant, is_sse: bool) {
        if let Some(choices) = val.get("choices").and_then(Value::as_array) {
            for choice in choices {
                if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str)
                    && !reason.is_empty()
                {
                    self.finish_reason = Some(reason.to_string());
                }

                if is_sse {
                    if let Some(delta) = choice.get("delta") {
                        let chars = count_delta_chars(delta);
                        if chars > 0 {
                            if self.t_first_token.is_none() {
                                self.t_first_token = Some(now);
                            }
                            self.output_chars = self.output_chars.saturating_add(chars);
                        }
                    }
                } else if let Some(message) = choice.get("message") {
                    self.output_chars =
                        self.output_chars.saturating_add(count_delta_chars(message));
                }
            }
        }

        if let Some(usage) = val.get("usage").and_then(Value::as_object) {
            if !is_sse
                || val
                    .get("choices")
                    .and_then(Value::as_array)
                    .is_some_and(|choices| {
                        choices.is_empty()
                            || choices.iter().all(|choice| {
                                choice.get("finish_reason").is_some_and(Value::is_string)
                            })
                    })
            {
                self.raw_usage = Some(Value::Object(usage.clone()));
            }
            let input_tokens = usage
                .get("prompt_tokens")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            let output_tokens = usage
                .get("completion_tokens")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            let total_tokens = usage
                .get("total_tokens")
                .and_then(Value::as_i64)
                .unwrap_or_else(|| input_tokens.saturating_add(output_tokens));

            let cache_read_tokens = usage
                .get("prompt_tokens_details")
                .and_then(|d| d.get("cached_tokens"))
                .and_then(Value::as_i64)
                .or_else(|| usage.get("prompt_cache_hit_tokens").and_then(Value::as_i64))
                .unwrap_or(0);

            let cache_creation_tokens = usage
                .get("prompt_tokens_details")
                .and_then(|d| {
                    d.get("cache_write_tokens")
                        .or_else(|| d.get("cache_creation_tokens"))
                })
                .and_then(Value::as_i64)
                .unwrap_or(0);

            let reasoning_tokens = usage
                .get("completion_tokens_details")
                .and_then(|d| d.get("reasoning_tokens"))
                .and_then(Value::as_i64)
                .unwrap_or(0);

            for detail_key in ["prompt_tokens_details", "completion_tokens_details"] {
                if let Some(details) = usage.get(detail_key).and_then(Value::as_object) {
                    for (k, v) in details {
                        if matches!(
                            k.as_str(),
                            "cached_tokens"
                                | "cache_write_tokens"
                                | "cache_creation_tokens"
                                | "reasoning_tokens"
                        ) {
                            continue;
                        }
                        if let Some(count) = v.as_i64()
                            && count > 0
                        {
                            self.extra_tokens.insert(k.clone(), count);
                        }
                    }
                }
            }

            self.usage = Some(ParsedUsage {
                prompt: input_tokens,
                completion: output_tokens,
                cache_read: cache_read_tokens,
                cache_creation: cache_creation_tokens,
                reasoning: reasoning_tokens,
                combined_total: total_tokens,
            });
        }
    }
}

/// Counts emitted characters inside an `OpenAI` `delta` or `message` object for token estimation
/// and first-token detection.
fn count_delta_chars(obj: &Value) -> usize {
    let mut chars = 0usize;
    if let Some(c) = obj.get("content").and_then(Value::as_str) {
        chars = chars.saturating_add(c.chars().count());
    }
    if let Some(r) = obj.get("reasoning_content").and_then(Value::as_str) {
        chars = chars.saturating_add(r.chars().count());
    }
    if let Some(r) = obj.get("reasoning").and_then(Value::as_str) {
        chars = chars.saturating_add(r.chars().count());
    }
    if let Some(tc) = obj.get("tool_calls").and_then(Value::as_array)
        && !tc.is_empty()
    {
        chars = chars.saturating_add(
            tc.iter()
                .map(|v| v.to_string().chars().count())
                .sum::<usize>(),
        );
    }
    chars
}

/// Callback signature executed when a stream completes or drops early.
pub type CompletionCallback = Arc<dyn Fn(RequestLogRecord) + Send + Sync>;

/// `futures::Stream` wrapper transparently inspecting SSE byte chunks without buffering
/// the entire stream, finalizing telemetry and updating `MetricsCache` on completion/drop.
pub struct InspectedByteStream<S> {
    /// Upstream byte stream.
    inner: Pin<Box<S>>,
    /// Telemetry tracker.
    tracker: Arc<Mutex<StreamTelemetryTracker>>,
    /// Live metrics cache updated on completion.
    metrics_cache: MetricsCache,
    /// Callback invoked once with the finalized `RequestLogRecord`.
    on_complete: CompletionCallback,
    /// Emits trailing buffered line once when upstream stream ends.
    tail_flushed: bool,
}

impl<S> std::fmt::Debug for InspectedByteStream<S> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("InspectedByteStream")
            .finish_non_exhaustive()
    }
}

impl<S> InspectedByteStream<S> {
    /// Wraps an upstream byte stream with zero-delay SSE telemetry inspection.
    #[must_use]
    pub fn new(
        inner: S,
        meta: InspectionMetadata,
        metrics_cache: MetricsCache,
        on_complete: CompletionCallback,
    ) -> Self {
        Self {
            inner: Box::pin(inner),
            tracker: Arc::new(Mutex::new(StreamTelemetryTracker::new(meta))),
            metrics_cache,
            on_complete,
            tail_flushed: false,
        }
    }

    /// Finalizes and dispatches telemetry once.
    fn emit_final(&self, error_message: Option<String>) {
        let Ok(mut guard) = self.tracker.lock() else {
            return;
        };
        let pid = guard.meta.provider_id.clone();
        let mid = guard.meta.model_id.clone();
        let status = guard.meta.status_code;
        if let Some((metrics, record)) = guard.finalize(error_message, None) {
            self.metrics_cache.record(
                &pid,
                &mid,
                MetricSample {
                    timestamp: record.created_at,
                    decode_tps: metrics.decode_tps,
                    ttft_ms: metrics.ttft_ms,
                    is_error: status >= 400,
                },
            );
            (self.on_complete)(record);
        }
    }
}

impl<S, E> Stream for InspectedByteStream<S>
where
    S: Stream<Item = Result<Bytes, E>>,
    E: std::error::Error + Send + Sync + 'static,
{
    type Item = Result<Bytes, std::io::Error>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        if self.tail_flushed {
            return Poll::Ready(None);
        }

        match self.inner.as_mut().poll_next(cx) {
            Poll::Pending => Poll::Pending,
            Poll::Ready(Some(Ok(chunk))) => {
                let out = if let Ok(mut guard) = self.tracker.lock() {
                    guard.process_sse_chunk(&chunk)
                } else {
                    chunk
                };
                Poll::Ready(Some(Ok(out)))
            }
            Poll::Ready(Some(Err(err))) => {
                let msg = format!("upstream stream interrupted: {:#}", anyhow::Error::new(err));
                self.emit_final(Some(msg.clone()));
                self.tail_flushed = true;
                Poll::Ready(Some(Err(std::io::Error::other(msg))))
            }
            Poll::Ready(None) => {
                let tail = if let Ok(mut guard) = self.tracker.lock() {
                    guard.finish_sse_tail()
                } else {
                    Bytes::new()
                };
                self.emit_final(None);
                self.tail_flushed = true;
                if tail.is_empty() {
                    Poll::Ready(None)
                } else {
                    Poll::Ready(Some(Ok(tail)))
                }
            }
        }
    }
}

impl<S> Drop for InspectedByteStream<S> {
    fn drop(&mut self) {
        // Ensure telemetry is recorded even if the downstream client disconnects mid-stream.
        self.emit_final(Some("client closed SSE stream early".to_string()));
    }
}

#[cfg(test)]
mod tests {
    use std::thread;
    use std::time::Duration;

    use futures::StreamExt;
    use serde_json::json;

    use super::*;
    use crate::config::MetricsConfig;

    fn test_meta(is_stream: bool, rewrite_model: bool) -> InspectionMetadata {
        InspectionMetadata {
            request_uid: Uuid::new_v4(),
            parent_request_uid: Uuid::new_v4(),
            attempt_index: 1,
            project_id: "coding".to_string(),
            project_name: "VS Code Coding".to_string(),
            call_model_id: "smart-coder".to_string(),
            call_model_name: "Smart Coder".to_string(),
            provider_id: "opencode".to_string(),
            provider_name: "Opencode".to_string(),
            model_id: "qwen3.8-max".to_string(),
            model_name: "Qwen3.8 Max".to_string(),
            route_rule_id: "coding-smart-coder".to_string(),
            status_code: 200,
            is_stream,
            rewrite_response_model: rewrite_model,
            estimated_input_chars: 120,
            reasoning_effort: Some("xhigh".to_string()),
            script_state: json!({}),
            request_headers: None,
            request_body: None,
            t_start: Instant::now(),
            started_at: Utc::now(),
            catalog_snapshot: None,
            gateway_overhead_ms: 0.0,
            routing_ms: 0.0,
            attempt_prep_ms: 0.0,
            upstream_header_ms: 0.0,
        }
    }

    #[test]
    fn sse_inspector_tracks_ttft_decode_tps_usage_and_model_rewrite() {
        let mut tracker = StreamTelemetryTracker::new(test_meta(true, true));
        thread::sleep(Duration::from_millis(25));

        let c1 = tracker.process_sse_chunk(
            b"data: {\"id\":\"1\",\"model\":\"qwen3.8-max\",\"choices\":[{\"delta\":{\"content\":\"Hello \"}}]}\n\n",
        );
        let c1_str = String::from_utf8_lossy(&c1);
        assert!(c1_str.contains("\"model\":\"smart-coder\""));

        thread::sleep(Duration::from_millis(40));
        let _c2 = tracker.process_sse_chunk(
            b"data: {\"id\":\"1\",\"model\":\"qwen3.8-max\",\"choices\":[{\"delta\":{\"content\":\"world!\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":100,\"completion_tokens\":20,\"total_tokens\":120,\"prompt_tokens_details\":{\"cached_tokens\":40},\"completion_tokens_details\":{\"reasoning_tokens\":8}}}\n\ndata: [DONE]\n\n",
        );

        let finalized = tracker.finalize(None, None);
        assert!(finalized.is_some());
        if let Some((metrics, rec)) = finalized {
            assert_eq!(metrics.input_tokens, 100);
            assert_eq!(metrics.output_tokens, 20);
            assert_eq!(metrics.cache_read_tokens, 40);
            assert_eq!(metrics.reasoning_tokens, 8);
            assert_eq!(metrics.token_source, "upstream_usage");
            assert_eq!(metrics.finish_reason.as_deref(), Some("stop"));
            // TTFT >= 20ms, generation >= 30ms, decode_tps > e2e_tps
            assert!(metrics.ttft_ms >= 15.0);
            assert!(metrics.generation_duration_ms >= 25.0);
            assert!(metrics.decode_tps > metrics.e2e_tps);
            assert_eq!(rec.model_id, "qwen3.8-max");
        }
    }

    #[test]
    fn billing_uses_only_the_final_sse_usage_chunk() {
        let mut tracker = StreamTelemetryTracker::new(test_meta(true, false));
        tracker.process_sse_chunk(b"data: {\"choices\":[{\"delta\":{\"content\":\"x\"}}],\"usage\":{\"prompt_tokens\":9,\"completion_tokens\":1,\"prompt_tokens_details\":{\"cached_tokens\":0}}}\n\n");
        let partial = tracker.finalize(None, None);
        assert!(partial.is_some_and(|(_, record)| record.raw_usage.is_none()));

        let mut tracker = StreamTelemetryTracker::new(test_meta(true, false));
        tracker.process_sse_chunk(b"data: {\"choices\":[],\"usage\":{\"prompt_tokens\":9,\"completion_tokens\":1,\"prompt_tokens_details\":{\"cached_tokens\":2,\"cache_write_tokens\":3}}}\n\n");
        let final_record = tracker.finalize(None, None);
        assert!(final_record.is_some_and(|(_, record)| {
            record.raw_usage.is_some()
                && record.cache_read_tokens == 2
                && record.cache_creation_tokens == 3
        }));

        let mut tracker = StreamTelemetryTracker::new(test_meta(true, false));
        tracker.process_sse_chunk(b"data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":9,\"completion_tokens\":1,\"prompt_tokens_details\":{\"cached_tokens\":2}}}\n\n");
        let final_record = tracker.finalize(None, None);
        assert!(final_record.is_some_and(|(_, record)| {
            record.raw_usage.is_some() && record.cache_read_tokens == 2
        }));
    }

    #[test]
    fn oversized_upstream_usage_does_not_overflow_telemetry() {
        let mut tracker = StreamTelemetryTracker::new(test_meta(false, false));
        tracker.process_json_response(br#"{"choices":[],"usage":{"prompt_tokens":9223372036854775807,"completion_tokens":1}}"#);
        let result = tracker.finalize(None, None);
        assert!(result.is_some_and(|(metrics, _)| metrics.total_tokens == i64::MAX));
    }

    #[test]
    fn sse_inspector_forwards_cr_terminated_lines_without_waiting_for_lf() {
        let mut tracker = StreamTelemetryTracker::new(test_meta(true, true));
        let first = tracker.process_sse_chunk(
            b"data: {\"model\":\"upstream\",\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}\r",
        );
        assert!(String::from_utf8_lossy(&first).contains("\"model\":\"smart-coder\""));
        assert!(first.ends_with(b"\r"));

        let second = tracker.process_sse_chunk(b"\n\rdata: [DONE]\r\r");
        assert_eq!(second.as_ref(), b"\n\rdata: [DONE]\r\r");
        assert!(tracker.finish_sse_tail().is_empty());
    }

    #[test]
    fn sse_inspector_passes_partial_lines_through_when_not_rewriting() {
        let mut tracker = StreamTelemetryTracker::new(test_meta(true, false));
        let first = b"data: {\"choices\":[{\"delta\":{\"content\":\"hello";
        let second = b" world\"}}]}\r\n\r\ndata: [DONE]";
        assert_eq!(tracker.process_sse_chunk(first).as_ref(), first);
        assert_eq!(tracker.process_sse_chunk(second).as_ref(), second);
        assert!(tracker.finish_sse_tail().is_empty());
        let finalized = tracker.finalize(None, None);
        assert!(finalized.is_some());
        if let Some((metrics, _)) = finalized {
            assert_eq!(metrics.output_tokens, 2);
        }
    }

    #[tokio::test]
    #[allow(clippy::unwrap_used)]
    async fn interrupted_sse_records_the_underlying_error_once() {
        let recorded = Arc::new(Mutex::new(Vec::new()));
        let output = Arc::clone(&recorded);
        let callback: CompletionCallback = Arc::new(move |record| {
            output.lock().unwrap().push(record);
        });
        let error = std::io::Error::other(std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            "upstream read timed out",
        ));
        let input = futures::stream::iter([Err::<Bytes, _>(error)]);
        let mut stream = InspectedByteStream::new(
            input,
            test_meta(true, false),
            MetricsCache::new(&MetricsConfig::default()),
            callback,
        );
        assert!(stream.next().await.unwrap().is_err());
        assert!(stream.next().await.is_none());
        drop(stream);

        let records = recorded.lock().unwrap();
        assert_eq!(records.len(), 1);
        assert!(
            records[0]
                .error_message
                .as_deref()
                .unwrap()
                .contains("upstream read timed out")
        );
    }

    #[test]
    fn sse_inspector_falls_back_to_char_estimation_when_stream_cuts_early() {
        let mut tracker = StreamTelemetryTracker::new(test_meta(true, false));
        thread::sleep(Duration::from_millis(10));
        let _ = tracker.process_sse_chunk(
            b"data: {\"choices\":[{\"delta\":{\"content\":\"1234567890123456\"}}]}\n\n",
        );

        let finalized = tracker.finalize(Some("connection reset".to_string()), None);
        assert!(finalized.is_some());
        if let Some((metrics, _)) = finalized {
            assert_eq!(metrics.token_source, "fallback_estimated");
            assert_eq!(metrics.input_tokens, 30); // 120 / 4
            assert_eq!(metrics.output_tokens, 4); // 16 / 4
        }
    }
}
