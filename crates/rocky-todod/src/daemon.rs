//! 데몬 배선 — TS 원본 `src/daemon.ts`. lib 에 두는 이유: Tauri 앱이 같은 프로세스에
//! 마운트한다(단독 실행은 main.rs).
//!
//! 네 표면: `/` 웹 UI(dist 정적 서빙 + SPA fallback) · `/api/*` REST · `/api/events` SSE
//! · `/mcp` MCP streamable HTTP. 단일성 보장: 기동 시 같은 포트의 기존 인스턴스 health
//! 를 확인하고 있으면 즉시 종료한다(포트 자체가 락).

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::body::Body;
use axum::extract::{ConnectInfo, State};
use axum::http::{Request, StatusCode};
use axum::response::Response;
use axum::routing::any;
use axum::Router;
use rocky_todo_core::local_request::{is_cross_site_request, is_local_request, CROSS_SITE_MESSAGE};
use rocky_todo_core::TodoStore;
use tower::Service;
use tower_http::services::{ServeDir, ServeFile};

use crate::config::{resolve_runtime_config, ExposeChannel, TodoRuntimeConfig};
use crate::mcp::{mcp_service, TodoMcp};
use crate::runner::default_runner;
use crate::server::{build_server, handle_api, ServerOptions, ServerState};

type McpSvc = rmcp::transport::streamable_http_server::StreamableHttpService<
    TodoMcp,
    rmcp::transport::streamable_http_server::session::never::NeverSessionManager,
>;

#[derive(Clone)]
pub struct AppState {
    pub server: Arc<ServerState>,
    /// allowIssueCreate=true/false 두 벌 — 요청의 isLocalRequest 판정으로 고른다.
    mcp_local: McpSvc,
    mcp_remote: McpSvc,
}

/// 같은 포트의 살아 있는 rocky-todo 인스턴스 확인 — **신원 검증** 포함(무관한 서비스의
/// 2xx JSON 을 데몬으로 오인하지 않는다).
pub fn daemon_health(base_url: &str) -> Option<serde_json::Value> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(std::time::Duration::from_millis(700)))
        .build()
        .into();
    let mut response = agent.get(format!("{base_url}/api/health")).call().ok()?;
    let body: serde_json::Value = response.body_mut().read_json().ok()?;
    if body.get("ok") != Some(&serde_json::Value::Bool(true))
        || body.get("name").and_then(|n| n.as_str()) != Some("rocky-todo")
    {
        return None;
    }
    Some(body)
}

/// axum Router 를 만든다 — 서빙 바인딩은 호출자(run_daemon / Tauri) 몫.
pub fn build_router(state: Arc<ServerState>, ui_dist: Option<&Path>) -> Router {
    let app_state = AppState {
        mcp_local: mcp_service(state.clone(), true),
        mcp_remote: mcp_service(state.clone(), false),
        server: state,
    };
    let mut router = Router::new()
        .route("/mcp", any(mcp_handler))
        .route("/api/{*rest}", any(api_handler))
        .route("/api", any(api_handler));
    // 웹 UI — 퍼머링크(`/rocky/12`) 새로고침은 index.html fallback 으로 돌아온다.
    if let Some(dist) = ui_dist {
        let serve = ServeDir::new(dist).fallback(ServeFile::new(dist.join("index.html")));
        router = router.fallback_service(serve);
    }
    router.with_state(app_state)
}

async fn api_handler(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    req: Request<Body>,
) -> Response {
    handle_api(&state.server, req, Some(peer.ip().to_string())).await
}

async fn mcp_handler(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    req: Request<Body>,
) -> Response {
    // REST 와 같은 cross-site 가드 — "변경은 라우트 전에 끊는다" 규칙의 예외를 남기지 않는다.
    let headers = req.headers().clone();
    let get_header = |name: &str| {
        headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
    };
    if req.method() != axum::http::Method::GET {
        let host = get_header("host").unwrap_or_else(|| "localhost".to_string());
        let url = format!("http://{host}{}", req.uri().path());
        if is_cross_site_request(get_header, &url) {
            return Response::builder()
                .status(StatusCode::FORBIDDEN)
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "error": CROSS_SITE_MESSAGE }).to_string(),
                ))
                .unwrap();
        }
    }
    let local = is_local_request(Some(&peer.ip().to_string()), |name| {
        req.headers().contains_key(name)
    });
    let mut service = if local {
        state.mcp_local.clone()
    } else {
        state.mcp_remote.clone()
    };
    match service.call(req).await {
        Ok(response) => response.map(Body::new),
        Err(never) => match never {},
    }
}

/// 데몬을 기동해 리슨한다 — TS `startDaemon` 대응. 반환하지 않는다(서버 수명).
pub async fn run_daemon(
    runtime: TodoRuntimeConfig,
    ui_dist: Option<PathBuf>,
) -> Result<(), Box<dyn std::error::Error>> {
    // 단일 인스턴스 가드 — 포트 자체가 락.
    let base_url = format!("http://127.0.0.1:{}", runtime.port);
    let already = tokio::task::spawn_blocking({
        let base_url = base_url.clone();
        move || daemon_health(&base_url).is_some()
    })
    .await?;
    if already {
        println!(
            "rocky-todo daemon already running on port {} — exiting",
            runtime.port
        );
        return Ok(());
    }

    std::fs::create_dir_all(&runtime.dir)?;
    let store = Arc::new(TodoStore::open(&runtime.dir.join("todo.db"))?);
    let state = build_server(ServerOptions {
        statusline_template: Some(runtime.statusline_template.clone()),
        ..ServerOptions::new(store)
    });
    let router = build_router(state, ui_dist.as_deref());

    let addr: SocketAddr = format!("{}:{}", runtime.host, runtime.port).parse()?;
    let listener = tokio::net::TcpListener::bind(addr).await?;

    let pid_path = runtime.dir.join("daemon.pid");
    std::fs::write(&pid_path, std::process::id().to_string())?;

    println!(
        "rocky-todo daemon listening on http://{}:{} (db: {})",
        runtime.host,
        runtime.port,
        runtime.dir.display()
    );
    if runtime.host != "127.0.0.1" {
        println!("주의: 루프백 외 바인딩 — 같은 네트워크의 기기가 인증 없이 보드에 접근할 수 있다");
        println!("      (GitHub 이슈 생성은 예외 — 로컬 요청만 허용된다)");
    }

    // 옵션: expose 에 tailscale 채널이 있을 때만 serve 보장 — 남의 노출은 빼앗지 않는다.
    if runtime.expose.contains(&ExposeChannel::TailscaleServe) {
        let runner = default_runner();
        let port = runtime.port;
        let message = crate::tailscale::ensure_tailscale_serve(&runner, port, move |target| {
            Box::pin(async move {
                tokio::task::spawn_blocking(move || {
                    daemon_health(&format!("http://127.0.0.1:{target}")).is_some()
                })
                .await
                .unwrap_or(false)
            })
        })
        .await;
        println!("{message}");
    }

    let shutdown_pid = pid_path.clone();
    let server = axum::serve(
        listener,
        router.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(async move {
        shutdown_signal().await;
        let _ = std::fs::remove_file(&shutdown_pid);
    });
    server.await?;
    let _ = std::fs::remove_file(&pid_path);
    Ok(())
}

async fn shutdown_signal() {
    use tokio::signal::unix::{signal, SignalKind};
    let mut sigterm = signal(SignalKind::terminate()).expect("sigterm handler");
    let mut sigint = signal(SignalKind::interrupt()).expect("sigint handler");
    tokio::select! {
        _ = sigterm.recv() => {}
        _ = sigint.recv() => {}
    }
}

/// 설정 로드까지 포함한 진입 — main.rs 와 Tauri 가 공유.
pub async fn start_daemon(ui_dist: Option<PathBuf>) -> Result<(), Box<dyn std::error::Error>> {
    let config_path = crate::config::user_config_path();
    let todo = crate::config::load_todo_config(&config_path);
    let env = crate::config::env_snapshot();
    let runtime = resolve_runtime_config(&env, &todo);
    run_daemon(runtime, ui_dist).await
}
