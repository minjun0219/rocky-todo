//! 보드에서 백그라운드 Claude Code 세션 띄우기 — TS 원본 `src/spawn.ts`.
//!
//! 워크트리 생성·재사용·정리는 전부 Claude Code 의 `--worktree` 몫 — 데몬은 git 을
//! 만지지 않는다. 이름 `todo-<번호>` 가 "이 todo 의 워크트리" 라는 기억을 대신한다.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use rocky_todo_core::sessions::AgentSession;

/// Claude Code 가 워크트리를 만드는 자리.
const WORKTREE_DIR: &str = ".claude/worktrees";

/// `claude --bg` 는 즉시 반환하지만 대형 레포의 `git worktree add` 가 그 안에 있다.
pub const SPAWN_TIMEOUT: Duration = Duration::from_secs(30);

/// 방금 띄운 워크트리를 기억하는 기간 — `agents --json` 등록 지연을 덮는다.
pub const RECENT_SPAWN_TTL: Duration = Duration::from_secs(60);

/// 직접 자식이 끝난 뒤 파이프 잔여 출력을 긁는 유예 — 이 유예가 지나도 닫히지 않는
/// 파이프는 자손(detach 된 세션)이 물고 있는 것이다.
const EXIT_DRAIN_GRACE: Duration = Duration::from_millis(250);

#[derive(Debug, Clone)]
pub struct SpawnRunResult {
    pub ok: bool,
    pub stdout: String,
    pub stderr: String,
    /// 마감 안에 자식의 종료 코드를 보지 못했는가 — "실패"와 "모른다"를 가른다.
    pub timed_out: bool,
}

/// todo 번호 → 워크트리 이름. 결정론적.
pub fn worktree_name_for(todo_number: i64) -> String {
    format!("todo-{todo_number}")
}

/// 워크트리 절대경로 — Claude Code 규약(`<repo>/.claude/worktrees/<name>`).
pub fn worktree_path_for(board_path: &str, todo_number: i64) -> String {
    let base = board_path.trim_end_matches('/');
    format!("{base}/{WORKTREE_DIR}/{}", worktree_name_for(todo_number))
}

/// `--bg` stdout 첫 줄(`backgrounded · 5acaaaeb · <name>`)에서 짧은 id 를 꺼낸다.
pub fn parse_background_id(stdout: &str) -> Option<String> {
    // `^backgrounded\s+·\s+(\S+)\s+·` (멀티라인) 을 손으로 옮겼다.
    for line in stdout.lines() {
        let Some(rest) = line.strip_prefix("backgrounded") else {
            continue;
        };
        let rest = rest.trim_start();
        let Some(rest) = rest.strip_prefix('·') else {
            continue;
        };
        let rest = rest.trim_start();
        let id: String = rest.chars().take_while(|c| !c.is_whitespace()).collect();
        if id.is_empty() {
            continue;
        }
        let after = rest[id.len()..].trim_start();
        if after.starts_with('·') {
            return Some(id);
        }
    }
    None
}

/// 그 워크트리에서 아직 돌고 있는 세션 — 있으면 새로 띄우면 안 된다(동시 실행 가드).
/// `state` 없음(= interactive)은 살아있는 것으로 본다.
pub fn find_live_session_at<'a>(
    sessions: &'a [AgentSession],
    worktree_path: &str,
) -> Option<&'a AgentSession> {
    sessions
        .iter()
        .find(|s| s.cwd == worktree_path && s.state.as_deref() != Some("done"))
}

pub struct SpawnCommandInput<'a> {
    pub worktree_name: &'a str,
    pub session_name: &'a str,
    pub prompt: &'a str,
}

/// 명령줄 조립 — `--permission-mode` 를 넣지 않는 것이 의도다(사용자 기본 설정 존중).
pub fn build_spawn_command(input: &SpawnCommandInput) -> Vec<String> {
    vec![
        "claude".into(),
        "--bg".into(),
        "--worktree".into(),
        input.worktree_name.into(),
        "-n".into(),
        input.session_name.into(),
        input.prompt.into(),
    ]
}

/// spawn 실패 — **세션이 떴는지 아는가**(`started`)를 함께 나른다.
/// false = 확실히 안 떴다 / true = 떴다 / None = 모른다(마감 초과·형식 불일치).
#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct SpawnFailedError {
    pub message: String,
    pub started: Option<bool>,
}

fn failure_message(started: Option<bool>, detail: &str) -> String {
    match started {
        Some(false) => format!("세션을 띄우지 못했다 — {detail}"),
        Some(true) => format!(
            "세션은 뜬 것으로 보이는데 claude --bg 가 실패로 끝났다 — claude agents 로 확인하라: {detail}"
        ),
        None => format!("세션이 떴는지 확인할 수 없다 — claude agents 로 확인하라: {detail}"),
    }
}

/// cwd 지정 실행 — **timeout 안에 반드시** 결과를 돌려준다. 파이프는 직접 자식 종료 +
/// 짧은 유예, 또는 마감에서 끊는다(`new Response(stream).text()` 류의 "모든 fd 닫힘
/// 대기"를 하지 않는다 — detach 손자가 물면 영원히 매달린다).
pub async fn run_in_dir(cmd: &[String], cwd: &str, timeout: Duration) -> SpawnRunResult {
    use tokio::io::AsyncReadExt;

    let Some((program, args)) = cmd.split_first() else {
        return SpawnRunResult {
            ok: false,
            stdout: String::new(),
            stderr: "empty command".into(),
            timed_out: false,
        };
    };
    let mut command = tokio::process::Command::new(program);
    command
        .args(args)
        .current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return SpawnRunResult {
                ok: false,
                stdout: String::new(),
                stderr: error.to_string(),
                timed_out: false,
            }
        }
    };

    let mut stdout_pipe = child.stdout.take();
    let mut stderr_pipe = child.stderr.take();
    let mut stdout_buf: Vec<u8> = Vec::new();
    let mut stderr_buf: Vec<u8> = Vec::new();
    let deadline = tokio::time::sleep(timeout);
    tokio::pin!(deadline);

    // 종료 코드 관찰까지의 루프 — 읽기와 종료·마감을 한 select 로 돌린다.
    let mut exit_code: Option<i32> = None;
    let mut timed_out = false;
    let mut out_open = stdout_pipe.is_some();
    let mut err_open = stderr_pipe.is_some();
    let mut out_chunk = [0u8; 4096];
    let mut err_chunk = [0u8; 4096];
    loop {
        tokio::select! {
            status = child.wait(), if exit_code.is_none() => {
                exit_code = Some(status.ok().and_then(|s| s.code()).unwrap_or(1));
                // 직접 자식이 끝났다 — 잔여 출력을 짧게만 더 긁는다.
                let drain = tokio::time::sleep(EXIT_DRAIN_GRACE);
                tokio::pin!(drain);
                loop {
                    tokio::select! {
                        _ = &mut drain => break,
                        read = async { stdout_pipe.as_mut().unwrap().read(&mut out_chunk).await }, if out_open => {
                            match read { Ok(0) | Err(_) => out_open = false, Ok(n) => stdout_buf.extend_from_slice(&out_chunk[..n]) }
                        }
                        read = async { stderr_pipe.as_mut().unwrap().read(&mut err_chunk).await }, if err_open => {
                            match read { Ok(0) | Err(_) => err_open = false, Ok(n) => stderr_buf.extend_from_slice(&err_chunk[..n]) }
                        }
                        else => break,
                    }
                }
                break;
            }
            _ = &mut deadline => {
                timed_out = true;
                let _ = child.start_kill();
                break;
            }
            read = async { stdout_pipe.as_mut().unwrap().read(&mut out_chunk).await }, if out_open => {
                match read { Ok(0) | Err(_) => out_open = false, Ok(n) => stdout_buf.extend_from_slice(&out_chunk[..n]) }
            }
            read = async { stderr_pipe.as_mut().unwrap().read(&mut err_chunk).await }, if err_open => {
                match read { Ok(0) | Err(_) => err_open = false, Ok(n) => stderr_buf.extend_from_slice(&err_chunk[..n]) }
            }
        }
    }

    let stdout = String::from_utf8_lossy(&stdout_buf).to_string();
    let stderr = String::from_utf8_lossy(&stderr_buf).to_string();
    if timed_out {
        let reason = format!("{}ms 안에 끝나지 않았다", timeout.as_millis());
        let trimmed = stderr.trim();
        return SpawnRunResult {
            ok: false,
            stdout,
            stderr: if trimmed.is_empty() {
                reason
            } else {
                format!("{trimmed}\n{reason}")
            },
            timed_out: true,
        };
    }
    SpawnRunResult {
        ok: exit_code == Some(0),
        stdout,
        stderr,
        timed_out: false,
    }
}

/// spawn 실행기 — 서버 옵션 주입용.
pub type SpawnFn = std::sync::Arc<
    dyn Fn(SpawnInput) -> crate::runner::BoxFut<Result<String, SpawnFailedError>> + Send + Sync,
>;

#[derive(Debug, Clone)]
pub struct SpawnInput {
    pub board_path: String,
    pub worktree_name: String,
    pub session_name: String,
    pub prompt: String,
}

/// 백그라운드 세션을 띄우고 짧은 id 를 돌려준다 — id 를 못 읽으면 성공으로 볼 수 없다.
pub async fn spawn_background_session(input: SpawnInput) -> Result<String, SpawnFailedError> {
    let cmd = build_spawn_command(&SpawnCommandInput {
        worktree_name: &input.worktree_name,
        session_name: &input.session_name,
        prompt: &input.prompt,
    });
    let result = run_in_dir(&cmd, &input.board_path, SPAWN_TIMEOUT).await;
    let id = parse_background_id(&result.stdout);
    if !result.ok {
        let raw = if result.stderr.is_empty() {
            result.stdout.clone()
        } else {
            result.stderr.clone()
        };
        let detail = raw.trim();
        let detail = if detail.is_empty() {
            "claude --bg 실행에 실패했다"
        } else {
            detail
        };
        // id 가 찍혔으면 실패 코드와 무관하게 세션은 떴다. 마감 초과면 판단 근거가 없다.
        let started = if id.is_some() {
            Some(true)
        } else if !result.timed_out {
            Some(false)
        } else {
            None
        };
        return Err(SpawnFailedError {
            message: failure_message(started, detail),
            started,
        });
    }
    match id {
        Some(id) => Ok(id),
        // 명령은 0 으로 끝났다 — 세션은 떴는데 출력 형식이 바뀐 쪽이 그럴듯하다. 모른다.
        None => Err(SpawnFailedError {
            message: failure_message(None, &format!("claude --bg 출력: {}", result.stdout.trim())),
            started: None,
        }),
    }
}

pub fn default_spawn_fn() -> SpawnFn {
    std::sync::Arc::new(|input| Box::pin(async move { spawn_background_session(input).await }))
}

/// "방금 띄운 워크트리" 예약 창 — 실행 **전에** remember, 실패 시에만 forget.
/// 상태는 데몬 수명 클로저(재기동하면 비워진다).
pub struct RecentSpawns {
    spawned_at: Mutex<HashMap<String, Instant>>,
    ttl: Duration,
}

impl RecentSpawns {
    pub fn new(ttl: Duration) -> Self {
        RecentSpawns {
            spawned_at: Mutex::new(HashMap::new()),
            ttl,
        }
    }

    pub fn is_recent(&self, worktree_path: &str) -> bool {
        let mut map = self.spawned_at.lock().expect("recent spawns poisoned");
        match map.get(worktree_path) {
            None => false,
            Some(at) if at.elapsed() >= self.ttl => {
                map.remove(worktree_path); // 만료된 항목은 조회하는 김에 버린다
                false
            }
            Some(_) => true,
        }
    }

    pub fn remember(&self, worktree_path: &str) {
        self.spawned_at
            .lock()
            .expect("recent spawns poisoned")
            .insert(worktree_path.to_string(), Instant::now());
    }

    pub fn forget(&self, worktree_path: &str) {
        self.spawned_at
            .lock()
            .expect("recent spawns poisoned")
            .remove(worktree_path);
    }
}
