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

/// macOS .app 번들의 Resources 디렉터리 — 실행 파일(`Contents/MacOS/…`) 기준 고정
/// 상대 경로다. tauri 의 path resolver 는 앱 핸들이 있어야 쓸 수 있는데, 백엔드 확보는
/// GUI 기동 **앞**에서 끝내야 실패를 다이얼로그로 보여주고 깨끗이 물러날 수 있다.
fn bundled_resource_dir() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let resources = exe.parent()?.parent()?.join("Resources");
    resources.is_dir().then_some(resources)
}

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
///
/// # Errors
/// 마감까지 health 가 확인되지 않으면 — 성공한 척 URL 을 돌려주면 앱이 연결 오류
/// 화면을 띄우거나, 그 포트를 점유한 **무관한 서비스**를 로드하며 실제 실패 원인이
/// 버려진다(health 는 신원 검증을 하므로 무관한 서비스는 여기서 걸러진다).
fn ensure_backend(resource_dir: Option<PathBuf>) -> Result<String, String> {
    let todo = load_todo_config(&user_config_path());
    let env = env_snapshot();
    let runtime = resolve_runtime_config(&env, &todo);
    let base_url = format!("http://127.0.0.1:{}", runtime.port);

    if daemon_health(&base_url).is_some() {
        return Ok(base_url);
    }

    let ui_dist = resolve_ui_dist(resource_dir);
    std::thread::spawn(move || {
        let runtime = match tokio::runtime::Runtime::new() {
            Ok(rt) => rt,
            Err(_) => return,
        };
        // 포트 레이스에서 져도 여기서 끝내지 않는다 — 아래 health 폴링이 이긴 쪽
        // 데몬을 잡으면 그대로 성공이다.
        let _ = runtime.block_on(rocky_todod::daemon::start_daemon(ui_dist));
    });

    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if daemon_health(&base_url).is_some() {
            return Ok(base_url);
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err(format!(
        "rocky-todo 데몬을 확보하지 못했다 — 포트 {port} 를 다른 서비스가 점유했거나 기동이 실패했다. `rocky-todo daemon status` 로 확인하라.",
        port = runtime.port
    ))
}

/// 확보된 백엔드 URL(파싱 완료) — Reopen 에서 창을 다시 만들 때 재사용한다.
struct BackendUrl(tauri::Url);

/// 메인 창을 만든다 — 첫 기동(setup)과 macOS Reopen 이 같은 코드를 쓴다.
fn open_main_window(app: &tauri::AppHandle, url: tauri::Url) -> tauri::Result<()> {
    tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::External(url))
        .title("rocky-todo")
        .inner_size(1280.0, 860.0)
        .build()?;
    Ok(())
}

/// 기동 실패를 화면으로 알린다 — Dock 에서 띄운 앱의 stderr 는 아무도 못 본다.
fn show_startup_error(message: &str) {
    let script = format!(
        "display alert \"rocky-todo\" message \"{}\" as critical",
        message.replace('\\', " ").replace('"', "'")
    );
    let _ = std::process::Command::new("osascript")
        .args(["-e", &script])
        .status();
}

fn main() {
    // 백엔드 확보는 GUI 기동 앞에서 — setup 안에서 실패하면 tauri 내부를 거치며
    // abort 트레이스로 죽는다(실측). 여기서 끝내면 다이얼로그 + 정상 종료가 된다.
    let base_url = match ensure_backend(bundled_resource_dir()) {
        Ok(url) => url,
        Err(message) => {
            eprintln!("{message}");
            show_startup_error(&message);
            std::process::exit(1);
        }
    };
    let url: tauri::Url = match base_url.parse() {
        Ok(url) => url,
        Err(error) => {
            let message = format!("백엔드 URL 이 잘못됐다: {error}");
            eprintln!("{message}");
            show_startup_error(&message);
            std::process::exit(1);
        }
    };

    let app = tauri::Builder::default()
        .setup(move |app| {
            use tauri::Manager;
            open_main_window(app.handle(), url.clone())?;
            app.manage(BackendUrl(url.clone()));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("tauri 앱을 시작하지 못했다");

    app.run(|app, event| {
        // macOS 는 마지막 창을 닫아도 프로세스가 남는다 — Dock 아이콘으로 다시 열면
        // setup 은 재실행되지 않으므로 여기서 창을 재생성해야 창 없는 유령 상태가
        // 안 된다.
        if let tauri::RunEvent::Reopen {
            has_visible_windows: false,
            ..
        } = event
        {
            use tauri::Manager;
            let url = app.state::<BackendUrl>().0.clone();
            let _ = open_main_window(app, url);
        }
    });
}
