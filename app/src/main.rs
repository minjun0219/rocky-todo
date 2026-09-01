//! rocky-todo 데스크톱 앱 — 보드 웹 UI 를 담는 얇은 Tauri 셸.
//!
//! 구조는 "데몬 위의 창"이다:
//!
//! - **살아 있는 데몬이 있으면 그 URL 로 창을 연다.** 전역 단일 인스턴스(포트 락)를
//!   존중한다 — TS 데몬이든 launchd 상주든, 앱이 데몬을 갈아치우지 않는다. 버전 인식
//!   교체는 SessionStart 훅(`hook ensure-daemon`)의 몫이고 여기서 겹치면 앱을 열 때마다
//!   상주 데몬이 죽는 사고가 된다.
//! - **없을 때만 in-process 로 마운트한다** — `rocky-todod` 가 lib 인 이유가 이것이다.
//!   앱이 곧 데몬이 되므로 별도 프로세스가 없고, 앱을 닫으면 데몬도 내려간다(다음
//!   CLI/훅이 headless `rocky-todod` 를 다시 띄운다).
//! - 창은 tauri 자산이 아니라 `http://127.0.0.1:<port>/` 를 직접 로드한다 — 기존 웹
//!   UI 와 SSE 실시간을 그대로 얻고, 자산 임베드 경로를 하나 더 만들지 않는다.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use rocky_todo_core::config::{
    env_snapshot, load_todo_config, resolve_runtime_config, user_config_path,
};
use rocky_todod::daemon::daemon_health;

/// in-process 데몬이 서빙할 웹 UI 번들 위치.
///
/// env `ROCKY_TODO_UI_DIST` > 앱 번들 리소스의 `dist/`(프리릴리즈에서 채운다) > 없음.
/// 없으면 API/MCP 는 살고 `/` 만 자리 표시자가 된다 — 조용히 죽는 것보다 낫다.
fn resolve_ui_dist(resource_dir: Option<PathBuf>) -> Option<PathBuf> {
    if let Ok(from_env) = std::env::var("ROCKY_TODO_UI_DIST") {
        let path = PathBuf::from(from_env);
        if path.is_dir() {
            return Some(path);
        }
    }
    resource_dir
        .map(|dir| dir.join("dist"))
        .filter(|dir| dir.is_dir())
}

/// 데몬을 확보하고 창이 로드할 base URL 을 돌려준다.
///
/// 기동 대기는 최대 ~5s — in-process 바인딩은 수십 ms 지만, 같은 순간 다른 인스턴스가
/// 포트를 잡는 레이스에서도 그쪽 health 가 잡히면 그대로 쓴다(누가 서빙하든 보드는
/// 하나다).
fn ensure_backend(resource_dir: Option<PathBuf>) -> String {
    let todo = load_todo_config(&user_config_path());
    let env = env_snapshot();
    let runtime = resolve_runtime_config(&env, &todo);
    let base_url = format!("http://127.0.0.1:{}", runtime.port);

    if daemon_health(&base_url).is_some() {
        return base_url;
    }

    let ui_dist = resolve_ui_dist(resource_dir);
    std::thread::spawn(move || {
        let runtime = match tokio::runtime::Runtime::new() {
            Ok(rt) => rt,
            Err(_) => return,
        };
        // 실패(포트 레이스에서 진 경우 등)해도 앱은 계속 간다 — 아래 health 폴링이
        // 이긴 쪽 데몬을 잡는다.
        let _ = runtime.block_on(rocky_todod::daemon::start_daemon(ui_dist));
    });

    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if daemon_health(&base_url).is_some() {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    base_url
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            use tauri::Manager;
            let resource_dir = app.path().resource_dir().ok();
            let base_url = ensure_backend(resource_dir);
            tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::External(base_url.parse()?),
            )
            .title("rocky-todo")
            .inner_size(1280.0, 860.0)
            .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("tauri 앱을 시작하지 못했다");
}
