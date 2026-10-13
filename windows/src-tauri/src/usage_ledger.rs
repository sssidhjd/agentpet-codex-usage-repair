//! Read-only, local Codex usage ledger.
//!
//! This module scans Codex JSONL transcripts and stores only token accounting
//! metadata. It never modifies a transcript and deliberately exposes no API for
//! awarding pet XP. Historical usage is informational only.

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;
use std::fmt;
use std::fs::File;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::thread::JoinHandle;
use std::time::Duration;

const MAX_REPORTED_ISSUES: usize = 100;

#[derive(Debug)]
pub enum LedgerError {
    Io(std::io::Error),
    Sql(rusqlite::Error),
}

impl fmt::Display for LedgerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(f, "{error}"),
            Self::Sql(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for LedgerError {}

impl From<std::io::Error> for LedgerError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<rusqlite::Error> for LedgerError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Sql(error)
    }
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanIssue {
    pub path: String,
    pub message: String,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgress {
    pub files_discovered: u64,
    pub files_scanned: u64,
    pub bytes_total: u64,
    pub bytes_scanned: u64,
    pub events_seen: u64,
    pub events_inserted: u64,
    pub error_count: u64,
    pub current_file: Option<String>,
    pub finished: bool,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UsageStats {
    pub input_tokens: i64,
    pub cached_input_tokens: i64,
    pub output_tokens: i64,
    pub gross_tokens: i64,
    pub effective_tokens: i64,
    pub today_gross_tokens: i64,
    pub today_effective_tokens: i64,
    pub event_count: i64,
    pub today_event_count: i64,
    pub session_count: i64,
    pub today_session_count: i64,
    pub file_count: i64,
    pub first_event_at: Option<String>,
    pub last_event_at: Option<String>,
    pub today: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanReport {
    pub progress: ScanProgress,
    pub issues: Vec<ScanIssue>,
    pub stats: UsageStats,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", content = "value", rename_all = "camelCase")]
pub enum BackgroundScanUpdate {
    Progress(ScanProgress),
    Finished(ScanReport),
    Failed(String),
}

#[derive(Debug)]
struct FileState {
    session_id: String,
    offset: u64,
    fallback_ordinal: i64,
}

#[derive(Debug, Default)]
struct FileOutcome {
    events_seen: u64,
    events_inserted: u64,
    issues: Vec<ScanIssue>,
    error_count: u64,
}

#[derive(Debug)]
struct UsageEvent {
    ordinal: i64,
    timestamp: String,
    input: i64,
    cached: i64,
    output: i64,
    gross: i64,
    effective: i64,
}

pub struct UsageLedger {
    connection: Connection,
}

impl UsageLedger {
    pub fn open(path: &Path) -> Result<Self, LedgerError> {
        if let Some(parent) = path.parent().filter(|parent| !parent.as_os_str().is_empty()) {
            std::fs::create_dir_all(parent)?;
        }
        let connection = Connection::open(path)?;
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             CREATE TABLE IF NOT EXISTS usage_events (
                 session_id TEXT NOT NULL,
                 event_ordinal INTEGER NOT NULL,
                 timestamp TEXT NOT NULL,
                 event_day TEXT NOT NULL,
                 input_tokens INTEGER NOT NULL,
                 cached_input_tokens INTEGER NOT NULL,
                 output_tokens INTEGER NOT NULL,
                 gross_tokens INTEGER NOT NULL,
                 effective_tokens INTEGER NOT NULL,
                 xp_eligible INTEGER NOT NULL DEFAULT 0 CHECK (xp_eligible = 0),
                 PRIMARY KEY (session_id, event_ordinal)
             );
             CREATE INDEX IF NOT EXISTS usage_events_day_idx
                 ON usage_events(event_day);
             CREATE TABLE IF NOT EXISTS scanned_files (
                 path TEXT PRIMARY KEY,
                 session_id TEXT NOT NULL,
                 offset INTEGER NOT NULL,
                 fallback_ordinal INTEGER NOT NULL DEFAULT 0,
                 file_size INTEGER NOT NULL,
                 scan_generation INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS ledger_meta (
                 key TEXT PRIMARY KEY,
                 value INTEGER NOT NULL
             );
             INSERT OR IGNORE INTO ledger_meta(key, value)
                 VALUES ('scan_generation', 0);",
        )?;
        Ok(Self { connection })
    }

    /// Standard Codex roots, including archived sessions. Duplicate roots are
    /// removed so a custom CODEX_HOME pointing at ~/.codex stays inexpensive.
    pub fn default_roots() -> Vec<PathBuf> {
        let mut bases = Vec::new();
        if let Some(home) = dirs::home_dir() {
            bases.push(home.join(".codex"));
        }
        if let Some(home) = std::env::var_os("CODEX_HOME") {
            bases.push(PathBuf::from(home));
        }

        let mut seen = HashSet::new();
        let mut roots = Vec::new();
        for base in bases {
            for name in ["sessions", "archived_sessions"] {
                let root = base.join(name);
                let key = normalized_path(&root);
                if seen.insert(key) {
                    roots.push(root);
                }
            }
        }
        roots
    }

    pub fn scan_default(&mut self) -> Result<ScanReport, LedgerError> {
        self.scan_roots(&Self::default_roots(), |_| {})
    }

    /// Scans all roots synchronously. The callback is invoked after discovery
    /// and after each file, making it suitable for a Tauri progress event.
    pub fn scan_roots<F>(
        &mut self,
        roots: &[PathBuf],
        mut on_progress: F,
    ) -> Result<ScanReport, LedgerError>
    where
        F: FnMut(&ScanProgress),
    {
        let mut issues = Vec::new();
        let mut error_count = 0;
        let files = discover_files(roots, &mut issues, &mut error_count);
        let bytes_total = files
            .iter()
            .filter_map(|path| std::fs::metadata(path).ok())
            .map(|metadata| metadata.len())
            .sum();
        let generation = self.next_generation()?;
        let mut progress = ScanProgress {
            files_discovered: files.len() as u64,
            bytes_total,
            error_count,
            ..ScanProgress::default()
        };
        on_progress(&progress);

        for path in files {
            progress.current_file = Some(path.to_string_lossy().into_owned());
            let file_size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
            match self.scan_file(&path, generation) {
                Ok(outcome) => {
                    progress.events_seen += outcome.events_seen;
                    progress.events_inserted += outcome.events_inserted;
                    progress.error_count += outcome.error_count;
                    append_issues(&mut issues, outcome.issues);
                }
                Err(error) => {
                    progress.error_count += 1;
                    push_issue(
                        &mut issues,
                        ScanIssue {
                            path: path.to_string_lossy().into_owned(),
                            message: error.to_string(),
                        },
                    );
                }
            }
            progress.files_scanned += 1;
            progress.bytes_scanned = progress.bytes_scanned.saturating_add(file_size);
            on_progress(&progress);
        }

        progress.current_file = None;
        progress.finished = true;
        let stats = self.stats()?;
        on_progress(&progress);
        Ok(ScanReport {
            progress,
            issues,
            stats,
        })
    }

    pub fn stats(&self) -> Result<UsageStats, LedgerError> {
        let today: String = self
            .connection
            .query_row("SELECT date('now', 'localtime')", [], |row| row.get(0))?;
        self.stats_for_day(&today)
    }

    pub fn stats_for_day(&self, day: &str) -> Result<UsageStats, LedgerError> {
        let mut statement = self.connection.prepare(
            "SELECT
                 COALESCE(SUM(input_tokens), 0),
                 COALESCE(SUM(cached_input_tokens), 0),
                 COALESCE(SUM(output_tokens), 0),
                 COALESCE(SUM(gross_tokens), 0),
                 COALESCE(SUM(effective_tokens), 0),
                 COALESCE(SUM(CASE WHEN event_day = ?1 THEN gross_tokens ELSE 0 END), 0),
                 COALESCE(SUM(CASE WHEN event_day = ?1 THEN effective_tokens ELSE 0 END), 0),
                 COUNT(*),
                 COALESCE(SUM(CASE WHEN event_day = ?1 THEN 1 ELSE 0 END), 0),
                 COUNT(DISTINCT session_id),
                 COUNT(DISTINCT CASE WHEN event_day = ?1 THEN session_id END),
                 MIN(NULLIF(timestamp, '')),
                 MAX(NULLIF(timestamp, ''))
             FROM usage_events",
        )?;
        let mut stats = statement.query_row([day], |row| {
            Ok(UsageStats {
                input_tokens: row.get(0)?,
                cached_input_tokens: row.get(1)?,
                output_tokens: row.get(2)?,
                gross_tokens: row.get(3)?,
                effective_tokens: row.get(4)?,
                today_gross_tokens: row.get(5)?,
                today_effective_tokens: row.get(6)?,
                event_count: row.get(7)?,
                today_event_count: row.get(8)?,
                session_count: row.get(9)?,
                today_session_count: row.get(10)?,
                first_event_at: row.get(11)?,
                last_event_at: row.get(12)?,
                today: day.to_string(),
                ..UsageStats::default()
            })
        })?;
        stats.file_count = self.connection.query_row(
            "SELECT COUNT(*) FROM scanned_files
             WHERE scan_generation = (
                 SELECT value FROM ledger_meta WHERE key = 'scan_generation'
             )",
            [],
            |row| row.get(0),
        )?;
        Ok(stats)
    }

    fn next_generation(&self) -> Result<i64, LedgerError> {
        self.connection.execute(
            "UPDATE ledger_meta SET value = value + 1 WHERE key = 'scan_generation'",
            [],
        )?;
        Ok(self.connection.query_row(
            "SELECT value FROM ledger_meta WHERE key = 'scan_generation'",
            [],
            |row| row.get(0),
        )?)
    }

    fn scan_file(&mut self, path: &Path, generation: i64) -> Result<FileOutcome, LedgerError> {
        let session_id = read_session_id(path)?;
        let path_key = normalized_path(path);
        let file_size = std::fs::metadata(path)?.len();
        let previous = self
            .connection
            .query_row(
                "SELECT session_id, offset, fallback_ordinal
                 FROM scanned_files WHERE path = ?1",
                [&path_key],
                |row| {
                    let offset: i64 = row.get(1)?;
                    Ok(FileState {
                        session_id: row.get(0)?,
                        offset: offset.max(0) as u64,
                        fallback_ordinal: row.get::<_, i64>(2)?.max(0),
                    })
                },
            )
            .optional()?;

        let (start_offset, mut fallback_ordinal) = match previous {
            Some(state) if state.session_id == session_id && state.offset <= file_size => {
                (state.offset, state.fallback_ordinal)
            }
            _ => (0, 0),
        };

        let mut file = File::open(path)?;
        file.seek(SeekFrom::Start(start_offset))?;
        let mut reader = BufReader::new(file);
        let mut committed_offset = start_offset;
        let mut line = Vec::new();
        let mut outcome = FileOutcome::default();
        let transaction = self.connection.transaction()?;

        loop {
            line.clear();
            let bytes = reader.read_until(b'\n', &mut line)?;
            if bytes == 0 {
                break;
            }
            if line.last() != Some(&b'\n') {
                break;
            }
            committed_offset = committed_offset.saturating_add(bytes as u64);
            if !contains(&line, b"\"last_token_usage\"") {
                continue;
            }

            let value = match serde_json::from_slice::<Value>(&line) {
                Ok(value) => value,
                Err(error) => {
                    record_line_issue(path, error.to_string(), &mut outcome);
                    continue;
                }
            };
            if value["type"] != "event_msg" || value["payload"]["type"] != "token_count" {
                continue;
            }
            outcome.events_seen += 1;
            let ordinal = match value.get("ordinal").and_then(Value::as_i64) {
                Some(ordinal) if ordinal >= 0 => ordinal,
                _ => {
                    // Older logs did not always carry a top-level ordinal. A
                    // negative token-event sequence remains stable across a
                    // path move and cannot collide with native ordinals.
                    fallback_ordinal = fallback_ordinal.saturating_add(1);
                    -fallback_ordinal
                }
            };
            match parse_usage_event(&value, ordinal) {
                Ok(event) => {
                    outcome.events_inserted +=
                        insert_event(&transaction, &session_id, &event)? as u64;
                }
                Err(message) => record_line_issue(path, message, &mut outcome),
            }
        }

        transaction.execute(
            "INSERT INTO scanned_files(
                 path, session_id, offset, fallback_ordinal, file_size, scan_generation
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(path) DO UPDATE SET
                 session_id = excluded.session_id,
                 offset = excluded.offset,
                 fallback_ordinal = excluded.fallback_ordinal,
                 file_size = excluded.file_size,
                 scan_generation = excluded.scan_generation",
            params![
                path_key,
                session_id,
                to_sql_integer(committed_offset),
                fallback_ordinal,
                to_sql_integer(file_size),
                generation
            ],
        )?;
        transaction.commit()?;
        Ok(outcome)
    }
}

/// Runs a one-shot scan without sharing a SQLite connection across threads.
pub fn start_background_scan<F>(
    db_path: PathBuf,
    roots: Vec<PathBuf>,
    on_update: F,
) -> JoinHandle<()>
where
    F: Fn(BackgroundScanUpdate) + Send + 'static,
{
    std::thread::spawn(move || {
        let result = UsageLedger::open(&db_path).and_then(|mut ledger| {
            ledger.scan_roots(&roots, |progress| {
                on_update(BackgroundScanUpdate::Progress(progress.clone()));
            })
        });
        match result {
            Ok(report) => on_update(BackgroundScanUpdate::Finished(report)),
            Err(error) => on_update(BackgroundScanUpdate::Failed(error.to_string())),
        }
    })
}

fn read_session_id(path: &Path) -> Result<String, LedgerError> {
    let file = File::open(path)?;
    let mut reader = BufReader::new(file);
    let mut line = Vec::new();
    for _ in 0..32 {
        line.clear();
        if reader.read_until(b'\n', &mut line)? == 0 {
            break;
        }
        if !contains(&line, b"\"session_meta\"") {
            continue;
        }
        let value: Value = serde_json::from_slice(&line).map_err(|error| {
            LedgerError::Io(std::io::Error::new(std::io::ErrorKind::InvalidData, error))
        })?;
        if value["type"] != "session_meta" {
            continue;
        }
        if let Some(id) = value["payload"]["id"]
            .as_str()
            .or_else(|| value["payload"]["session_id"].as_str())
            .filter(|id| !id.is_empty())
        {
            return Ok(id.to_string());
        }
    }
    Err(LedgerError::Io(std::io::Error::new(
        std::io::ErrorKind::InvalidData,
        "Codex session_meta id was not found",
    )))
}

fn parse_usage_event(value: &Value, ordinal: i64) -> Result<UsageEvent, String> {
    let usage = value["payload"]["info"]
        .get("last_token_usage")
        .ok_or_else(|| "token event has no last_token_usage".to_string())?;
    let input = token_integer(usage, "input_tokens")?;
    let cached = token_integer(usage, "cached_input_tokens")?;
    let output = token_integer(usage, "output_tokens")?;
    if cached > input {
        return Err("cached_input_tokens exceeds input_tokens".to_string());
    }
    let gross = input
        .checked_add(output)
        .ok_or_else(|| "gross token count overflowed".to_string())?;
    let effective = input
        .checked_sub(cached)
        .and_then(|value| value.checked_add(output))
        .ok_or_else(|| "effective token count overflowed".to_string())?;
    Ok(UsageEvent {
        ordinal,
        timestamp: value["timestamp"].as_str().unwrap_or_default().to_string(),
        input,
        cached,
        output,
        gross,
        effective,
    })
}

fn token_integer(value: &Value, key: &str) -> Result<i64, String> {
    value
        .get(key)
        .and_then(Value::as_i64)
        .filter(|number| *number >= 0)
        .ok_or_else(|| format!("{key} is missing or invalid"))
}

fn insert_event(
    transaction: &Transaction<'_>,
    session_id: &str,
    event: &UsageEvent,
) -> Result<usize, rusqlite::Error> {
    transaction.execute(
        "INSERT OR IGNORE INTO usage_events(
             session_id, event_ordinal, timestamp, event_day,
             input_tokens, cached_input_tokens, output_tokens,
             gross_tokens, effective_tokens, xp_eligible
         ) VALUES (
             ?1, ?2, ?3,
             COALESCE(date(?3, 'localtime'), substr(?3, 1, 10), ''),
             ?4, ?5, ?6, ?7, ?8, 0
         )",
        params![
            session_id,
            event.ordinal,
            event.timestamp,
            event.input,
            event.cached,
            event.output,
            event.gross,
            event.effective
        ],
    )
}

fn discover_files(
    roots: &[PathBuf],
    issues: &mut Vec<ScanIssue>,
    error_count: &mut u64,
) -> Vec<PathBuf> {
    fn visit(
        path: &Path,
        seen: &mut HashSet<String>,
        files: &mut Vec<PathBuf>,
        issues: &mut Vec<ScanIssue>,
        error_count: &mut u64,
    ) {
        let entries = match std::fs::read_dir(path) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
            Err(error) => {
                *error_count += 1;
                push_issue(
                    issues,
                    ScanIssue {
                        path: path.to_string_lossy().into_owned(),
                        message: error.to_string(),
                    },
                );
                return;
            }
        };
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => {
                    *error_count += 1;
                    push_issue(
                        issues,
                        ScanIssue {
                            path: path.to_string_lossy().into_owned(),
                            message: error.to_string(),
                        },
                    );
                    continue;
                }
            };
            let child = entry.path();
            let kind = match entry.file_type() {
                Ok(kind) => kind,
                Err(error) => {
                    *error_count += 1;
                    push_issue(
                        issues,
                        ScanIssue {
                            path: child.to_string_lossy().into_owned(),
                            message: error.to_string(),
                        },
                    );
                    continue;
                }
            };
            if kind.is_symlink() {
                continue;
            }
            if kind.is_dir() {
                visit(&child, seen, files, issues, error_count);
            } else if kind.is_file() && child.extension().and_then(|v| v.to_str()) == Some("jsonl") {
                if seen.insert(normalized_path(&child)) {
                    files.push(child);
                }
            }
        }
    }

    let mut files = Vec::new();
    let mut seen = HashSet::new();
    for root in roots {
        visit(root, &mut seen, &mut files, issues, error_count);
    }
    files.sort();
    files
}

fn normalized_path(path: &Path) -> String {
    let value = path.to_string_lossy().replace('\\', "/");
    #[cfg(windows)]
    let value = value.to_lowercase();
    value
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|window| window == needle)
}

fn to_sql_integer(value: u64) -> i64 {
    value.min(i64::MAX as u64) as i64
}

fn record_line_issue(path: &Path, message: String, outcome: &mut FileOutcome) {
    outcome.error_count += 1;
    push_issue(
        &mut outcome.issues,
        ScanIssue {
            path: path.to_string_lossy().into_owned(),
            message,
        },
    );
}

fn push_issue(issues: &mut Vec<ScanIssue>, issue: ScanIssue) {
    if issues.len() < MAX_REPORTED_ISSUES {
        issues.push(issue);
    }
}

fn append_issues(target: &mut Vec<ScanIssue>, source: Vec<ScanIssue>) {
    for issue in source {
        push_issue(target, issue);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn temp_dir() -> PathBuf {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "agentpet-usage-ledger-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    fn meta(session: &str) -> String {
        serde_json::json!({
            "timestamp": "2026-01-02T00:00:00Z",
            "ordinal": 0,
            "type": "session_meta",
            "payload": { "id": session }
        })
        .to_string()
    }

    fn event(ordinal: i64, timestamp: &str, input: i64, cached: i64, output: i64) -> String {
        serde_json::json!({
            "timestamp": timestamp,
            "ordinal": ordinal,
            "type": "event_msg",
            "payload": {
                "type": "token_count",
                "info": {
                    "last_token_usage": {
                        "input_tokens": input,
                        "cached_input_tokens": cached,
                        "output_tokens": output
                    }
                }
            }
        })
        .to_string()
    }

    fn create_ledger(root: &Path) -> UsageLedger {
        UsageLedger::open(&root.join("usage.sqlite3")).unwrap()
    }

    #[test]
    fn scans_last_usage_and_appends_incrementally() {
        let root = temp_dir();
        let sessions = root.join("sessions");
        std::fs::create_dir_all(&sessions).unwrap();
        let log = sessions.join("rollout.jsonl");
        std::fs::write(
            &log,
            format!(
                "{}\n{}\n{}\n",
                meta("session-a"),
                event(7, "2026-01-02T12:00:00Z", 100, 80, 10),
                serde_json::json!({"type":"event_msg","payload":{"type":"other"}})
            ),
        )
        .unwrap();

        let mut ledger = create_ledger(&root);
        let first = ledger.scan_roots(&[sessions.clone()], |_| {}).unwrap();
        assert_eq!(first.progress.events_inserted, 1);
        assert_eq!(first.stats.gross_tokens, 110);
        assert_eq!(first.stats.effective_tokens, 30);
        assert_eq!(first.stats.session_count, 1);

        let second = ledger.scan_roots(&[sessions.clone()], |_| {}).unwrap();
        assert_eq!(second.progress.events_seen, 0);
        assert_eq!(second.stats.event_count, 1);

        let mut file = std::fs::OpenOptions::new().append(true).open(&log).unwrap();
        writeln!(file, "{}", event(9, "2026-01-03T12:00:00Z", 50, 20, 5)).unwrap();
        let third = ledger.scan_roots(&[sessions], |_| {}).unwrap();
        assert_eq!(third.progress.events_inserted, 1);
        assert_eq!(third.stats.gross_tokens, 165);
        assert_eq!(third.stats.effective_tokens, 65);
        assert_eq!(third.stats.event_count, 2);
        drop(file);
        drop(ledger);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn archive_move_does_not_duplicate_events() {
        let root = temp_dir();
        let sessions = root.join("sessions");
        let archive = root.join("archived_sessions");
        std::fs::create_dir_all(&sessions).unwrap();
        std::fs::create_dir_all(&archive).unwrap();
        let active = sessions.join("rollout.jsonl");
        std::fs::write(
            &active,
            format!(
                "{}\n{}\n",
                meta("session-move"),
                event(4, "2026-01-02T12:00:00Z", 20, 10, 2)
            ),
        )
        .unwrap();
        let mut ledger = create_ledger(&root);
        ledger
            .scan_roots(&[sessions.clone(), archive.clone()], |_| {})
            .unwrap();
        std::fs::rename(&active, archive.join("moved.jsonl")).unwrap();
        let report = ledger.scan_roots(&[sessions, archive], |_| {}).unwrap();
        assert_eq!(report.progress.events_seen, 1);
        assert_eq!(report.progress.events_inserted, 0);
        assert_eq!(report.stats.event_count, 1);
        assert_eq!(report.stats.file_count, 1);
        drop(ledger);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn truncated_file_rescan_is_idempotent() {
        let root = temp_dir();
        let sessions = root.join("sessions");
        std::fs::create_dir_all(&sessions).unwrap();
        let log = sessions.join("rollout.jsonl");
        std::fs::write(
            &log,
            format!(
                "{}\n{}\n{}\n",
                meta("session-truncate"),
                event(2, "2026-01-02T12:00:00Z", 10, 2, 1),
                "x".repeat(8_192)
            ),
        )
        .unwrap();
        let mut ledger = create_ledger(&root);
        ledger.scan_roots(&[sessions.clone()], |_| {}).unwrap();

        std::fs::write(
            &log,
            format!(
                "{}\n{}\n{}\n",
                meta("session-truncate"),
                event(2, "2026-01-02T12:00:00Z", 10, 2, 1),
                event(3, "2026-01-03T12:00:00Z", 12, 4, 2)
            ),
        )
        .unwrap();
        let report = ledger.scan_roots(&[sessions], |_| {}).unwrap();
        assert_eq!(report.progress.events_seen, 2);
        assert_eq!(report.progress.events_inserted, 1);
        assert_eq!(report.stats.event_count, 2);
        assert_eq!(report.stats.gross_tokens, 25);
        assert_eq!(report.stats.effective_tokens, 19);
        drop(ledger);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn partial_line_is_retried_after_newline_arrives() {
        let root = temp_dir();
        let sessions = root.join("sessions");
        std::fs::create_dir_all(&sessions).unwrap();
        let log = sessions.join("rollout.jsonl");
        let pending = event(8, "2026-01-02T12:00:00Z", 30, 10, 3);
        std::fs::write(&log, format!("{}\n{}", meta("session-partial"), pending)).unwrap();
        let mut ledger = create_ledger(&root);
        let first = ledger.scan_roots(&[sessions.clone()], |_| {}).unwrap();
        assert_eq!(first.stats.event_count, 0);

        let mut file = std::fs::OpenOptions::new().append(true).open(&log).unwrap();
        writeln!(file).unwrap();
        let second = ledger.scan_roots(&[sessions], |_| {}).unwrap();
        assert_eq!(second.stats.event_count, 1);
        assert_eq!(second.stats.effective_tokens, 23);
        drop(file);
        drop(ledger);
        std::fs::remove_dir_all(root).unwrap();
    }
}
