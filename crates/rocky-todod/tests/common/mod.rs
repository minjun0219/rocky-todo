//! server 테스트 공용 하네스 — TS `server.test.ts` 의 `req`/픽스처 대응.
// 테스트 바이너리마다 별도 컴파일이라 파일별로 안 쓰는 헬퍼가 남는다 — dead_code 는 정상.
#![allow(dead_code)]

use std::path::PathBuf;
use std::sync::Arc;

use axum::body::Body;
use axum::http::{header, Request};
use rocky_todo_core::sessions::{AgentSession, SessionsResult};
use rocky_todo_core::store::TodoStore;
use rocky_todod::server::{build_server, handle_api, ServerOptions, ServerState};
use rocky_todod::sessions_exec::fixed_sessions;
use serde_json::Value;

pub struct Fx {
    pub _dir: tempfile::TempDir,
    pub db_path: PathBuf,
    pub store: Arc<TodoStore>,
    pub state: Arc<ServerState>,
}

/// 기본 픽스처 — 세션 조회는 unavailable 고정(허메틱: 실제 `claude` 를 부르지 않는다).
pub fn fx() -> Fx {
    fx_with(|_| {})
}

pub fn fx_with(customize: impl FnOnce(&mut ServerOptions)) -> Fx {
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("todo.db");
    let store = Arc::new(TodoStore::open(&db_path).unwrap());
    let mut options = ServerOptions::new(store.clone());
    options.sessions = Some(fixed_sessions(SessionsResult::unavailable(
        "claude CLI 를 실행할 수 없다",
    )));
    customize(&mut options);
    let state = build_server(options);
    Fx {
        _dir: dir,
        db_path,
        store,
        state,
    }
}

/// 같은 store 로 옵션만 갈아끼운 새 핸들 — TS 의 `handle = buildTodoServer({store, ...})`.
pub fn rebuild(fx: &Fx, customize: impl FnOnce(&mut ServerOptions)) -> Arc<ServerState> {
    let mut options = ServerOptions::new(fx.store.clone());
    options.sessions = Some(fixed_sessions(SessionsResult::unavailable(
        "claude CLI 를 실행할 수 없다",
    )));
    customize(&mut options);
    build_server(options)
}

pub struct ReqOptions<'a> {
    pub actor: &'a str,
    pub peer: Option<&'a str>,
    pub headers: Vec<(&'a str, &'a str)>,
    /// content-type 자동 부착을 끄고 싶을 때(CSRF 심층 방어 테스트).
    pub raw_body: Option<(&'a str, Option<&'a str>)>,
}

impl Default for ReqOptions<'_> {
    fn default() -> Self {
        ReqOptions {
            actor: "tester",
            peer: Some("127.0.0.1"),
            headers: Vec::new(),
            raw_body: None,
        }
    }
}

/// 요청 하나 → (status, json body). 본문이 JSON 이 아니면 Value::String.
pub async fn call(
    state: &Arc<ServerState>,
    method: &str,
    path: &str,
    body: Option<Value>,
    options: ReqOptions<'_>,
) -> (u16, Value) {
    let mut builder = Request::builder()
        .method(method)
        .uri(format!("http://localhost{path}"));
    builder = builder.header("x-rocky-actor", options.actor);
    for (name, value) in &options.headers {
        builder = builder.header(*name, *value);
    }
    let request = if let Some((raw, content_type)) = options.raw_body {
        if let Some(ct) = content_type {
            builder = builder.header(header::CONTENT_TYPE, ct);
        }
        builder.body(Body::from(raw.to_string())).unwrap()
    } else if let Some(body) = body {
        builder
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    } else {
        builder.body(Body::empty()).unwrap()
    };
    let response = handle_api(state, request, options.peer.map(str::to_string)).await;
    let status = response.status().as_u16();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let text = String::from_utf8_lossy(&bytes).to_string();
    let value = serde_json::from_str(&text).unwrap_or(Value::String(text));
    (status, value)
}

/// GET 축약.
pub async fn get(state: &Arc<ServerState>, path: &str) -> (u16, Value) {
    call(state, "GET", path, None, ReqOptions::default()).await
}

/// POST(JSON) 축약.
pub async fn post(state: &Arc<ServerState>, path: &str, body: Value) -> (u16, Value) {
    call(state, "POST", path, Some(body), ReqOptions::default()).await
}

pub async fn patch(state: &Arc<ServerState>, path: &str, body: Value) -> (u16, Value) {
    call(state, "PATCH", path, Some(body), ReqOptions::default()).await
}

/// 세션 픽스처 한 줄 생성.
pub fn sess(pid: i64, cwd: &str, session_id: &str, name: &str, status: &str) -> AgentSession {
    AgentSession {
        pid,
        cwd: cwd.into(),
        kind: "interactive".into(),
        id: None,
        session_id: session_id.into(),
        name: name.into(),
        status: status.into(),
        state: None,
        started_at: pid,
    }
}

pub fn available(sessions: Vec<AgentSession>) -> SessionsResult {
    SessionsResult {
        available: true,
        sessions,
        reason: None,
    }
}

/// id prefix 테스트용 — 알파벳이 나오는 지점까지(전부 숫자면 번호 분기로 새는 것 방지).
pub fn id_prefix(id: &str) -> String {
    match id.find(|c: char| c.is_ascii_lowercase()) {
        None => id.to_string(),
        Some(at) => id[..std::cmp::max(4, at + 1)].to_string(),
    }
}
