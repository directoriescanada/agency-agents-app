//! Office — the task runner behind the isometric office view.
//!
//! The office shows every catalog agent at a desk, grouped by division. A
//! task typed into the office is handed to one agent and run for real
//! through the Claude Code CLI (`claude -p`) with that agent's persona as
//! the system prompt. Progress streams back to the window as `office:task`
//! events; the finished deliverable is written to
//! `<app data>/office/deliverables/` and a one-line record is appended to
//! `<app data>/office/tasks.jsonl` so history survives a relaunch.
//!
//! Standing rule for the agents: read freely, never act. Each run is
//! started with a read-only tool allowlist (web search/fetch and file
//! reads inside the office workspace); Bash, file edits and sub-agents are
//! disallowed. Nothing leaves this machine unless the user's own Claude
//! Code connectors are invoked by the prompt, and even then only through
//! the tools Claude Code grants a `-p` session.
//!
//! Runner discovery: `claude` is looked up on `PATH` plus the usual
//! install locations, because a GUI app launched from Finder inherits a
//! minimal `PATH`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::{watch, Mutex};

pub mod team;

use crate::error::AppError;
use crate::state::AppState;

/// Event name the frontend listens on.
pub const TASK_EVENT: &str = "office:task";

/// Cap on turns per task so a runaway tool loop cannot burn the user's plan.
const MAX_TURNS: u32 = 15;

/// Tools an agent may use. Read-only by design.
const ALLOWED_TOOLS: &str = "WebSearch,WebFetch,Read,Glob,Grep";
/// Tools an agent may never use from the office.
const DISALLOWED_TOOLS: &str = "Bash,Edit,Write,MultiEdit,NotebookEdit,Agent,Task";

/// Flags that keep a run to the office's own setup instead of whatever is
/// installed in the user's personal Claude Code: no MCP servers, no skills,
/// and no user-level settings, which is where personal plugins (and their
/// hooks) are switched on. Sign-in lives in the keychain and is unaffected.
/// Deliberately not `--bare`: that skips the keychain and signs the run out.
const ISOLATION_ARGS: [&str; 4] = [
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--setting-sources",
    "project,local",
];

/// Where tasks run. Kept inside app data so file reads cannot wander into
/// the user's own projects by accident.
fn office_dir(state: &AppState) -> PathBuf {
    state.app_data_dir.join("office")
}

// ---------- Records ----------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskStatus {
    Running,
    Done,
    Error,
    Cancelled,
}

/// What a record stands for.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskKind {
    /// One agent, one deliverable.
    #[default]
    Solo,
    /// A lead's team task: the lead plans, members work parts, the lead merges.
    Team,
    /// One member's share of a team task.
    Part,
}

/// Where a team task stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TeamPhase {
    Planning,
    Working,
    Merging,
    Done,
}

/// One task, as the frontend sees it. Also the shape of each
/// `tasks.jsonl` line once the task has finished.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRecord {
    pub id: String,
    pub agent_slug: String,
    pub agent_name: String,
    pub department: String,
    pub prompt: String,
    pub status: TaskStatus,
    /// RFC 3339.
    pub started_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<String>,
    /// Final deliverable (Markdown). Empty while running.
    pub output: String,
    /// Tool names used, in first-use order.
    pub tools_used: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deliverable_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub num_turns: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Lines written before team tasks existed have no kind: they are solo.
    #[serde(default)]
    pub kind: TaskKind,
    /// Part: the team task it belongs to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    /// Team: how far it got.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phase: Option<TeamPhase>,
    /// Team: the members' slugs in plan order. The lead is the record's
    /// own agent and is not listed.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub members: Vec<String>,
    /// Part: what the lead asked this member for. `prompt` stays the
    /// whole team's task.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub brief: Option<String>,
}

impl TaskRecord {
    /// A solo task for `agent`, starting now.
    fn new(agent: &crate::types::Agent, prompt: &str) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            agent_slug: agent.slug.clone(),
            agent_name: agent.name.clone(),
            department: agent.category.clone(),
            prompt: prompt.to_string(),
            status: TaskStatus::Running,
            started_at: now_rfc3339(),
            finished_at: None,
            output: String::new(),
            tools_used: Vec::new(),
            deliverable_path: None,
            cost_usd: None,
            duration_ms: None,
            num_turns: None,
            error: None,
            kind: TaskKind::Solo,
            parent_id: None,
            phase: None,
            members: Vec::new(),
            brief: None,
        }
    }
}

/// Streamed to the window as the task progresses.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum TaskEvent {
    Started { task: TaskRecord },
    /// A chunk of assistant text as it is produced.
    Delta { task_id: String, text: String },
    /// The agent started using a tool.
    Tool { task_id: String, tool: String },
    /// A team task moved on. `members` is the plan once there is one.
    Phase {
        task_id: String,
        phase: TeamPhase,
        members: Vec<String>,
    },
    /// Terminal: done, error or cancelled — `task` carries the final record.
    Finished { task: TaskRecord },
}

/// Whether the Claude Code CLI is reachable and signed in.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunnerStatus {
    pub available: bool,
    /// `claude auth status` says a login is present. `None` = unknown
    /// (older CLI without the subcommand); the task will tell.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub logged_in: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    pub workspace: String,
}

/// Who should take a task — the answer from [`office_route`].
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteResult {
    pub agent_slug: String,
    /// `"claude"` when the model chose, `"fallback"` when the caller's
    /// suggestion was kept because the model gave nothing usable.
    pub via: String,
}

// ---------- Runtime (managed by Tauri) ----------

/// A stop request that can be awaited and asked about. Once stopped it
/// stays stopped, so a run that has not started yet still sees it, and any
/// number of waiters may wait on the same signal: every part of a team
/// task waits on its team's.
struct StopSignal {
    tx: watch::Sender<bool>,
}

impl Default for StopSignal {
    fn default() -> Self {
        Self {
            tx: watch::channel(false).0,
        }
    }
}

impl StopSignal {
    fn stop(&self) {
        self.tx.send_replace(true);
    }

    fn is_stopped(&self) -> bool {
        *self.tx.borrow()
    }

    /// Resolves once `stop` has been called, however long ago.
    async fn wait(&self) {
        let mut rx = self.tx.subscribe();
        // The sender lives as long as `self`, so this cannot fail.
        let _ = rx.wait_for(|stopped| *stopped).await;
    }
}

/// Live tasks. Registered with `app.manage()` in `lib.rs`.
#[derive(Default)]
pub struct OfficeRuntime {
    running: Mutex<HashMap<String, Arc<StopSignal>>>,
}

// ---------- Runner discovery ----------

/// Directories a GUI app may be missing from its `PATH`.
fn extra_bin_dirs() -> Vec<PathBuf> {
    let mut v = vec![
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/bin"),
        PathBuf::from("/bin"),
    ];
    if let Some(home) = dirs::home_dir() {
        v.push(home.join(".claude/local/bin"));
        v.push(home.join(".local/bin"));
        v.push(home.join(".npm-global/bin"));
        v.push(home.join(".bun/bin"));
        v.push(home.join(".volta/bin"));
    }
    v
}

fn claude_binary_name() -> &'static str {
    if cfg!(windows) {
        "claude.exe"
    } else {
        "claude"
    }
}

/// `PATH` for the child: the inherited one plus the usual install dirs.
fn child_path_var() -> String {
    let inherited = std::env::var_os("PATH").unwrap_or_default();
    let mut dirs: Vec<PathBuf> = std::env::split_paths(&inherited).collect();
    for d in extra_bin_dirs() {
        if !dirs.contains(&d) {
            dirs.push(d);
        }
    }
    std::env::join_paths(dirs)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| inherited.to_string_lossy().into_owned())
}

/// Find the `claude` executable.
pub fn find_claude() -> Option<PathBuf> {
    let name = claude_binary_name();
    std::env::split_paths(&std::ffi::OsString::from(child_path_var()))
        .map(|d| d.join(name))
        .find(|p| p.is_file())
}

async fn claude_version(bin: &Path) -> Option<String> {
    let mut cmd = crate::util::process::headless_tokio_command(bin);
    cmd.arg("--version")
        .env("PATH", child_path_var())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    crate::util::proc::sanitize_tokio(&mut cmd);
    let out = tokio::time::timeout(std::time::Duration::from_secs(10), cmd.output())
        .await
        .ok()?
        .ok()?;
    if !out.status.success() {
        return None;
    }
    // `claude --version` prints e.g. `2.1.146 (Claude Code)`; keep the number.
    let s = String::from_utf8_lossy(&out.stdout);
    let s = s.split_whitespace().next().unwrap_or("").to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/// `claude auth status` → logged in? `None` when the subcommand is missing
/// or its output is not the expected JSON.
async fn claude_logged_in(bin: &Path) -> Option<bool> {
    let mut cmd = crate::util::process::headless_tokio_command(bin);
    cmd.args(["auth", "status"])
        .env("PATH", child_path_var())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    crate::util::proc::sanitize_tokio(&mut cmd);
    let out = tokio::time::timeout(std::time::Duration::from_secs(10), cmd.output())
        .await
        .ok()?
        .ok()?;
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).ok()?;
    v.get("loggedIn").and_then(|b| b.as_bool())
}

// ---------- Prompt assembly ----------

/// System prompt: the office framing + the agent's persona Markdown.
fn system_prompt(agent: &crate::types::Agent, agency: &str) -> String {
    format!(
        "You are {name}, an AI agent on staff at {agency}. The office manager has handed you a task. \
Work it to completion in this one session and reply with the finished deliverable in Markdown — \
no preamble, no questions back, no summary of what you would do. If something essential is \
missing, state your assumptions at the top and proceed.\n\n\
Standing rule: read freely, never act. You may search and read; you must not send, post, pay, \
delete or change anything outside this machine unless the task explicitly asks for that exact action.\n\n\
Your persona and working style follow.\n\n---\n\n{body}",
        name = agent.name,
        agency = agency,
        body = agent.body.trim(),
    )
}

// ---------- Stream parsing ----------

/// What one `stream-json` line means to the office.
#[derive(Debug, PartialEq)]
enum Line {
    Delta(String),
    Tool(String),
    /// `result` line — `Ok(text)` on success, `Err(message)` otherwise.
    Result {
        outcome: Result<String, String>,
        cost_usd: Option<f64>,
        duration_ms: Option<u64>,
        num_turns: Option<u32>,
    },
    Other,
}

fn parse_line(raw: &str) -> Line {
    let v: serde_json::Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(_) => return Line::Other,
    };
    match v.get("type").and_then(|t| t.as_str()) {
        Some("stream_event") => {
            let ev = &v["event"];
            match ev.get("type").and_then(|t| t.as_str()) {
                Some("content_block_delta") => {
                    if ev["delta"]["type"].as_str() == Some("text_delta") {
                        if let Some(t) = ev["delta"]["text"].as_str() {
                            return Line::Delta(t.to_string());
                        }
                    }
                    Line::Other
                }
                Some("content_block_start") => {
                    if ev["content_block"]["type"].as_str() == Some("tool_use") {
                        if let Some(n) = ev["content_block"]["name"].as_str() {
                            return Line::Tool(n.to_string());
                        }
                    }
                    Line::Other
                }
                _ => Line::Other,
            }
        }
        Some("result") => {
            let cost_usd = v["total_cost_usd"].as_f64();
            let duration_ms = v["duration_ms"].as_u64();
            let num_turns = v["num_turns"].as_u64().map(|n| n as u32);
            let is_error = v["is_error"].as_bool().unwrap_or(false)
                || v["subtype"].as_str().map_or(false, |s| s.starts_with("error"));
            let text = v["result"].as_str().unwrap_or("").to_string();
            let outcome = if is_error {
                let msg = if text.is_empty() {
                    v["subtype"].as_str().unwrap_or("error").to_string()
                } else {
                    text
                };
                Err(msg)
            } else {
                Ok(text)
            };
            Line::Result {
                outcome,
                cost_usd,
                duration_ms,
                num_turns,
            }
        }
        _ => Line::Other,
    }
}

// ---------- Persistence ----------

fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn yaml_quote(s: &str) -> String {
    // One line, always: a brief or prompt may span several.
    let flat = s.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n").replace('\r', "");
    format!("\"{flat}\"")
}

fn status_word(status: TaskStatus) -> &'static str {
    match status {
        TaskStatus::Running => "running",
        TaskStatus::Done => "done",
        TaskStatus::Error => "error",
        TaskStatus::Cancelled => "cancelled",
    }
}

/// Write `rec.output` as a Markdown file with YAML front matter. `parts`
/// are a team task's parts, listed in its front matter; empty otherwise.
fn write_deliverable(dir: &Path, rec: &TaskRecord, parts: &[TaskRecord]) -> Result<PathBuf, AppError> {
    std::fs::create_dir_all(dir).map_err(|e| AppError::Io {
        message: format!("create {}: {e}", dir.display()),
    })?;
    let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S");
    let short: String = rec.id.chars().take(8).collect();
    let path = dir.join(format!("{stamp}-{}-{short}.md", rec.agent_slug));
    let mut doc = String::new();
    doc.push_str("---\n");
    doc.push_str(&format!("task: {}\n", yaml_quote(&rec.id)));
    doc.push_str(&format!("agent: {}\n", yaml_quote(&rec.agent_name)));
    doc.push_str(&format!("slug: {}\n", yaml_quote(&rec.agent_slug)));
    doc.push_str(&format!("department: {}\n", yaml_quote(&rec.department)));
    doc.push_str(&format!("started: {}\n", rec.started_at));
    if let Some(f) = &rec.finished_at {
        doc.push_str(&format!("finished: {f}\n"));
    }
    if !rec.tools_used.is_empty() {
        doc.push_str(&format!(
            "tools: [{}]\n",
            rec.tools_used
                .iter()
                .map(|t| yaml_quote(t))
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    doc.push_str(&format!("prompt: {}\n", yaml_quote(&rec.prompt)));
    match rec.kind {
        TaskKind::Solo => {}
        TaskKind::Team => doc.push_str("kind: team\n"),
        TaskKind::Part => {
            doc.push_str("kind: part\n");
            if let Some(parent) = &rec.parent_id {
                doc.push_str(&format!("team: {}\n", yaml_quote(parent)));
            }
            if let Some(brief) = &rec.brief {
                doc.push_str(&format!("brief: {}\n", yaml_quote(brief)));
            }
        }
    }
    if !parts.is_empty() {
        doc.push_str("parts:\n");
        for part in parts {
            doc.push_str(&format!("  - agent: {}\n", yaml_quote(&part.agent_name)));
            doc.push_str(&format!("    slug: {}\n", yaml_quote(&part.agent_slug)));
            doc.push_str(&format!("    status: {}\n", status_word(part.status)));
            if let Some(brief) = &part.brief {
                doc.push_str(&format!("    brief: {}\n", yaml_quote(brief)));
            }
            let file = part
                .deliverable_path
                .as_deref()
                .and_then(|p| Path::new(p).file_name())
                .map(|n| n.to_string_lossy().into_owned());
            if let Some(file) = file {
                doc.push_str(&format!("    deliverable: {}\n", yaml_quote(&file)));
            }
        }
    }
    doc.push_str("---\n\n");
    doc.push_str(&rec.output);
    doc.push('\n');
    // Write-then-rename so a half-written deliverable never carries the
    // final name (same idea as `util::fs::atomic_write`, which is async).
    let tmp = path.with_extension("md.tmp");
    std::fs::write(&tmp, doc.as_bytes())
        .and_then(|_| std::fs::rename(&tmp, &path))
        .map_err(|e| AppError::Io {
            message: format!("write {}: {e}", path.display()),
        })?;
    Ok(path)
}

/// Serializes appends to `tasks.jsonl`. The parts of a team task can finish
/// in the same instant (Stop cancels them all at once), and two unguarded
/// appends can land on one line.
static HISTORY_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn append_history(dir: &Path, rec: &TaskRecord) -> Result<(), AppError> {
    use std::io::Write;
    let _guard = HISTORY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    std::fs::create_dir_all(dir).map_err(|e| AppError::Io {
        message: format!("create {}: {e}", dir.display()),
    })?;
    let path = dir.join("tasks.jsonl");
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| AppError::Io {
            message: format!("open {}: {e}", path.display()),
        })?;
    let mut line = serde_json::to_string(rec).map_err(|e| AppError::Internal {
        message: format!("serialize task: {e}"),
    })?;
    // Record and newline go out in one write, so a line is never split.
    line.push('\n');
    f.write_all(line.as_bytes()).map_err(|e| AppError::Io {
        message: format!("write {}: {e}", path.display()),
    })
}

fn read_history(dir: &Path, limit: usize) -> Vec<TaskRecord> {
    let path = dir.join("tasks.jsonl");
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    // One record per line, but a line holding several records back to back
    // (written by a build that did not guard appends) still yields them all.
    let mut out: Vec<TaskRecord> = text
        .lines()
        .flat_map(|l| {
            serde_json::Deserializer::from_str(l)
                .into_iter::<TaskRecord>()
                .map_while(Result::ok)
        })
        .collect();
    if out.len() > limit {
        out.drain(..out.len() - limit);
    }
    out
}

// ---------- The run ----------

struct RunOutcome {
    status: TaskStatus,
    output: String,
    error: Option<String>,
    tools_used: Vec<String>,
    cost_usd: Option<f64>,
    duration_ms: Option<u64>,
    num_turns: Option<u32>,
}

async fn run_task(
    app: AppHandle,
    bin: PathBuf,
    workspace: PathBuf,
    task_id: String,
    prompt: String,
    system: String,
    cancel: Arc<StopSignal>,
) -> RunOutcome {
    let mut cmd = crate::util::process::headless_tokio_command(&bin);
    cmd.current_dir(&workspace)
        .arg("-p")
        .arg(&prompt)
        .arg("--output-format")
        .arg("stream-json")
        .arg("--verbose")
        .arg("--include-partial-messages")
        .arg("--append-system-prompt")
        .arg(&system)
        // `--tools` makes the read-only set the only tools that exist for
        // the run; `--allowedTools` pre-approves them so nothing prompts.
        .arg("--tools")
        .arg(ALLOWED_TOOLS)
        .arg("--allowedTools")
        .arg(ALLOWED_TOOLS)
        .arg("--disallowedTools")
        .arg(DISALLOWED_TOOLS)
        .args(ISOLATION_ARGS)
        .arg("--max-turns")
        .arg(MAX_TURNS.to_string())
        .env("PATH", child_path_var())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    crate::util::proc::sanitize_tokio(&mut cmd);

    let fail = |msg: String| RunOutcome {
        status: TaskStatus::Error,
        output: String::new(),
        error: Some(msg),
        tools_used: Vec::new(),
        cost_usd: None,
        duration_ms: None,
        num_turns: None,
    };

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return fail(format!("could not start {}: {e}", bin.display())),
    };
    let Some(stdout) = child.stdout.take() else {
        return fail("no stdout from claude".into());
    };
    let stderr = child.stderr.take();
    // Drain stderr so a chatty CLI can never block on a full pipe; keep the
    // tail for the error message.
    let stderr_tail = tokio::spawn(async move {
        let mut tail = String::new();
        if let Some(e) = stderr {
            let mut lines = BufReader::new(e).lines();
            while let Ok(Some(l)) = lines.next_line().await {
                tail.push_str(&l);
                tail.push('\n');
                if tail.len() > 4000 {
                    let cut = tail.len() - 4000;
                    tail.drain(..cut);
                }
            }
        }
        tail
    });

    let mut lines = BufReader::new(stdout).lines();
    let mut streamed = String::new();
    let mut tools_used: Vec<String> = Vec::new();
    let mut result: Option<Line> = None;
    let mut cancelled = false;

    loop {
        tokio::select! {
            _ = cancel.wait() => {
                cancelled = true;
                let _ = child.kill().await;
                break;
            }
            next = lines.next_line() => {
                match next {
                    Ok(Some(l)) => match parse_line(&l) {
                        Line::Delta(t) => {
                            streamed.push_str(&t);
                            let _ = app.emit(TASK_EVENT, TaskEvent::Delta { task_id: task_id.clone(), text: t });
                        }
                        Line::Tool(name) => {
                            if !tools_used.contains(&name) {
                                tools_used.push(name.clone());
                            }
                            let _ = app.emit(TASK_EVENT, TaskEvent::Tool { task_id: task_id.clone(), tool: name });
                        }
                        r @ Line::Result { .. } => { result = Some(r); }
                        Line::Other => {}
                    },
                    Ok(None) => break,
                    Err(e) => {
                        tracing::warn!(task = %task_id, "office: stdout read error: {e}");
                        break;
                    }
                }
            }
        }
    }

    let status = child.wait().await.ok();
    let err_tail = stderr_tail.await.unwrap_or_default();

    if cancelled {
        return RunOutcome {
            status: TaskStatus::Cancelled,
            output: streamed,
            error: None,
            tools_used,
            cost_usd: None,
            duration_ms: None,
            num_turns: None,
        };
    }

    match result {
        Some(Line::Result {
            outcome: Ok(text),
            cost_usd,
            duration_ms,
            num_turns,
        }) => RunOutcome {
            status: TaskStatus::Done,
            output: if text.trim().is_empty() { streamed } else { text },
            error: None,
            tools_used,
            cost_usd,
            duration_ms,
            num_turns,
        },
        Some(Line::Result {
            outcome: Err(msg),
            cost_usd,
            duration_ms,
            num_turns,
        }) => RunOutcome {
            status: TaskStatus::Error,
            output: streamed,
            error: Some(msg),
            tools_used,
            cost_usd,
            duration_ms,
            num_turns,
        },
        _ => {
            let code = status
                .and_then(|s| s.code())
                .map(|c| c.to_string())
                .unwrap_or_else(|| "signal".into());
            let tail = err_tail.trim();
            RunOutcome {
                status: TaskStatus::Error,
                output: streamed,
                error: Some(if tail.is_empty() {
                    format!("claude exited ({code}) without a result")
                } else {
                    format!("claude exited ({code}): {tail}")
                }),
                tools_used,
                cost_usd: None,
                duration_ms: None,
                num_turns: None,
            }
        }
    }
}

// ---------- IPC ----------

/// Is Claude Code installed, and where will tasks run?
#[tauri::command]
pub async fn office_runner_status(state: State<'_, AppState>) -> Result<RunnerStatus, AppError> {
    let workspace = office_dir(&state).join("workspace");
    let Some(bin) = find_claude() else {
        return Ok(RunnerStatus {
            available: false,
            logged_in: None,
            path: None,
            version: None,
            workspace: workspace.to_string_lossy().into_owned(),
        });
    };
    let (version, logged_in) = tokio::join!(claude_version(&bin), claude_logged_in(&bin));
    Ok(RunnerStatus {
        available: version.is_some(),
        logged_in,
        path: Some(bin.to_string_lossy().into_owned()),
        version,
        workspace: workspace.to_string_lossy().into_owned(),
    })
}

/// Finished tasks, oldest first (last 200).
#[tauri::command]
pub async fn office_tasks_history(state: State<'_, AppState>) -> Result<Vec<TaskRecord>, AppError> {
    let dir = office_dir(&state);
    Ok(tokio::task::spawn_blocking(move || read_history(&dir, 200))
        .await
        .unwrap_or_default())
}

/// What every run needs. Cheap to clone into a spawned task.
#[derive(Clone)]
struct RunCtx {
    app: AppHandle,
    /// The `claude` binary.
    bin: PathBuf,
    /// `<app data>/office`: deliverables and history.
    office: PathBuf,
    /// Where every run starts: `<office>/workspace`.
    workspace: PathBuf,
}

/// Trim a task and refuse the ones that cannot run.
fn clean_prompt(prompt: &str) -> Result<String, AppError> {
    let prompt = prompt.trim();
    if prompt.is_empty() {
        return Err(AppError::InvalidArgument {
            message: "task is empty".into(),
        });
    }
    if prompt.len() > 20_000 {
        return Err(AppError::InvalidArgument {
            message: "task is too long (20,000 characters max)".into(),
        });
    }
    Ok(prompt.to_string())
}

/// Find the runner and make sure the workspace exists.
fn run_ctx(app: &AppHandle, state: &AppState) -> Result<RunCtx, AppError> {
    let Some(bin) = find_claude() else {
        return Err(AppError::Internal {
            message: "Claude Code (`claude`) was not found on this machine".into(),
        });
    };
    let office = office_dir(state);
    let workspace = office.join("workspace");
    std::fs::create_dir_all(&workspace).map_err(|e| AppError::Io {
        message: format!("create {}: {e}", workspace.display()),
    })?;
    Ok(RunCtx {
        app: app.clone(),
        bin,
        office,
        workspace,
    })
}

fn agency_or_default(agency_name: Option<String>) -> String {
    agency_name
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "the agency".to_string())
}

/// Announce `rec` as running: a stop signal in the runtime, `Started` to
/// the window.
async fn register(ctx: &RunCtx, rec: &TaskRecord) -> Arc<StopSignal> {
    let stop = Arc::new(StopSignal::default());
    if let Some(rt) = ctx.app.try_state::<OfficeRuntime>() {
        rt.running.lock().await.insert(rec.id.clone(), stop.clone());
    }
    let _ = ctx.app.emit(TASK_EVENT, TaskEvent::Started { task: rec.clone() });
    stop
}

/// Copy what a run produced into its record.
fn absorb(rec: &mut TaskRecord, outcome: RunOutcome) {
    rec.status = outcome.status;
    rec.output = outcome.output;
    rec.error = outcome.error;
    rec.tools_used = outcome.tools_used;
    rec.cost_usd = outcome.cost_usd;
    rec.duration_ms = outcome.duration_ms;
    rec.num_turns = outcome.num_turns;
}

/// Close a task whose status is settled: stamp it, write its deliverable,
/// append it to history, drop it from the runtime and tell the window.
/// `parts` are a team task's parts (see [`write_deliverable`]).
async fn finish(ctx: &RunCtx, mut rec: TaskRecord, parts: &[TaskRecord]) -> TaskRecord {
    rec.finished_at = Some(now_rfc3339());
    if rec.status == TaskStatus::Done {
        match write_deliverable(&ctx.office.join("deliverables"), &rec, parts) {
            Ok(p) => rec.deliverable_path = Some(p.to_string_lossy().into_owned()),
            Err(e) => tracing::warn!("office: deliverable not written: {e}"),
        }
    }
    if let Err(e) = append_history(&ctx.office, &rec) {
        tracing::warn!("office: history not appended: {e}");
    }
    if let Some(rt) = ctx.app.try_state::<OfficeRuntime>() {
        rt.running.lock().await.remove(&rec.id);
    }
    let _ = ctx.app.emit(TASK_EVENT, TaskEvent::Finished { task: rec.clone() });
    rec
}

/// Run `rec` to its end and record it. `prompt` is what the runner is
/// given, which for a part says more than `rec.prompt` does.
async fn run_and_record(
    ctx: &RunCtx,
    mut rec: TaskRecord,
    prompt: String,
    system: String,
    stop: Arc<StopSignal>,
) -> TaskRecord {
    let outcome = run_task(
        ctx.app.clone(),
        ctx.bin.clone(),
        ctx.workspace.clone(),
        rec.id.clone(),
        prompt,
        system,
        stop,
    )
    .await;
    absorb(&mut rec, outcome);
    finish(ctx, rec, &[]).await
}

/// One question, one text answer, no tools: routing and team planning.
/// Gives the reply and what the call cost; the reply is empty when the
/// call failed or ran out of time.
async fn oneshot(ctx: &RunCtx, ask: &str, model: &str, timeout_secs: u64) -> (String, Option<f64>) {
    let mut cmd = crate::util::process::headless_tokio_command(&ctx.bin);
    cmd.current_dir(&ctx.workspace)
        .arg("-p")
        .arg(ask)
        .arg("--output-format")
        .arg("json")
        .arg("--max-turns")
        .arg("1")
        .arg("--model")
        .arg(model)
        // The answer is a few lines of text: it needs no tools at all.
        .arg("--tools")
        .arg("")
        .arg("--disallowedTools")
        .arg(DISALLOWED_TOOLS)
        .args(ISOLATION_ARGS)
        .env("PATH", child_path_var())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    crate::util::proc::sanitize_tokio(&mut cmd);
    let out = tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), cmd.output()).await;
    let Ok(Ok(out)) = out else {
        return (String::new(), None);
    };
    let Ok(v) = serde_json::from_slice::<serde_json::Value>(&out.stdout) else {
        return (String::new(), None);
    };
    let cost = v["total_cost_usd"].as_f64();
    if v["is_error"].as_bool().unwrap_or(false) {
        return (String::new(), cost);
    }
    (v["result"].as_str().unwrap_or("").to_string(), cost)
}

/// One roster line per known slug, for a prompt that asks the model to
/// choose among agents. Also gives back the slugs that were known.
fn roster_lines(corpus: &crate::corpus::Corpus, slugs: &[String]) -> (String, Vec<String>) {
    let mut roster = String::new();
    let mut valid: Vec<String> = Vec::new();
    for slug in slugs {
        if valid.contains(slug) {
            continue;
        }
        if let Some(a) = corpus.get(slug) {
            let desc: String = a.description.chars().take(140).collect();
            roster.push_str(&format!("{} | {} | {} | {}\n", a.slug, a.name, a.category, desc));
            valid.push(a.slug.clone());
        }
    }
    (roster, valid)
}

/// Hand a task to an agent. Returns at once; progress arrives as
/// `office:task` events.
#[tauri::command]
pub async fn office_task_start(
    app: AppHandle,
    state: State<'_, AppState>,
    agent_slug: String,
    prompt: String,
    agency_name: Option<String>,
) -> Result<TaskRecord, AppError> {
    let prompt = clean_prompt(&prompt)?;
    state.require_network("office_task").await?;
    let ctx = run_ctx(&app, &state)?;

    let corpus = crate::corpus::ensure_corpus(&app, &state).await?;
    let agent = corpus.get(&agent_slug).ok_or_else(|| AppError::InvalidArgument {
        message: format!("unknown agent `{agent_slug}`"),
    })?;
    let system = system_prompt(&agent, &agency_or_default(agency_name));

    let record = TaskRecord::new(&agent, &prompt);
    let stop = register(&ctx, &record).await;
    let rec = record.clone();
    tauri::async_runtime::spawn(async move {
        run_and_record(&ctx, rec, prompt, system, stop).await;
    });

    Ok(record)
}

/// Ask Claude which agent should take `prompt`. `candidates` is the pool
/// (slugs, already narrowed to a department when the user chose one);
/// `fallback` is the caller's own best guess, returned when the model's
/// answer is not one of the candidates or the call fails.
#[tauri::command]
pub async fn office_route(
    app: AppHandle,
    state: State<'_, AppState>,
    prompt: String,
    candidates: Vec<String>,
    fallback: String,
) -> Result<RouteResult, AppError> {
    let prompt = prompt.trim().to_string();
    if prompt.is_empty() || candidates.is_empty() {
        return Err(AppError::InvalidArgument {
            message: "nothing to route".into(),
        });
    }
    state.require_network("office_route").await?;
    let Ok(ctx) = run_ctx(&app, &state) else {
        return Ok(RouteResult {
            agent_slug: fallback,
            via: "fallback".into(),
        });
    };

    let corpus = crate::corpus::ensure_corpus(&app, &state).await?;
    let (roster, valid) = roster_lines(&corpus, &candidates);
    if valid.is_empty() {
        return Ok(RouteResult {
            agent_slug: fallback,
            via: "fallback".into(),
        });
    }

    let ask = format!(
        "You are the office manager at an agency of AI agents. Pick the ONE agent best suited to this task.\n\n\
TASK:\n{prompt}\n\n\
ROSTER (slug | name | department | what they do):\n{roster}\n\
Reply with exactly one line containing only the chosen slug. No other text."
    );
    let (answer, _cost) = oneshot(&ctx, &ask, "haiku", 45).await;
    let picked = pick_slug(&answer, &valid);
    Ok(match picked {
        Some(slug) => RouteResult {
            agent_slug: slug,
            via: "claude".into(),
        },
        None => RouteResult {
            agent_slug: fallback,
            via: "fallback".into(),
        },
    })
}

/// Find a candidate slug in a model reply: an exact line first, then the
/// first candidate mentioned anywhere.
fn pick_slug(answer: &str, valid: &[String]) -> Option<String> {
    for line in answer.lines() {
        let l = line.trim().trim_matches(|c| c == '`' || c == '"' || c == '\'' || c == '*');
        if valid.iter().any(|v| v == l) {
            return Some(l.to_string());
        }
    }
    valid.iter().find(|v| answer.contains(v.as_str())).cloned()
}

/// Stop a running task. A team task takes its parts with it: each part
/// watches its team's signal (see [`team`]). Every record arrives as a
/// `Finished` event with status `cancelled`.
#[tauri::command]
pub async fn office_task_cancel(
    runtime: State<'_, OfficeRuntime>,
    task_id: String,
) -> Result<bool, AppError> {
    let guard = runtime.running.lock().await;
    let Some(stop) = guard.get(&task_id) else {
        return Ok(false);
    };
    stop.stop();
    Ok(true)
}

// ---------- Tests ----------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_delta_lines_become_deltas() {
        let l = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}}"#;
        assert_eq!(parse_line(l), Line::Delta("Hello".into()));
    }

    #[test]
    fn tool_use_block_start_becomes_tool() {
        let l = r#"{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"x","name":"WebSearch","input":{}}}}"#;
        assert_eq!(parse_line(l), Line::Tool("WebSearch".into()));
    }

    #[test]
    fn success_result_carries_text_and_stats() {
        let l = r##"{"type":"result","subtype":"success","is_error":false,"result":"# Done","total_cost_usd":0.0123,"duration_ms":4200,"num_turns":3}"##;
        match parse_line(l) {
            Line::Result {
                outcome,
                cost_usd,
                duration_ms,
                num_turns,
            } => {
                assert_eq!(outcome, Ok("# Done".into()));
                assert_eq!(cost_usd, Some(0.0123));
                assert_eq!(duration_ms, Some(4200));
                assert_eq!(num_turns, Some(3));
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn error_result_is_an_error() {
        let l = r#"{"type":"result","subtype":"error_max_turns","is_error":true,"result":"","num_turns":15}"#;
        match parse_line(l) {
            Line::Result { outcome, .. } => assert_eq!(outcome, Err("error_max_turns".into())),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn junk_and_other_types_are_ignored() {
        assert_eq!(parse_line("not json"), Line::Other);
        assert_eq!(parse_line(r#"{"type":"system","subtype":"init"}"#), Line::Other);
        assert_eq!(
            parse_line(r#"{"type":"assistant","message":{"content":[{"type":"text","text":"x"}]}}"#),
            Line::Other
        );
    }

    #[test]
    fn pick_slug_prefers_an_exact_line_then_any_mention() {
        let valid = vec!["a-one".to_string(), "b-two".to_string()];
        assert_eq!(pick_slug("`b-two`\n", &valid), Some("b-two".into()));
        assert_eq!(pick_slug("I'd go with a-one for this.", &valid), Some("a-one".into()));
        assert_eq!(pick_slug("nobody", &valid), None);
    }

    #[test]
    fn deliverable_round_trips_through_history() {
        let dir = std::env::temp_dir().join(format!("oz-office-test-{}", uuid::Uuid::new_v4()));
        let rec = TaskRecord {
            id: "abcdef12-0000".into(),
            agent_slug: "engineering-frontend-developer".into(),
            agent_name: "Frontend \"Dev\"".into(),
            department: "engineering".into(),
            prompt: "Write a plan".into(),
            status: TaskStatus::Done,
            started_at: now_rfc3339(),
            finished_at: Some(now_rfc3339()),
            output: "# Plan\n\n- one".into(),
            tools_used: vec!["WebSearch".into()],
            deliverable_path: None,
            cost_usd: Some(0.01),
            duration_ms: Some(10),
            num_turns: Some(1),
            error: None,
            kind: TaskKind::Solo,
            parent_id: None,
            phase: None,
            members: Vec::new(),
            brief: None,
        };
        let p = write_deliverable(&dir.join("deliverables"), &rec, &[]).unwrap();
        let text = std::fs::read_to_string(&p).unwrap();
        assert!(text.starts_with("---\n"));
        assert!(text.contains(r#"agent: "Frontend \"Dev\"""#));
        assert!(text.ends_with("# Plan\n\n- one\n"));

        append_history(&dir, &rec).unwrap();
        append_history(&dir, &rec).unwrap();
        let hist = read_history(&dir, 1);
        assert_eq!(hist.len(), 1);
        assert_eq!(hist[0].agent_slug, rec.agent_slug);
        assert_eq!(hist[0].status, TaskStatus::Done);

        let _ = std::fs::remove_dir_all(&dir);
    }

    const OLD_LINE: &str = r#"{"id":"t1","agentSlug":"x","agentName":"Tester","department":"testing","prompt":"p","status":"done","startedAt":"2026-01-01T00:00:00Z","output":"ok","toolsUsed":[]}"#;

    #[test]
    fn history_keeps_one_record_per_line_under_simultaneous_appends() {
        let dir = std::env::temp_dir().join(format!("oz-office-test-{}", uuid::Uuid::new_v4()));
        let mut rec: TaskRecord = serde_json::from_str(OLD_LINE).unwrap();
        // Long enough that an unguarded append would be split across writes.
        rec.output = "line of output\n".repeat(400);
        let writers: Vec<_> = (0..8)
            .map(|_| {
                let (dir, rec) = (dir.clone(), rec.clone());
                std::thread::spawn(move || {
                    for _ in 0..20 {
                        append_history(&dir, &rec).unwrap();
                    }
                })
            })
            .collect();
        for w in writers {
            w.join().unwrap();
        }
        let text = std::fs::read_to_string(dir.join("tasks.jsonl")).unwrap();
        assert_eq!(text.lines().count(), 160);
        assert!(text
            .lines()
            .all(|l| serde_json::from_str::<TaskRecord>(l).is_ok()));
        assert_eq!(read_history(&dir, 500).len(), 160);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn history_reads_records_joined_on_one_line() {
        let dir = std::env::temp_dir().join(format!("oz-office-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        // Two records back to back, a blank line, a broken line, then a good one.
        let text = format!("{OLD_LINE}{OLD_LINE}\n\n{{\"id\":\n{OLD_LINE}\n");
        std::fs::write(dir.join("tasks.jsonl"), text).unwrap();
        assert_eq!(read_history(&dir, 10).len(), 3);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn history_lines_from_before_team_tasks_still_load() {
        let line = OLD_LINE;
        let rec: TaskRecord = serde_json::from_str(line).unwrap();
        assert_eq!(rec.kind, TaskKind::Solo);
        assert!(rec.parent_id.is_none() && rec.phase.is_none() && rec.brief.is_none());
        assert!(rec.members.is_empty());
        // A solo record still writes none of the team fields but its kind.
        let json = serde_json::to_string(&rec).unwrap();
        assert!(json.contains(r#""kind":"solo""#));
        assert!(!json.contains("parentId") && !json.contains("members") && !json.contains("phase"));
    }

    #[test]
    fn team_records_round_trip_and_events_name_their_phase() {
        let agent = test_agent("lead", "Lee");
        let mut team = TaskRecord::new(&agent, "Launch plan");
        team.kind = TaskKind::Team;
        team.phase = Some(TeamPhase::Merging);
        team.members = vec!["a".into(), "b".into()];
        let json = serde_json::to_string(&team).unwrap();
        assert!(json.contains(r#""kind":"team""#));
        assert!(json.contains(r#""phase":"merging""#));
        assert!(json.contains(r#""members":["a","b"]"#));
        let back: TaskRecord = serde_json::from_str(&json).unwrap();
        assert_eq!(back.kind, TaskKind::Team);
        assert_eq!(back.phase, Some(TeamPhase::Merging));

        let ev = serde_json::to_value(TaskEvent::Phase {
            task_id: team.id.clone(),
            phase: TeamPhase::Working,
            members: team.members.clone(),
        })
        .unwrap();
        assert_eq!(ev["kind"], "phase");
        assert_eq!(ev["taskId"], team.id.as_str());
        assert_eq!(ev["phase"], "working");
        assert_eq!(ev["members"][1], "b");
    }

    #[test]
    fn team_deliverable_lists_its_parts() {
        let dir = std::env::temp_dir().join(format!("oz-office-test-{}", uuid::Uuid::new_v4()));
        let out = dir.join("deliverables");

        let mut team = TaskRecord::new(&test_agent("lead", "Lee"), "Launch\nplan, in two lines");
        team.kind = TaskKind::Team;
        team.status = TaskStatus::Done;
        team.output = "# Merged".into();

        let mut done = TaskRecord::new(&test_agent("a", "Ada"), &team.prompt);
        done.kind = TaskKind::Part;
        done.parent_id = Some(team.id.clone());
        done.brief = Some("Price the options.\nThen rank them.".into());
        done.status = TaskStatus::Done;
        done.output = "# Prices".into();
        let part_path = write_deliverable(&out, &done, &[]).unwrap();
        done.deliverable_path = Some(part_path.to_string_lossy().into_owned());
        let part_text = std::fs::read_to_string(&part_path).unwrap();
        assert!(part_text.contains("kind: part\n"));
        assert!(part_text.contains(&format!("team: \"{}\"\n", team.id)));
        assert!(part_text.contains("brief: \"Price the options.\\nThen rank them.\"\n"));

        let mut failed = TaskRecord::new(&test_agent("b", "Bo"), &team.prompt);
        failed.kind = TaskKind::Part;
        failed.brief = Some("Check the law.".into());
        failed.status = TaskStatus::Error;

        let path = write_deliverable(&out, &team, &[done.clone(), failed]).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        // Front matter stays one key per line whatever the prompt holds.
        assert!(text.contains("prompt: \"Launch\\nplan, in two lines\"\n"));
        assert!(text.contains("kind: team\nparts:\n"));
        assert!(text.contains("  - agent: \"Ada\"\n    slug: \"a\"\n    status: done\n"));
        let file = part_path.file_name().unwrap().to_string_lossy();
        assert!(text.contains(&format!("    deliverable: \"{file}\"\n")));
        assert!(text.contains("  - agent: \"Bo\"\n    slug: \"b\"\n    status: error\n    brief: \"Check the law.\"\n---\n\n# Merged\n"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    fn test_agent(slug: &str, name: &str) -> crate::types::Agent {
        crate::types::Agent {
            slug: slug.into(),
            name: name.into(),
            description: String::new(),
            category: "testing".into(),
            emoji: None,
            color: None,
            vibe: None,
            body: String::new(),
        }
    }

    #[test]
    fn system_prompt_names_the_agency_and_keeps_the_persona() {
        let agent = crate::types::Agent {
            slug: "x".into(),
            name: "Tester".into(),
            description: String::new(),
            category: "testing".into(),
            emoji: None,
            color: None,
            vibe: None,
            body: "# Persona\n\nBe thorough.".into(),
        };
        let s = system_prompt(&agent, "Oz Agency");
        assert!(s.starts_with("You are Tester, an AI agent on staff at Oz Agency."));
        assert!(s.ends_with("# Persona\n\nBe thorough."));
        assert!(s.contains("read freely, never act"));
    }
}
