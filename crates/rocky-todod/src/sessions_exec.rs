//! `claude agents --json` 실행 + TTL 캐시 — TS 원본 `src/sessions.ts` 의 실행 절반.
//! 파싱은 core(`rocky_todo_core::sessions::parse_sessions`)가 한다.

use std::sync::Arc;
use std::time::{Duration, Instant};

use rocky_todo_core::sessions::{parse_sessions, SessionsResult};
use tokio::sync::Mutex;

use crate::runner::Runner;

pub const SESSIONS_TIMEOUT: Duration = Duration::from_secs(5);

/// 세션 목록 한 번 — 실행 실패는 available:false + reason.
pub async fn list_sessions(runner: &Runner) -> SessionsResult {
    let result = runner(
        vec!["claude".into(), "agents".into(), "--json".into()],
        String::new(),
        SESSIONS_TIMEOUT,
    )
    .await;
    if !result.ok() {
        let reason = format!("{}{}", result.stderr, result.stdout)
            .trim()
            .to_string();
        let reason = if reason.is_empty() {
            "claude CLI 를 실행할 수 없다".to_string()
        } else {
            reason
        };
        return SessionsResult::unavailable(reason);
    }
    parse_sessions(&result.stdout)
}

/// 조회기 — 서버 옵션 주입용. 캐시 유무/수명은 만들 때 정해진다.
pub type SessionsProvider = Arc<dyn Fn() -> crate::runner::BoxFut<SessionsResult> + Send + Sync>;

/// 캐시 없는 조회기 — spawn 라우트 전용(가드가 spawn 이전 스냅샷을 보면 안 된다).
pub fn uncached_sessions(runner: Runner) -> SessionsProvider {
    Arc::new(move || {
        let runner = runner.clone();
        Box::pin(async move { list_sessions(&runner).await })
    })
}

/// TTL 메모이즈 조회기 — 기본 3초, statusline 라우트는 15초.
pub fn cached_sessions(runner: Runner, ttl: Duration) -> SessionsProvider {
    let cache: Arc<Mutex<Option<(Instant, SessionsResult)>>> = Arc::new(Mutex::new(None));
    Arc::new(move || {
        let runner = runner.clone();
        let cache = cache.clone();
        Box::pin(async move {
            let mut slot = cache.lock().await;
            if let Some((at, cached)) = slot.as_ref() {
                if at.elapsed() < ttl {
                    return cached.clone();
                }
            }
            let fresh = list_sessions(&runner).await;
            *slot = Some((Instant::now(), fresh.clone()));
            fresh
        })
    })
}

/// 고정 결과 조회기 — 테스트 주입용.
pub fn fixed_sessions(result: SessionsResult) -> SessionsProvider {
    Arc::new(move || {
        let result = result.clone();
        Box::pin(async move { result })
    })
}
