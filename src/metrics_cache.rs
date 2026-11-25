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

/// Map of `(provider_id, model_id)` to recent observation samples.
type BucketMap = HashMap<(String, String), VecDeque<MetricSample>>;

/// Thread-safe sliding window cache of recent model performance metrics.
#[derive(Debug, Clone)]
pub struct MetricsCache {
    /// Sliding window retention duration.
    window: Duration,
    /// Per `(provider_id, model_id)` observation queues.
    buckets: Arc<RwLock<BucketMap>>,
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
        let queue = guard
            .entry((provider_id.to_string(), model_id.to_string()))
            .or_default();
        queue.push_back(sample);

        let cutoff = Utc::now() - self.window;
        while let Some(front) = queue.front() {
            if front.timestamp < cutoff {
                queue.pop_front();
            } else {
                break;
            }
        }
        // Cap unbounded burst memory at 1000 samples per endpoint.
        while queue.len() > 1000 {
            queue.pop_front();
        }
    }

    /// Loads historical warmup samples (typically from PostgreSQL at startup).
    pub fn warmup(&self, samples: Vec<(String, String, MetricSample)>) {
        let Ok(mut guard) = self.buckets.write() else {
            return;
        };
        for (pid, mid, sample) in samples {
            let queue = guard.entry((pid, mid)).or_default();
            queue.push_back(sample);
            while queue.len() > 1000 {
                queue.pop_front();
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
        let Some(queue) = guard.get(&(provider_id.to_string(), model_id.to_string())) else {
            return CandidateMetrics::default();
        };
        if queue.is_empty() {
            return CandidateMetrics::default();
        }

        let cutoff = Utc::now() - self.window;
        let recent: Vec<&MetricSample> = queue.iter().filter(|s| s.timestamp >= cutoff).collect();
        let active: Vec<&MetricSample> = if recent.is_empty() {
            queue.iter().collect()
        } else {
            recent
        };

        let total = active.len();
        if total == 0 {
            return CandidateMetrics::default();
        }

        let error_count = active.iter().filter(|s| s.is_error).count();
        #[allow(clippy::cast_precision_loss)]
        let error_rate = error_count as f64 / total as f64;

        let mut success_tps: Vec<f64> = active
            .iter()
            .filter(|s| !s.is_error && s.decode_tps > 0.0)
            .map(|s| s.decode_tps)
            .collect();

        let success_ttft: Vec<f64> = active
            .iter()
            .filter(|s| !s.is_error && s.ttft_ms > 0.0)
            .map(|s| s.ttft_ms)
            .collect();

        let avg_decode_tps = if success_tps.is_empty() {
            None
        } else {
            #[allow(clippy::cast_precision_loss)]
            let sum: f64 = success_tps.iter().sum();
            #[allow(clippy::cast_precision_loss)]
            Some(sum / success_tps.len() as f64)
        };

        let p50_decode_tps = if success_tps.is_empty() {
            None
        } else {
            success_tps.sort_by(f64::total_cmp);
            Some(success_tps[success_tps.len() / 2])
        };

        let avg_ttft_ms = if success_ttft.is_empty() {
            None
        } else {
            #[allow(clippy::cast_precision_loss)]
            let sum: f64 = success_ttft.iter().sum();
            #[allow(clippy::cast_precision_loss)]
            Some(sum / success_ttft.len() as f64)
        };

        CandidateMetrics {
            avg_decode_tps,
            p50_decode_tps,
            avg_ttft_ms,
            error_rate: Some(error_rate),
        }
    }

    /// Returns `(endpoint_count, total_samples)` currently held in the sliding window cache.
    #[must_use]
    pub fn stats(&self) -> (usize, usize) {
        let Ok(guard) = self.buckets.read() else {
            return (0, 0);
        };
        let endpoints = guard.len();
        let samples = guard.values().map(VecDeque::len).sum();
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
