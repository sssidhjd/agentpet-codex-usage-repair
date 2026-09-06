//! Local-only Codex usage reader. Logs are NEVER modified or uploaded.
//! Snapshot delivery is intentionally repeatable; the UI persists the receipt
//! and pet XP in the same ap_care write, so restart/retry is idempotent.
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};
use tauri::{AppHandle, Emitter};

#[derive(Clone, Default)]
struct Cursor {
    offset: u64,
    cumulative: i64,
    has_usage: bool,
}
#[derive(Clone)]
struct Watched {
    path: PathBuf,
    session: String,
    project: String,
    started_at: String,
    source: String,
    seen: Instant,
    cursor: Cursor,
}
fn watched() -> &'static Mutex<HashMap<String, Watched>> {
    static WATCHED: OnceLock<Mutex<HashMap<String, Watched>>> = OnceLock::new();
    WATCHED.get_or_init(|| Mutex::new(HashMap::new()))
}

fn roots() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(home) = dirs::home_dir() { out.push(home.join(".codex/sessions")); }
    if let Some(home) = std::env::var_os("CODEX_HOME") { out.push(PathBuf::from(home).join("sessions")); }
    out.into_iter().filter_map(|p| p.canonicalize().ok()).collect()
}

fn header(path: &Path, session: &str) -> Option<Value> {
    let f = std::fs::File::open(path).ok()?;
    // Metadata lines are small; do not load conversation content to validate a path.
    let mut line = String::new();
    BufReader::new(f).take(65_536).read_line(&mut line).ok()?;
    let v: Value = serde_json::from_str(&line).ok()?;
    (v["type"] == "session_meta" && v["payload"]["id"].as_str() == Some(session)).then_some(v)
}

fn validated(path: &Path, session: &str, roots: &[PathBuf]) -> Option<PathBuf> {
    let p = path.canonicalize().ok()?;
    if p.extension()?.to_str()? != "jsonl" || !roots.iter().any(|r| p.starts_with(r)) { return None; }
    header(&p, session)?;
    Some(p)
}

fn collect(dir: &Path, session: &str, out: &mut Vec<(SystemTime, PathBuf)>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else { continue };
        if kind.is_symlink() { continue; }
        let path = entry.path();
        if kind.is_dir() { collect(&path, session, out); }
        else if path.file_name().and_then(|s| s.to_str())
            .is_some_and(|s| s.starts_with("rollout-") && s.ends_with(".jsonl") && s.contains(session)) {
            let modified = entry.metadata().and_then(|m| m.modified()).unwrap_or(SystemTime::UNIX_EPOCH);
            out.push((modified, path));
        }
    }
}

fn resolve(session: &str, supplied: &str, roots: &[PathBuf]) -> Option<PathBuf> {
    if session.is_empty() { return None; }
    if !supplied.is_empty() {
        if let Some(p) = validated(Path::new(supplied), session, roots) { return Some(p); }
    }
    let mut candidates = Vec::new();
    for root in roots { collect(root, session, &mut candidates); }
    candidates.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.cmp(&a.1)));
    // No cwd-only fallback: different threads in one project must not steal usage.
    candidates.into_iter().find_map(|(_, p)| validated(&p, session, roots))
}

// Stable 128-bit identity, not a credential. Keeps local filenames out of the
// browser receipt. Independent seeds avoid relying on Rust's DefaultHasher ABI.
fn source_id(path: &Path, timestamp: &str) -> String {
    let name = path.to_string_lossy().replace('\\', "/");
    #[cfg(windows)]
    let name = name.to_lowercase();
    let text = format!("{}\0{}", name, timestamp);
    let hash = |seed: u64| text.bytes().fold(seed, |h, b| (h ^ b as u64).wrapping_mul(0x100000001b3));
    format!("codex-v2-{:016x}{:016x}", hash(0xcbf29ce484222325), hash(0x84222325cbf29ce4))
}

pub fn track(session: &str, project: &str, supplied: &str) {
    let Some(path) = resolve(session, supplied, &roots()) else { return };
    let Some(meta) = header(&path, session) else { return };
    let timestamp = meta["payload"]["timestamp"].as_str()
        .or_else(|| meta["timestamp"].as_str()).unwrap_or("").to_string();
    let source = source_id(&path, &timestamp);
    if let Ok(mut map) = watched().lock() {
        let item = map.entry(source.clone()).or_insert_with(|| Watched {
            path, session: session.to_string(), project: project.to_string(),
            started_at: timestamp, source, seen: Instant::now(), cursor: Cursor::default(),
        });
        item.seen = Instant::now();
        item.project = project.to_string();
    }
}

fn effective(v: &Value) -> Option<i64> {
    if v["type"] != "event_msg" || v["payload"]["type"] != "token_count" { return None; }
    let usage = &v["payload"]["info"]["total_token_usage"];
    let input = usage["input_tokens"].as_i64()?;
    let cached = usage["cached_input_tokens"].as_i64()?;
    let output = usage["output_tokens"].as_i64()?;
    if input < 0 || cached < 0 || output < 0 || cached > input { return None; }
    input.checked_sub(cached)?.checked_add(output)
}

fn read_snapshot(path: &Path, cursor: &mut Cursor) -> std::io::Result<Option<i64>> {
    let mut file = std::fs::File::open(path)?;
    if file.metadata()?.len() < cursor.offset {
        // A truncation never authorizes re-counting old usage. The UI retains
        // its previous high-water mark even when this reader re-scans the file.
        cursor.offset = 0;
    }
    file.seek(SeekFrom::Start(cursor.offset))?;
    let mut reader = BufReader::new(file);
    let mut line = Vec::new();
    loop {
        line.clear();
        let n = reader.read_until(b'\n', &mut line)?;
        if n == 0 || line.last() != Some(&b'\n') { break; }
        cursor.offset += n as u64;
        let marker = b"\"total_token_usage\"";
        if !line.windows(marker.len()).any(|w| w == marker) { continue; }
        if let Ok(v) = serde_json::from_slice::<Value>(&line) {
            if let Some(total) = effective(&v) {
                cursor.cumulative = cursor.cumulative.max(total);
                cursor.has_usage = true;
            }
        }
    }
    Ok(cursor.has_usage.then_some(cursor.cumulative))
}

pub fn start(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(3));
        // Do not hold the watcher lock during disk IO or frontend delivery.
        let work: Vec<_> = match watched().lock() {
            Ok(mut map) => {
                map.retain(|_, v| v.seen.elapsed() < Duration::from_secs(86_400));
                map.values().cloned().collect()
            }
            Err(_) => continue,
        };
        for mut item in work {
            match read_snapshot(&item.path, &mut item.cursor) {
                Ok(Some(total)) => {
                    let _ = app.emit("codex-usage-snapshot", serde_json::json!({
                        "source": item.source, "cumulative": total,
                        "startedAt": item.started_at, "session": item.session, "project": item.project,
                    }));
                }
                Ok(None) => {},
                Err(error) => eprintln!("[codex-usage] read unavailable ({:?}); will retry", error.kind()),
            }
            if let Ok(mut map) = watched().lock() {
                if let Some(current) = map.get_mut(&item.source) { current.cursor = item.cursor; }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::sync::atomic::{AtomicU64, Ordering};
    fn temp() -> PathBuf {
        static N: AtomicU64 = AtomicU64::new(0);
        let p = std::env::temp_dir().join(format!("agentpet-v2-test-{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
        std::fs::create_dir_all(&p).unwrap(); p
    }
    fn event(input: i64, cached: i64, output: i64) -> Value {
        serde_json::json!({"type":"event_msg","payload":{"type":"token_count","info":{
            "total_token_usage":{"input_tokens":input,"cached_input_tokens":cached,"output_tokens":output},
            "last_token_usage":{"input_tokens":999,"cached_input_tokens":0,"output_tokens":999}
        }}})
    }
    fn metadata(session: &str) -> String {
        format!("{}\n", serde_json::json!({"type":"session_meta","timestamp":"2026-01-01T00:00:00Z","payload":{"id":session}}))
    }
    #[test]
    fn cumulative_not_repeated_last_usage() {
        assert_eq!(effective(&event(1000, 900, 50)), Some(150));
        assert_eq!(effective(&event(100, 101, 1)), None);
        let mut v = event(100, 0, 1); v["type"] = Value::String("response_item".into());
        assert_eq!(effective(&v), None);
    }
    #[test]
    fn duplicate_partial_restart_truncation() {
        let dir = temp(); let path = dir.join("test.jsonl");
        let a = format!("{}\n", event(1000, 900, 50));
        std::fs::write(&path, format!("{}{}", a, a)).unwrap();
        let mut c = Cursor::default();
        assert_eq!(read_snapshot(&path, &mut c).unwrap(), Some(150));
        assert_eq!(read_snapshot(&path, &mut c).unwrap(), Some(150));
        let b = event(1500, 1300, 100).to_string();
        let mut f = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        f.write_all(b.as_bytes()).unwrap(); f.flush().unwrap();
        assert_eq!(read_snapshot(&path, &mut c).unwrap(), Some(150));
        f.write_all(b"\n").unwrap(); f.flush().unwrap();
        assert_eq!(read_snapshot(&path, &mut c).unwrap(), Some(300));
        assert_eq!(read_snapshot(&path, &mut Cursor::default()).unwrap(), Some(300));
        drop(f);
        std::fs::write(&path, &a).unwrap();
        assert_eq!(read_snapshot(&path, &mut c).unwrap(), Some(300));
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn explicit_path_wins_and_session_is_verified() {
        let dir = temp(); let roots = vec![dir.canonicalize().unwrap()];
        let old = dir.join("rollout-old-test-session.jsonl");
        let new = dir.join("rollout-new-test-session.jsonl");
        std::fs::write(&old, metadata("test-session")).unwrap();
        std::fs::write(&new, metadata("test-session")).unwrap();
        assert_eq!(resolve("test-session", new.to_str().unwrap(), &roots), Some(new.canonicalize().unwrap()));
        assert_eq!(resolve("wrong-session", new.to_str().unwrap(), &roots), None);
        assert_eq!(resolve("", "", &roots), None);
        assert_ne!(source_id(&old, "a"), source_id(&new, "a"));
        assert_ne!(source_id(&old, "a"), source_id(&old, "b"));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
