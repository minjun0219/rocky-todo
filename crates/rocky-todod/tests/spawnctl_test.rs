//! TS `src/spawn.test.ts` 포팅 — 순수 부분 + run_in_dir 실전 + RecentSpawns.

use std::time::Duration;

use rocky_todo_core::sessions::AgentSession;
use rocky_todod::spawnctl::*;

fn session(cwd: &str, kind: &str, state: Option<&str>) -> AgentSession {
    AgentSession {
        pid: 1,
        cwd: cwd.into(),
        kind: kind.into(),
        id: None,
        session_id: "s".into(),
        name: "n".into(),
        status: "idle".into(),
        state: state.map(str::to_string),
        started_at: 0,
    }
}

#[test]
fn worktree_name_is_deterministic() {
    assert_eq!(worktree_name_for(12), "todo-12");
}

#[test]
fn worktree_path_follows_claude_code_convention() {
    assert_eq!(
        worktree_path_for("/repo", 12),
        "/repo/.claude/worktrees/todo-12"
    );
}

#[test]
fn worktree_path_absorbs_trailing_slash() {
    assert_eq!(
        worktree_path_for("/repo/", 12),
        "/repo/.claude/worktrees/todo-12"
    );
    assert_eq!(
        worktree_path_for("/repo//", 12),
        "/repo/.claude/worktrees/todo-12"
    );
}

#[test]
fn parse_background_id_reads_short_id() {
    assert_eq!(
        parse_background_id("backgrounded · 5acaaaeb · rocky-todo-16\n").as_deref(),
        Some("5acaaaeb")
    );
}

#[test]
fn parse_background_id_finds_line_after_warnings() {
    let stdout = "warning: something\nbackgrounded · abc12345 · name\n";
    assert_eq!(parse_background_id(stdout).as_deref(), Some("abc12345"));
}

#[test]
fn parse_background_id_unknown_format_is_none() {
    assert_eq!(parse_background_id("started abc12345"), None);
    assert_eq!(parse_background_id(""), None);
    assert_eq!(parse_background_id("backgrounded 5acaaaeb name"), None);
}

#[test]
fn finds_live_background_session_at_worktree() {
    let sessions = vec![session("/w/todo-1", "background", Some("working"))];
    assert!(find_live_session_at(&sessions, "/w/todo-1").is_some());
}

#[test]
fn done_sessions_are_ignored() {
    let sessions = vec![session("/w/todo-1", "background", Some("done"))];
    assert!(find_live_session_at(&sessions, "/w/todo-1").is_none());
}

#[test]
fn stateless_interactive_session_counts_as_live() {
    let sessions = vec![session("/w/todo-1", "interactive", None)];
    assert!(find_live_session_at(&sessions, "/w/todo-1").is_some());
}

#[test]
fn other_paths_do_not_match() {
    let sessions = vec![session("/w/other", "background", Some("working"))];
    assert!(find_live_session_at(&sessions, "/w/todo-1").is_none());
}

#[test]
fn build_spawn_command_shape() {
    let cmd = build_spawn_command(&SpawnCommandInput {
        worktree_name: "todo-12",
        session_name: "rocky-todo-12",
        prompt: "프롬프트",
    });
    assert_eq!(
        cmd,
        vec![
            "claude",
            "--bg",
            "--worktree",
            "todo-12",
            "-n",
            "rocky-todo-12",
            "프롬프트"
        ]
    );
    // --permission-mode 를 넣지 않는다 — 사용자 기본 설정을 따른다.
    assert!(!cmd.iter().any(|a| a.contains("permission")));
}

// ── run_in_dir (기본 실행기 — 실제 프로세스) ──

#[tokio::test]
async fn descendant_holding_stdout_does_not_hang() {
    // 자손이 stdout 파이프를 물고 있어도 마감 안에 결과를 준다 — detach 손자 재현.
    let cmd: Vec<String> = vec![
        "sh".into(),
        "-c".into(),
        "echo backgrounded; sleep 30 & exit 0".into(),
    ];
    let started = std::time::Instant::now();
    let result = run_in_dir(&cmd, "/tmp", Duration::from_secs(5)).await;
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "매달리면 안 된다"
    );
    assert!(result.ok);
    assert!(result.stdout.contains("backgrounded"));
}

#[tokio::test]
async fn plain_command_returns_full_stdout() {
    let cmd: Vec<String> = vec!["sh".into(), "-c".into(), "printf 'hello\\nworld\\n'".into()];
    let result = run_in_dir(&cmd, "/tmp", Duration::from_secs(5)).await;
    assert!(result.ok);
    assert_eq!(result.stdout, "hello\nworld\n");
}

#[tokio::test]
async fn nonzero_exit_carries_stderr() {
    let cmd: Vec<String> = vec!["sh".into(), "-c".into(), "echo boom >&2; exit 3".into()];
    let result = run_in_dir(&cmd, "/tmp", Duration::from_secs(5)).await;
    assert!(!result.ok);
    assert!(!result.timed_out);
    assert!(result.stderr.contains("boom"));
}

#[tokio::test]
async fn deadline_overrun_is_marked_timed_out() {
    let cmd: Vec<String> = vec!["sh".into(), "-c".into(), "sleep 10".into()];
    let result = run_in_dir(&cmd, "/tmp", Duration::from_millis(200)).await;
    assert!(!result.ok);
    assert!(result.timed_out);
    assert!(result.stderr.contains("끝나지 않았다"));
}

#[tokio::test]
async fn output_before_deadline_survives_timeout() {
    let cmd: Vec<String> = vec![
        "sh".into(),
        "-c".into(),
        "echo early-output; sleep 10".into(),
    ];
    let result = run_in_dir(&cmd, "/tmp", Duration::from_millis(300)).await;
    assert!(!result.ok);
    assert!(result.timed_out);
    assert!(result.stdout.contains("early-output"));
}

#[tokio::test]
async fn unrunnable_command_returns_ok_false() {
    let cmd: Vec<String> = vec!["definitely-no-such-binary-xyz".into()];
    let result = run_in_dir(&cmd, "/tmp", Duration::from_secs(1)).await;
    assert!(!result.ok);
    assert!(!result.stderr.is_empty());
}

// ── spawn_background_session (fake 러너 경유는 서버 테스트가 다룬다 — 여기선 실패 분류만) ──

// ── RecentSpawns ──

#[test]
fn unremembered_worktree_is_not_recent() {
    let spawns = RecentSpawns::new(Duration::from_secs(60));
    assert!(!spawns.is_recent("/w/todo-1"));
}

#[test]
fn remembered_worktree_is_recent_within_ttl() {
    let spawns = RecentSpawns::new(Duration::from_secs(60));
    spawns.remember("/w/todo-1");
    assert!(spawns.is_recent("/w/todo-1"));
}

#[test]
fn recent_expires_after_ttl() {
    let spawns = RecentSpawns::new(Duration::from_millis(30));
    spawns.remember("/w/todo-1");
    std::thread::sleep(Duration::from_millis(50));
    assert!(!spawns.is_recent("/w/todo-1"));
}

#[test]
fn different_worktrees_are_independent() {
    let spawns = RecentSpawns::new(Duration::from_secs(60));
    spawns.remember("/w/todo-1");
    assert!(!spawns.is_recent("/w/todo-2"));
}

#[test]
fn forget_reverts_reservation() {
    let spawns = RecentSpawns::new(Duration::from_secs(60));
    spawns.remember("/w/todo-1");
    spawns.forget("/w/todo-1");
    assert!(!spawns.is_recent("/w/todo-1"));
}

#[test]
fn forgetting_unknown_is_fine() {
    let spawns = RecentSpawns::new(Duration::from_secs(60));
    spawns.forget("/w/todo-1");
}

#[test]
fn default_ttl_is_60s() {
    assert_eq!(RECENT_SPAWN_TTL, Duration::from_secs(60));
}
