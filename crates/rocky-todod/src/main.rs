//! rocky-todod 단독 실행 — 헤드리스/개발용. 실제 배포는 Tauri 앱이 lib 를 마운트한다.

use std::path::PathBuf;

#[tokio::main]
async fn main() {
    // 웹 UI dist — env 로 지정, 없으면 실행 파일 기준/cwd 의 dist 를 시도한다.
    let ui_dist = std::env::var("ROCKY_TODO_UI_DIST")
        .map(PathBuf::from)
        .ok()
        .or_else(|| {
            let cwd_dist = std::env::current_dir().ok()?.join("dist");
            cwd_dist.join("index.html").exists().then_some(cwd_dist)
        });
    if let Err(error) = rocky_todod::daemon::start_daemon(ui_dist).await {
        eprintln!("rocky-todod: {error}");
        std::process::exit(1);
    }
}
