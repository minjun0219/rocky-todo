//! 실행 컨텍스트 조립 — 설정 해석, actor 감지, cwd 로부터 board key 유추.

use std::process::Command;

use rocky_todo_core::actor::{board_key_from, detect_actor, BoardKeySources};
use rocky_todo_core::config::{
    env_snapshot, load_todo_config, resolve_runtime_config, user_config_path, TodoConfig,
    TodoRuntimeConfig,
};

use crate::client::{build_context, CliContext};

/// git 명령을 돌려 stdout 을 trim 해 돌려준다. 실패하거나 비면 `None`.
pub fn git(args: &[&str]) -> Option<String> {
    let output = Command::new("git").args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

/// git remote > toplevel > cwd 순으로 board key 를 유추한다.
pub fn infer_board_key() -> String {
    let remote = git(&["remote", "get-url", "origin"]);
    let toplevel = git(&["rev-parse", "--show-toplevel"]);
    let cwd = std::env::current_dir()
        .ok()
        .map(|p| p.to_string_lossy().to_string());
    board_key_from(&BoardKeySources {
        remote_url: remote.as_deref(),
        toplevel: toplevel.as_deref(),
        cwd: cwd.as_deref(),
    })
}

/// 설정을 읽어 컨텍스트와 런타임 설정을 만든다.
///
/// `actor_override` 는 `--actor` 플래그 — 없으면 env/호스트에서 감지한다.
pub fn build_cli_context(
    actor_override: Option<&str>,
) -> (CliContext, TodoRuntimeConfig, TodoConfig) {
    let todo = load_todo_config(&user_config_path());
    let env = env_snapshot();
    let runtime = resolve_runtime_config(&env, &todo);
    let actor = actor_override
        .map(str::to_string)
        .unwrap_or_else(|| detect_actor(&env_pairs()));
    let ctx = build_context(runtime.port, runtime.dir.clone(), actor);
    (ctx, runtime, todo)
}

/// `detect_actor` 가 받는 형태로 환경변수를 펼친다.
fn env_pairs() -> Vec<(String, String)> {
    std::env::vars().collect()
}
