//! Linguist programmable script-routed `OpenAI` Chat API gateway and token telemetry library.

pub mod billing;
pub mod catalog;
pub mod config;
pub mod db;
pub mod icons;
pub mod metrics_cache;
pub mod models;
pub mod proxy;
pub mod script_engine;
pub mod state;
pub mod web;

/// Returns the crate version string.
#[must_use]
pub fn crate_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}
