//! Claude Code 훅 엔트리 — `rocky-todo hook <이름>`.
//! TS 원본 `hooks/ensure-daemon.ts` / `hooks/notify-todo.ts` / `hooks/handoff-stop.ts`.
//!
//! 세 훅 모두 **fail-open** 이다: 데몬이 죽어 있거나 어떤 에러든 조용히 exit 0 —
//! 훅 실패가 세션 시작·프롬프트 처리·턴 종료를 막지 않는다. 그래서 이 모듈의 함수는
//! `Result` 를 내지 않는다.

use std::io::Read;
use std::time::Duration;

use rocky_todo_core::handoff::build_handoff_prompt;
use rocky_todo_core::notify::{
    build_notify_context, filter_human_changes, merge_context, read_cursor, write_cursor,
};
use rocky_todo_core::types::{ChangesSince, ClaimedHandoff};
use serde_json::json;

use crate::client::{daemon_health, ensure_daemon, stop_daemon, CliContext};
use crate::launchd::{install_launchd, is_launchd_registered};

/// 훅의 HTTP 는 짧게 끊는다 — 프롬프트 지연이 곧 사용자 체감이다.
const HOOK_TIMEOUT: Duration = Duration::from_millis(1500);

fn read_stdin_json() -> serde_json::Value {
    let mut raw = String::new();
    let _ = std::io::stdin().read_to_string(&mut raw);
    serde_json::from_str(&raw).unwrap_or(serde_json::Value::Null)
}

fn hook_agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(HOOK_TIMEOUT))
        .build()
        .into()
}

/// 이 세션 앞의 핸드오프 한 건을 집어온다. 없거나 실패하면 `None` (fail-open).
fn claim_handoff(base_url: &str, session_id: &str, via: &str) -> Option<ClaimedHandoff> {
    let mut response = hook_agent()
        .post(format!("{base_url}/api/handoffs/claim"))
        .header("content-type", "application/json")
        .send_json(json!({ "sessionId": session_id, "via": via }))
        .ok()?;
    if response.status().as_u16() != 200 {
        return None;
    }
    response.body_mut().read_json().ok()
}

fn fetch_changes(base_url: &str, since_id: i64, limit: i64) -> Option<ChangesSince> {
    let mut response = hook_agent()
        .get(format!(
            "{base_url}/api/changes?sinceId={since_id}&limit={limit}"
        ))
        .call()
        .ok()?;
    if !(200..300).contains(&response.status().as_u16()) {
        return None;
    }
    response.body_mut().read_json().ok()
}

/// `hook_ensure_daemon` 의 주입점 — TS 의 `EnsureDeps` 대응. 테스트가 실제 spawn/
/// SIGTERM/launchd 없이 stale 분기들을 검증할 수 있게 한다.
pub struct EnsureDeps<'a> {
    /// 이 설치본의 버전 — 데몬이 보고한 값과 다르면 stale 로 본다.
    pub version: &'a str,
    pub check_health: &'a dyn Fn(&str) -> Option<crate::client::DaemonHealth>,
    pub spawn: &'a dyn Fn(&CliContext),
    /// 구버전 데몬 종료. 성공 여부를 돌려준다.
    pub stop: &'a dyn Fn(&CliContext, Option<u32>) -> bool,
    /// launchd(KeepAlive) 상주 등록 여부.
    pub is_managed: &'a dyn Fn() -> bool,
    /// 상주 job 을 현재 설치 경로로 교체 (bootout→plist 갱신→bootstrap).
    pub replace_managed: &'a dyn Fn(),
}

/// SessionStart(startup): 데몬이 없으면 띄우고, **구버전이면** 내리고 현재 버전으로
/// 재기동한다. 실제 배선 — 판정은 `ensure_daemon_with` 에 있다.
pub fn hook_ensure_daemon(ctx: &CliContext) {
    ensure_daemon_with(
        ctx,
        &EnsureDeps {
            version: env!("CARGO_PKG_VERSION"),
            check_health: &daemon_health,
            spawn: &|ctx| {
                let _ = ensure_daemon(ctx);
            },
            stop: &stop_daemon,
            is_managed: &is_launchd_registered,
            replace_managed: &|| {
                install_launchd();
            },
        },
    );
}

/// 버전 비교는 정확 문자열 일치다 — 데몬 프로세스는 자기를 띄운 설치본보다 오래 살아,
/// 플러그인이 갱신돼도 옛 코드가 계속 돈다. version 미보고(≤0.1.0)도 stale 취급.
/// launchd(KeepAlive) 상주면 PID kill 은 무의미하다(즉시 되살아난다) — job 자체를 현재
/// 설치 경로로 교체한다. 못 내리면 재기동하지 않는다: 보드가 없는 것보다 구버전이라도
/// 있는 게 낫다.
pub fn ensure_daemon_with(ctx: &CliContext, deps: &EnsureDeps) {
    let Some(running) = (deps.check_health)(&ctx.base_url) else {
        (deps.spawn)(ctx);
        return;
    };
    if running.version.as_deref() == Some(deps.version) {
        return;
    }
    if (deps.is_managed)() {
        (deps.replace_managed)();
        return;
    }
    if (deps.stop)(ctx, running.pid) {
        (deps.spawn)(ctx);
    }
}

/// env/설정의 watch 토글 — env `ROCKY_TODO_WATCH` 가 있으면 그 값이 이기고, 없으면
/// `todo.watch`(기본 on).
fn watch_enabled(watch_config: Option<bool>) -> bool {
    if let Ok(raw) = std::env::var("ROCKY_TODO_WATCH") {
        let value = raw.trim().to_lowercase();
        if !value.is_empty() {
            return !matches!(value.as_str(), "0" | "false" | "off" | "no");
        }
    }
    watch_config != Some(false)
}

/// UserPromptSubmit: 마지막 확인 이후 사람이 보드에서 바꾼 내용 + 이 세션 앞의
/// 핸드오프를 additionalContext 로 주입한다.
///
/// 훅에서 데몬을 자동 기동하지 않는다 — 기동은 CLI/launchd 몫. 커서는 세션별이고
/// 첫 프롬프트에서는 현재 위치만 기록한다(과거 히스토리 덤프 방지).
pub fn hook_notify_todo(ctx: &CliContext, watch_config: Option<bool>) {
    if !watch_enabled(watch_config) {
        return;
    }
    let input = read_stdin_json();
    let Some(session_id) = input.get("session_id").and_then(|v| v.as_str()) else {
        return;
    };

    let cursor_file = ctx.dir.join("hook-cursors.json");
    let cursor = read_cursor(&cursor_file, session_id);

    // claim 과 changes 조회는 서로 독립이라 순차로 기다리면 최악(연결은 되는데
    // 응답이 늦는 데몬)에 1.5s 타임아웃이 두 번 더해져 프롬프트 지연이 배가된다 —
    // TS 의 Promise.all 대응으로 claim 을 스레드에 띄워 둘을 겹친다. 커서 읽기/쓰기
    // 순서와 "첫 프롬프트엔 과거 히스토리를 주입하지 않는다"는 동작은 그대로다.
    let claim_thread = {
        let base_url = ctx.base_url.clone();
        let session_id = session_id.to_string();
        std::thread::spawn(move || claim_handoff(&base_url, &session_id, "prompt"))
    };

    let mut change_context: Option<String> = None;
    match cursor {
        None => {
            // 첫 프롬프트 — 현재 watermark 만 기록하고 과거 히스토리는 주입하지 않는다.
            if let Some(feed) = fetch_changes(&ctx.base_url, 0, 1) {
                write_cursor(&cursor_file, session_id, feed.last_id);
            }
        }
        Some(cursor) => {
            if let Some(feed) = fetch_changes(&ctx.base_url, cursor, 100) {
                if feed.last_id != cursor {
                    write_cursor(&cursor_file, session_id, feed.last_id);
                }
                change_context = build_notify_context(&filter_human_changes(feed.entries));
            }
        }
    }

    // 패닉한 스레드는 "요청 없음"과 같게 본다 — fail-open.
    let claimed = claim_thread.join().unwrap_or(None);
    let handoff_context = claimed.as_ref().map(build_handoff_prompt);

    let Some(context) = merge_context(&[change_context, handoff_context]) else {
        return;
    };
    println!(
        "{}",
        json!({
            "hookSpecificOutput": {
                "hookEventName": "UserPromptSubmit",
                "additionalContext": context,
            }
        })
    );
}

/// Stop: 이 세션 앞으로 온 보드 작업 요청이 있으면 턴을 끝내지 못하게 막고
/// (`decision: "block"`) 그 자리에서 착수시킨다.
///
/// **서브에이전트에서는 빠진다** — 서브에이전트가 보드 요청을 가로채면 사용자가 보낸
/// 대상과 실제 처리 주체가 갈린다. 무한 루프는 구조적으로 없다: claim 된 건은
/// delivered 라 다시 나오지 않고, 큐가 비면 block 하지 않는다.
pub fn hook_handoff_stop(ctx: &CliContext) {
    let input = read_stdin_json();
    let Some(session_id) = input.get("session_id").and_then(|v| v.as_str()) else {
        return;
    };
    let is_subagent = input
        .get("agent_id")
        .and_then(|v| v.as_str())
        .is_some_and(|v| !v.is_empty())
        || input
            .get("agent_type")
            .and_then(|v| v.as_str())
            .is_some_and(|v| !v.is_empty());
    if is_subagent {
        return;
    }
    let Some(claimed) = claim_handoff(&ctx.base_url, session_id, "stop") else {
        return;
    };
    println!(
        "{}",
        json!({ "decision": "block", "reason": build_handoff_prompt(&claimed) })
    );
}
