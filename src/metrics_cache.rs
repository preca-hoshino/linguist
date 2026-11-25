//! In-memory sliding-window performance metrics cache feeding Stage ③ route selection.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, RwLock};

use chrono::{DateTime, Duration, Utc};

use crate::config::MetricsConfig;
use crate::models::CandidateMetrics;

/// Individual timing sample recorded for a `(provider_id, model_id)` endpoint.
#[derive(Debug, Clone)]
pub struct MetricSample {
    /// Observation timestamp.
    pub timestamp: DateTime<Utc>,
    /// Measured decode tokens per second (`0.0` on error).
    pub decode_tps: f64,
    /// Measured time-to-first-token in milliseconds.
    pub ttft_ms: f64,
    /// Whether the upstream call failed.
    pub is_error: bool,
}

/// Per-endpoint sliding window samples plus pre-computed summary metrics.
#[derive(Debug, Default)]
struct BucketEntry {
    /// Chronological observation queue (capped at 1000 samples).
    queue: VecDeque<MetricSample>,
    /// Pre-computed metrics summary updated on write.
    cached: CandidateMetrics,
}

/// Nested map `provider_id -> model_id -> BucketEntry` enabling zero-allocation `&str` lookups.
type BucketMap = HashMap<String, HashMap<String, BucketEntry>>;

/// Thread-safe sliding window cache of recent model performance metrics.
#[derive(Debug, Clone)]
pub struct MetricsCache {
    /// Sliding window retention duration.
    window: Duration,
    /// Per `(provider_id, model_id)` observation queues and cached aggregates.
    buckets: Arc<RwLock<BucketMap>>,
}

/// Computes aggregated `CandidateMetrics` from `queue`, filtering by `cutoff` when recent samples exist.
fn compute_candidate_metrics(
    queue: &VecDeque<MetricSample>,
    cutoff: DateTime<Utc>,
) -> CandidateMetrics {
    if queue.is_empty() {
        return CandidateMetrics::default();
    }

    let has_recent = queue.back().is_some_and(|s| s.timestamp >= cutoff);
    let mut total = 0usize;
    let mut error_count = 0usize;
    let mut sum_tps = 0.0f64;
    let mut tps_count = 0usize;
    let mut sum_ttft = 0.0f64;
    let mut ttft_count = 0usize;
    let mut success_tps = Vec::new();

    for s in queue {
        if has_recent && s.timestamp < cutoff {
            continue;
        }
        total += 1;
        if s.is_error {
            error_count += 1;
        } else {
            if s.decode_tps > 0.0 {
                sum_tps += s.decode_tps;
                tps_count += 1;
                success_tps.push(s.decode_tps);
            }
            if s.ttft_ms > 0.0 {
                sum_ttft += s.ttft_ms;
                ttft_count += 1;
            }
        }
    }

    if total == 0 {
        return CandidateMetrics::default();
    }

    #[allow(clippy::cast_precision_loss)]
    let error_rate = error_count as f64 / total as f64;
    #[allow(clippy::cast_precision_loss)]
    let avg_decode_tps = (tps_count > 0).then(|| sum_tps / tps_count as f64);
    let p50_decode_tps = if success_tps.is_empty() {
        None
    } else {
        let mid = success_tps.len() / 2;
        let (_, median, _) = success_tps.select_nth_unstable_by(mid, f64::total_cmp);
        Some(*median)
    };
    #[allow(clippy::cast_precision_loss)]
    let avg_ttft_ms = (ttft_count > 0).then(|| sum_ttft / ttft_count as f64);

    CandidateMetrics {
        avg_decode_tps,
        p50_decode_tps,
        avg_ttft_ms,
        error_rate: Some(error_rate),
    }
}

impl MetricsCache {
    /// Creates an empty `MetricsCache` configured with `metrics_cfg.sliding_window_minutes`.
    #[must_use]
    pub fn new(metrics_cfg: &MetricsConfig) -> Self {
        let mins = i64::try_from(metrics_cfg.sliding_window_minutes.max(1)).unwrap_or(60);
        Self {
            window: Duration::minutes(mins),
            buckets: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Records a single observation and prunes expired samples for that endpoint.
    pub fn record(&self, provider_id: &str, model_id: &str, sample: MetricSample) {
        let Ok(mut guard) = self.buckets.write() else {
            return;
        };
        let models = if let Some(m) = guard.get_mut(provider_id) {
            m
        } else {
            guard.entry(provider_id.to_string()).or_default()
        };
        let entry = if let Some(e) = models.get_mut(model_id) {
            e
        } else {
            models.entry(model_id.to_string()).or_default()
        };
        entry.queue.push_back(sample);

        let cutoff = Utc::now() - self.window;
        while let Some(front) = entry.queue.front() {
            if front.timestamp < cutoff {
                entry.queue.pop_front();
            } else {
                break;
            }
        }
        // Cap unbounded burst memory at 1000 samples per endpoint.
        while entry.queue.len() > 1000 {
            entry.queue.pop_front();
        }
        entry.cached = compute_candidate_metrics(&entry.queue, cutoff);
    }

    /// Loads historical warmup samples (typically from PostgreSQL at startup).
    pub fn warmup(&self, samples: Vec<(String, String, MetricSample)>) {
        let Ok(mut guard) = self.buckets.write() else {
            return;
        };
        for (pid, mid, sample) in samples {
            let entry = guard.entry(pid).or_default().entry(mid).or_default();
            entry.queue.push_back(sample);
            while entry.queue.len() > 1000 {
                entry.queue.pop_front();
            }
        }
        let cutoff = Utc::now() - self.window;
        for models in guard.values_mut() {
            for entry in models.values_mut() {
                entry.cached = compute_candidate_metrics(&entry.queue, cutoff);
            }
        }
    }

    /// Computes aggregated `CandidateMetrics` for `(provider_id, model_id)` over the active
    /// sliding window (or falls back to cached warmup samples if recent window is empty).
    #[must_use]
    pub fn get_metrics(&self, provider_id: &str, model_id: &str) -> CandidateMetrics {
        let Ok(guard) = self.buckets.read() else {
            return CandidateMetrics::default();
        };
        let Some(entry) = guard.get(provider_id).and_then(|m| m.get(model_id)) else {
            return CandidateMetrics::default();
        };
        if entry.queue.is_empty() {
            return CandidateMetrics::default();
        }

        let cutoff = Utc::now() - self.window;
        let front_recent = entry.queue.front().is_some_and(|s| s.timestamp >= cutoff);
        let back_expired = entry.queue.back().is_some_and(|s| s.timestamp < cutoff);
        // Fast O(1) zero-allocation path when all samples are inside window or all are in warmup fallback.
        if front_recent || back_expired {
            return entry.cached.clone();
        }

        compute_candidate_metrics(&entry.queue, cutoff)
    }

    /// Returns `(endpoint_count, total_samples)` currently held in the sliding window cache.
    #[must_use]
    pub fn stats(&self) -> (usize, usize) {
        let Ok(guard) = self.buckets.read() else {
            return (0, 0);
        };
        let endpoints = guard.values().map(HashMap::len).sum();
        let samples = guard
            .values()
            .flat_map(|m| m.values())
            .map(|e| e.queue.len())
            .sum();
        (endpoints, samples)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn computes_averages_p50_and_error_rate() {
        let cache = MetricsCache::new(&MetricsConfig::default());
        let now = Utc::now();
        cache.record(
            "deepseek",
            "deepseek-v4-pro",
            MetricSample {
                timestamp: now,
                decode_tps: 60.0,
                ttft_ms: 400.0,
                is_error: false,
            },
        );
        cache.record(
            "deepseek",
            "deepseek-v4-pro",
            MetricSample {
                timestamp: now,
                decode_tps: 100.0,
                ttft_ms: 200.0,
                is_error: false,
            },
        );
        cache.record(
            "deepseek",
            "deepseek-v4-pro",
            MetricSample {
                timestamp: now,
                decode_tps: 80.0,
                ttft_ms: 300.0,
                is_error: false,
            },
        );
        cache.record(
            "deepseek",
            "deepseek-v4-pro",
            MetricSample {
                timestamp: now,
                decode_tps: 0.0,
                ttft_ms: 0.0,
                is_error: true,
            },
        );

        let metrics = cache.get_metrics("deepseek", "deepseek-v4-pro");
        assert_eq!(metrics.avg_decode_tps, Some(80.0));
        assert_eq!(metrics.p50_decode_tps, Some(80.0));
        assert_eq!(metrics.avg_ttft_ms, Some(300.0));
        assert_eq!(metrics.error_rate, Some(0.25));
    }
}
