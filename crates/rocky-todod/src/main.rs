//! rocky-todod 단독 실행 — 플러그인 훅/CLI 가 띄우는 상주 데몬이자 개발용 진입점.
//! Tauri 앱은 같은 lib 를 in-process 로 마운트한다.

use std::path::PathBuf;

/// 웹 UI dist 를 찾는다 — env > 실행 파일 옆 `dist/` > cwd 의 `dist/`.
///
/// 실행 파일 옆을 보는 이유: 릴리스 tarball 이 `rocky-todo`/`rocky-todod`/`dist/` 를 한
/// 디렉터리로 풀리고 부트스트랩이 그대로 설치하므로, 데몬은 env 없이도 자기 옆의 UI 를
/// 서빙해야 한다. cwd 는 레포에서 `cargo run` 할 때를 위한 폴백이다.
fn resolve_ui_dist() -> Option<PathBuf> {
    if let Some(dist) = std::env::var_os("ROCKY_TODO_UI_DIST") {
        return Some(PathBuf::from(dist));
    }
    let has_index = |dir: PathBuf| dir.join("index.html").is_file().then_some(dir);
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join("dist")))
        .and_then(has_index)
        .or_else(|| {
            std::env::current_dir()
                .ok()
                .and_then(|cwd| has_index(cwd.join("dist")))
        })
}

#[tokio::main]
async fn main() {
    if let Err(error) = rocky_todod::daemon::start_daemon(resolve_ui_dist()).await {
        eprintln!("rocky-todod: {error}");
        std::process::exit(1);
    }
}
