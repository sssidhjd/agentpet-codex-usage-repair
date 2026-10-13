//! Privacy-preserving access to the Codex account usage snapshot.
//!
//! The Codex CLI owns authentication.  AgentPet starts a short-lived local
//! `codex app-server`, speaks JSONL over stdio, and copies only the usage and
//! rate-limit fields that the UI needs.  In particular, the raw responses are
//! never returned or logged: they may also contain `accountId`, plan and credit
//! metadata that do not belong in AgentPet's state or diagnostics.

use serde::Serialize;
use serde_json::{json, Value};
use std::env;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const RPC_TIMEOUT: Duration = Duration::from_secs(12);
const MAX_DAILY_BUCKETS: usize = 4_000;

/// The complete public contract exposed to the webview.
///
/// Keep this flat and explicit.  Adding a field must be a deliberate privacy
/// decision; never deserialize an app-server response directly into this type.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAccountSnapshot {
    pub lifetime_tokens: Option<u64>,
    pub peak_daily_tokens: Option<u64>,
    pub longest_running_turn_sec: Option<u64>,
    pub current_streak_days: Option<u64>,
    pub longest_streak_days: Option<u64>,
    pub daily_usage_buckets: Vec<CodexDailyUsageBucket>,
    pub used_percent: Option<f64>,
    pub window_duration_mins: Option<u64>,
    pub resets_at: Option<u64>,
    /// Unix timestamp, in seconds, for the newest data in this snapshot.
    pub updated_at: u64,
    /// True when one or both sources could not be refreshed.
    pub stale: bool,
    /// A controlled, non-sensitive error code (never raw server output).
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexDailyUsageBucket {
    pub start_date: String,
    pub tokens: u64,
}

impl CodexAccountSnapshot {
    fn unavailable(error: &'static str) -> Self {
        Self {
            lifetime_tokens: None,
            peak_daily_tokens: None,
            longest_running_turn_sec: None,
            current_streak_days: None,
            longest_streak_days: None,
            daily_usage_buckets: Vec::new(),
            used_percent: None,
            window_duration_mins: None,
            resets_at: None,
            updated_at: now_unix_seconds(),
            stale: true,
            error: Some(error.to_string()),
        }
    }

    fn fill_missing_from(&mut self, previous: &Self) {
        macro_rules! fill {
            ($field:ident) => {
                if self.$field.is_none() {
                    self.$field = previous.$field;
                }
            };
        }
        fill!(lifetime_tokens);
        fill!(peak_daily_tokens);
        fill!(longest_running_turn_sec);
        fill!(current_streak_days);
        fill!(longest_streak_days);
        fill!(used_percent);
        fill!(window_duration_mins);
        fill!(resets_at);
        if self.daily_usage_buckets.is_empty() {
            self.daily_usage_buckets = previous.daily_usage_buckets.clone();
        }
    }
}

#[derive(Debug)]
struct ParsedUsage {
    lifetime_tokens: u64,
    peak_daily_tokens: u64,
    longest_running_turn_sec: u64,
    current_streak_days: u64,
    longest_streak_days: u64,
    daily_usage_buckets: Vec<CodexDailyUsageBucket>,
}

#[derive(Debug, Default)]
struct ParsedRateLimit {
    used_percent: Option<f64>,
    window_duration_mins: Option<u64>,
    resets_at: Option<u64>,
}

static LAST_GOOD: OnceLock<Mutex<Option<CodexAccountSnapshot>>> = OnceLock::new();

fn cache() -> &'static Mutex<Option<CodexAccountSnapshot>> {
    LAST_GOOD.get_or_init(|| Mutex::new(None))
}

/// Tauri command used by the Care screen.  Process I/O is moved off the async
/// runtime so a missing or slow Codex installation cannot block the webview.
#[tauri::command]
pub async fn get_codex_account_snapshot() -> CodexAccountSnapshot {
    tauri::async_runtime::spawn_blocking(read_codex_account_snapshot)
        .await
        .unwrap_or_else(|_| stale_from_cache("codex_worker_failed"))
}

/// Synchronous entry point for startup prefetches and native callers.
pub fn read_codex_account_snapshot() -> CodexAccountSnapshot {
    match query_app_server() {
        Ok(mut current) => {
            if current.stale {
                if let Ok(guard) = cache().lock() {
                    if let Some(previous) = guard.as_ref() {
                        current.fill_missing_from(previous);
                        // A mixed live/cached snapshot must not claim that all
                        // displayed values were refreshed just now.
                        current.updated_at = previous.updated_at;
                    }
                }
            } else if let Ok(mut guard) = cache().lock() {
                *guard = Some(current.clone());
            }
            current
        }
        Err(code) => stale_from_cache(code),
    }
}

fn stale_from_cache(code: &'static str) -> CodexAccountSnapshot {
    if let Ok(guard) = cache().lock() {
        if let Some(previous) = guard.as_ref() {
            let mut stale = previous.clone();
            stale.stale = true;
            stale.error = Some(code.to_string());
            return stale;
        }
    }
    CodexAccountSnapshot::unavailable(code)
}

fn query_app_server() -> Result<CodexAccountSnapshot, &'static str> {
    let executable = find_codex_binary().ok_or("codex_not_found")?;
    let mut command = Command::new(executable);
    command
        .args(["app-server", "--listen", "stdio://"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        // Never ingest or relay diagnostic output: it is not part of the RPC
        // contract and could contain private local configuration.
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }

    let mut child = ChildGuard::new(command.spawn().map_err(|_| "codex_start_failed")?);
    let stdin = child
        .child_mut()
        .stdin
        .take()
        .ok_or("codex_stdio_unavailable")?;
    let stdout = child
        .child_mut()
        .stdout
        .take()
        .ok_or("codex_stdio_unavailable")?;

    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            // Invalid/non-protocol output is intentionally discarded, not
            // retained in diagnostics.
            if let Ok(value) = serde_json::from_str::<Value>(&line) {
                if tx.send(value).is_err() {
                    break;
                }
            }
        }
    });

    let mut stdin = stdin;
    let deadline = Instant::now() + RPC_TIMEOUT;
    write_jsonl(
        &mut stdin,
        &json!({
            "id": 1,
            "method": "initialize",
            "params": {
                "clientInfo": {
                    "name": "agentpet",
                    "title": "AgentPet",
                    "version": env!("CARGO_PKG_VERSION")
                }
            }
        }),
    )?;

    wait_for_initialize(&rx, deadline)?;
    write_jsonl(&mut stdin, &json!({"method": "initialized", "params": {}}))?;
    // These are deliberately the only account methods AgentPet invokes.
    write_jsonl(
        &mut stdin,
        &json!({"id": 2, "method": "account/usage/read", "params": {}}),
    )?;
    write_jsonl(
        &mut stdin,
        &json!({"id": 3, "method": "account/rateLimits/read", "params": {}}),
    )?;

    let mut usage: Option<Result<ParsedUsage, &'static str>> = None;
    let mut rate_limit: Option<Result<ParsedRateLimit, &'static str>> = None;
    while (usage.is_none() || rate_limit.is_none()) && Instant::now() < deadline {
        let Some(value) = recv_until(&rx, deadline) else { break };
        match rpc_id(&value) {
            Some(2) => {
                usage = Some(
                    rpc_result(&value, "codex_usage_rpc_failed")
                        .and_then(parse_usage_result),
                )
            }
            Some(3) => {
                rate_limit = Some(
                    rpc_result(&value, "codex_rate_limits_rpc_failed")
                        .and_then(parse_rate_limits_result),
                )
            }
            _ => {}
        }
    }

    let usage = usage.unwrap_or(Err("codex_usage_timeout"));
    let rate_limit = rate_limit.unwrap_or(Err("codex_rate_limits_timeout"));
    Ok(snapshot_from_parts(usage, rate_limit))
}

fn snapshot_from_parts(
    usage: Result<ParsedUsage, &'static str>,
    rate_limit: Result<ParsedRateLimit, &'static str>,
) -> CodexAccountSnapshot {
    let mut snapshot = CodexAccountSnapshot::unavailable("codex_account_unavailable");
    let mut errors = Vec::new();

    match usage {
        Ok(value) => {
            snapshot.lifetime_tokens = Some(value.lifetime_tokens);
            snapshot.peak_daily_tokens = Some(value.peak_daily_tokens);
            snapshot.longest_running_turn_sec = Some(value.longest_running_turn_sec);
            snapshot.current_streak_days = Some(value.current_streak_days);
            snapshot.longest_streak_days = Some(value.longest_streak_days);
            snapshot.daily_usage_buckets = value.daily_usage_buckets;
        }
        Err(code) => errors.push(code),
    }
    match rate_limit {
        Ok(value) => {
            snapshot.used_percent = value.used_percent;
            snapshot.window_duration_mins = value.window_duration_mins;
            snapshot.resets_at = value.resets_at;
        }
        Err(code) => errors.push(code),
    }

    snapshot.stale = !errors.is_empty();
    snapshot.error = if errors.is_empty() {
        None
    } else {
        Some(errors.join(";"))
    };
    snapshot
}

fn write_jsonl(stdin: &mut ChildStdin, value: &Value) -> Result<(), &'static str> {
    serde_json::to_writer(&mut *stdin, value).map_err(|_| "codex_rpc_write_failed")?;
    stdin
        .write_all(b"\n")
        .and_then(|_| stdin.flush())
        .map_err(|_| "codex_rpc_write_failed")
}

fn wait_for_initialize(rx: &Receiver<Value>, deadline: Instant) -> Result<(), &'static str> {
    while let Some(value) = recv_until(rx, deadline) {
        if rpc_id(&value) != Some(1) {
            continue;
        }
        return if value.get("result").is_some() && value.get("error").is_none() {
            Ok(())
        } else {
            Err("codex_initialize_failed")
        };
    }
    Err("codex_initialize_timeout")
}

fn recv_until(rx: &Receiver<Value>, deadline: Instant) -> Option<Value> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return None;
    }
    rx.recv_timeout(remaining).ok()
}

fn rpc_id(value: &Value) -> Option<u64> {
    value.get("id").and_then(Value::as_u64)
}

fn rpc_result<'a>(
    value: &'a Value,
    error_code: &'static str,
) -> Result<&'a Value, &'static str> {
    if value.get("error").is_some() {
        return Err(error_code);
    }
    value.get("result").ok_or(error_code)
}

fn parse_usage_result(value: &Value) -> Result<ParsedUsage, &'static str> {
    let summary = value
        .get("summary")
        .and_then(Value::as_object)
        .ok_or("codex_usage_invalid")?;
    let buckets = value
        .get("dailyUsageBuckets")
        .and_then(Value::as_array)
        .ok_or("codex_usage_invalid")?;

    let mut daily_usage_buckets = Vec::with_capacity(buckets.len().min(MAX_DAILY_BUCKETS));
    for bucket in buckets.iter().take(MAX_DAILY_BUCKETS) {
        let Some(start_date) = bucket.get("startDate").and_then(Value::as_str) else {
            continue;
        };
        let Some(tokens) = bucket.get("tokens").and_then(Value::as_u64) else {
            continue;
        };
        // ISO dates are short ASCII strings.  Refuse arbitrary text so even a
        // compromised child cannot smuggle content into persisted UI state.
        if start_date.len() <= 32 && start_date.is_ascii() {
            daily_usage_buckets.push(CodexDailyUsageBucket {
                start_date: start_date.to_string(),
                tokens,
            });
        }
    }

    Ok(ParsedUsage {
        lifetime_tokens: required_u64(summary.get("lifetimeTokens"))?,
        peak_daily_tokens: required_u64(summary.get("peakDailyTokens"))?,
        longest_running_turn_sec: required_u64(summary.get("longestRunningTurnSec"))?,
        current_streak_days: required_u64(summary.get("currentStreakDays"))?,
        longest_streak_days: required_u64(summary.get("longestStreakDays"))?,
        daily_usage_buckets,
    })
}

fn parse_rate_limits_result(value: &Value) -> Result<ParsedRateLimit, &'static str> {
    // Current app-server versions expose `rateLimits.primary`.  The map is a
    // compatibility fallback for versions that only expose per-limit entries.
    let primary = value
        .pointer("/rateLimits/primary")
        .filter(|v| !v.is_null())
        .or_else(|| value.pointer("/rateLimitsByLimitId/codex/primary").filter(|v| !v.is_null()));

    let Some(primary) = primary else {
        // A signed-in account may legitimately have no window (for example an
        // unlimited workspace).  That is an available response, represented
        // with null window fields rather than an error.
        return Ok(ParsedRateLimit::default());
    };
    if !primary.is_object() {
        return Err("codex_rate_limits_invalid");
    }
    Ok(ParsedRateLimit {
        used_percent: primary.get("usedPercent").and_then(Value::as_f64),
        window_duration_mins: primary
            .get("windowDurationMins")
            .and_then(Value::as_u64),
        resets_at: primary.get("resetsAt").and_then(Value::as_u64),
    })
}

fn required_u64(value: Option<&Value>) -> Result<u64, &'static str> {
    value
        .and_then(Value::as_u64)
        .ok_or("codex_usage_invalid")
}

fn now_unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or(0)
}

/// Locate the same Codex binary the user already signed in with.  PATH takes
/// precedence, followed by the Codex desktop app's versioned install folder.
fn find_codex_binary() -> Option<PathBuf> {
    if let Some(path) = env::var_os("AGENTPET_CODEX_BINARY").map(PathBuf::from) {
        if is_executable_file(&path) {
            return Some(path);
        }
    }

    // On Windows prefer the desktop app's newest bundled CLI.  A different or
    // older `codex.exe` on PATH may not implement the account usage RPCs.
    let mut installed = Vec::new();
    #[cfg(windows)]
    if let Some(local) = dirs::data_local_dir() {
        collect_versioned_installs(&local.join("OpenAI").join("Codex").join("bin"), &mut installed);
        installed.push(local.join("Programs").join("Codex").join("codex.exe"));
    }
    #[cfg(not(windows))]
    {
        installed.extend([
            PathBuf::from("/usr/local/bin/codex"),
            PathBuf::from("/opt/homebrew/bin/codex"),
        ]);
        if let Some(home) = dirs::home_dir() {
            installed.push(home.join(".local").join("bin").join("codex"));
        }
    }
    if let Some(found) = installed.into_iter().find(|path| is_executable_file(path)) {
        return Some(found);
    }

    let file_names: &[&str] = if cfg!(windows) {
        &["codex.exe"]
    } else {
        &["codex"]
    };
    if let Some(path) = env::var_os("PATH") {
        for directory in env::split_paths(&path) {
            for name in file_names {
                let candidate = directory.join(name);
                if is_executable_file(&candidate) {
                    return Some(candidate);
                }
            }
        }
    }
    None
}

fn collect_versioned_installs(root: &Path, output: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(root) else { return };
    let mut candidates: Vec<(SystemTime, PathBuf)> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path().join(if cfg!(windows) { "codex.exe" } else { "codex" }))
        .filter(|path| is_executable_file(path))
        .map(|path| {
            let modified = path
                .metadata()
                .and_then(|metadata| metadata.modified())
                .unwrap_or(UNIX_EPOCH);
            (modified, path)
        })
        .collect();
    candidates.sort_by(|a, b| b.0.cmp(&a.0));
    output.extend(candidates.into_iter().map(|(_, path)| path));
}

fn is_executable_file(path: &Path) -> bool {
    path.metadata().map(|metadata| metadata.is_file()).unwrap_or(false)
}

struct ChildGuard {
    child: Child,
}

impl ChildGuard {
    fn new(child: Child) -> Self {
        Self { child }
    }

    fn child_mut(&mut self) -> &mut Child {
        &mut self.child
    }
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        // `kill` is harmless if app-server already exited.  Always `wait` so
        // repeated refreshes cannot accumulate zombies/handles.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    fn sample_usage() -> Value {
        json!({
            "summary": {
                "lifetimeTokens": 3_476_963_318u64,
                "peakDailyTokens": 341_745_985u64,
                "longestRunningTurnSec": 141_503,
                "currentStreakDays": 2,
                "longestStreakDays": 7
            },
            "dailyUsageBuckets": [
                {"startDate": "2026-10-12", "tokens": 35_136_061u64, "private": "drop-me"}
            ],
            "threadUsage": null,
            "accountId": "secret-account-id",
            "email": "private@example.com"
        })
    }

    fn sample_rate_limits() -> Value {
        json!({
            "rateLimits": {
                "primary": {
                    "usedPercent": 39,
                    "windowDurationMins": 10_080,
                    "resetsAt": 1_792_301_973,
                    "secret": "drop-me"
                },
                "credits": {"balance": "private"},
                "planType": "private"
            },
            "accountId": "secret-account-id",
            "email": "private@example.com"
        })
    }

    #[test]
    fn parses_usage_summary_and_daily_buckets() {
        let usage = parse_usage_result(&sample_usage()).expect("valid usage");
        assert_eq!(usage.lifetime_tokens, 3_476_963_318);
        assert_eq!(usage.peak_daily_tokens, 341_745_985);
        assert_eq!(usage.longest_running_turn_sec, 141_503);
        assert_eq!(usage.current_streak_days, 2);
        assert_eq!(usage.longest_streak_days, 7);
        assert_eq!(
            usage.daily_usage_buckets,
            vec![CodexDailyUsageBucket {
                start_date: "2026-10-12".to_string(),
                tokens: 35_136_061,
            }]
        );
    }

    #[test]
    fn parses_primary_rate_limit_and_map_fallback() {
        let direct = parse_rate_limits_result(&sample_rate_limits()).expect("valid limits");
        assert_eq!(direct.used_percent, Some(39.0));
        assert_eq!(direct.window_duration_mins, Some(10_080));
        assert_eq!(direct.resets_at, Some(1_792_301_973));

        let fallback = json!({
            "rateLimits": null,
            "rateLimitsByLimitId": {
                "codex": {"primary": {
                    "usedPercent": 12.5,
                    "windowDurationMins": 300,
                    "resetsAt": 12345
                }}
            }
        });
        let fallback = parse_rate_limits_result(&fallback).expect("valid fallback");
        assert_eq!(fallback.used_percent, Some(12.5));
        assert_eq!(fallback.window_duration_mins, Some(300));
        assert_eq!(fallback.resets_at, Some(12345));
    }

    #[test]
    fn serialized_snapshot_is_a_strict_privacy_whitelist() {
        let snapshot = snapshot_from_parts(
            parse_usage_result(&sample_usage()),
            parse_rate_limits_result(&sample_rate_limits()),
        );
        let value = serde_json::to_value(snapshot).expect("serializable");
        let object = value.as_object().expect("object");
        let actual: BTreeSet<_> = object.keys().map(String::as_str).collect();
        let expected: BTreeSet<_> = [
            "lifetimeTokens",
            "peakDailyTokens",
            "longestRunningTurnSec",
            "currentStreakDays",
            "longestStreakDays",
            "dailyUsageBuckets",
            "usedPercent",
            "windowDurationMins",
            "resetsAt",
            "updatedAt",
            "stale",
            "error",
        ]
        .into_iter()
        .collect();
        assert_eq!(actual, expected);

        let encoded = serde_json::to_string(&value).expect("json");
        for forbidden in [
            "accountId",
            "secret-account-id",
            "email",
            "private@example.com",
            "planType",
            "credits",
            "drop-me",
        ] {
            assert!(!encoded.contains(forbidden), "leaked {forbidden}");
        }
    }

    #[test]
    fn malformed_usage_degrades_to_controlled_error() {
        let snapshot = snapshot_from_parts(
            parse_usage_result(&json!({"summary": {}})),
            Ok(ParsedRateLimit::default()),
        );
        assert!(snapshot.stale);
        assert_eq!(snapshot.error.as_deref(), Some("codex_usage_invalid"));
        assert_eq!(snapshot.lifetime_tokens, None);
    }
}
