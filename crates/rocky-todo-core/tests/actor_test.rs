//! TS 원본 `src/actor.test.ts` 포팅.

use rocky_todo_core::actor::{board_key_from, detect_actor, BoardKeySources};

fn env(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
    pairs
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

#[test]
fn explicit_env_override_wins() {
    assert_eq!(
        detect_actor(&env(&[("ROCKY_TODO_ACTOR", "rocky"), ("CLAUDECODE", "1")])),
        "rocky"
    );
}

#[test]
fn host_markers_detected_in_order() {
    assert_eq!(detect_actor(&env(&[("CLAUDECODE", "1")])), "claude-code");
    assert_eq!(detect_actor(&env(&[("OPENCODE", "1")])), "opencode");
    assert_eq!(
        detect_actor(&env(&[("CODEX_SANDBOX", "seatbelt")])),
        "codex"
    );
}

#[test]
fn falls_back_to_agent() {
    assert_eq!(detect_actor(&[]), "agent");
}

#[test]
fn prefers_git_remote_basename() {
    assert_eq!(
        board_key_from(&BoardKeySources {
            remote_url: Some("git@github.com:minjun0219/rocky.git"),
            toplevel: Some("/Users/x/worktrees/todo"),
            cwd: Some("/Users/x/worktrees/todo/src"),
        }),
        "rocky"
    );
    assert_eq!(
        board_key_from(&BoardKeySources {
            remote_url: Some("https://github.com/minjun0219/my-app.git"),
            toplevel: None,
            cwd: None,
        }),
        "my-app"
    );
}

#[test]
fn falls_back_to_toplevel_then_cwd() {
    assert_eq!(
        board_key_from(&BoardKeySources {
            remote_url: None,
            toplevel: Some("/Users/x/dev/proj"),
            cwd: Some("/Users/x/dev/proj/deep"),
        }),
        "proj"
    );
    assert_eq!(
        board_key_from(&BoardKeySources {
            remote_url: None,
            toplevel: None,
            cwd: Some("/Users/x/scratch dir"),
        }),
        "scratch-dir"
    );
}

#[test]
fn sanitizes_and_never_returns_empty() {
    assert_eq!(
        board_key_from(&BoardKeySources {
            remote_url: None,
            toplevel: None,
            cwd: Some("/")
        }),
        "board"
    );
    assert_eq!(
        board_key_from(&BoardKeySources {
            remote_url: Some("git@github.com:a/한글레포.git"),
            toplevel: None,
            cwd: None,
        }),
        "board"
    );
}
