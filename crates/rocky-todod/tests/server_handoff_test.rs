//! TS `src/server.test.ts` 포팅 3/4 — handoff routes + doingState + claim 게이트.

mod common;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use common::*;
use rocky_todo_core::sessions::SessionsResult;
use rocky_todo_core::types::*;
use rocky_todod::sessions_exec::{fixed_sessions, SessionsProvider};
use serde_json::json;

fn fixture_sessions() -> SessionsResult {
    available(vec![
        sess(1, "/w/rocky-todo", "sess-1", "rocky-todo-1e", "idle"),
        sess(2, "/w/forses", "sess-2", "forses-90", "busy"),
    ])
}

fn counting(counter: Arc<AtomicUsize>, result: SessionsResult) -> SessionsProvider {
    Arc::new(move || {
        counter.fetch_add(1, Ordering::SeqCst);
        let result = result.clone();
        Box::pin(async move { result })
    })
}

fn create(f: &Fx, board: &str, title: &str) -> Todo {
    f.store
        .create_todo(
            &CreateTodoInput {
                board: board.into(),
                title: title.into(),
                ..Default::default()
            },
            "logan",
        )
        .unwrap()
}

fn handoff_input(todo_ref: &str, session_id: &str) -> CreateHandoffInput {
    CreateHandoffInput {
        todo_ref: todo_ref.into(),
        session_id: session_id.into(),
        session_name: None,
        session_cwd: None,
        note: None,
        actor: "logan".into(),
        current_board_id: None,
    }
}

#[tokio::test]
async fn get_sessions_lists_with_board_matching() {
    let f = fx();
    let state = rebuild(&f, |o| {
        o.sessions = Some(fixed_sessions(fixture_sessions()))
    });
    let (status, body) = get(&state, "/api/sessions?board=rocky-todo").await;
    assert_eq!(status, 200);
    assert_eq!(body["available"], true);
    let sessions = body["sessions"].as_array().unwrap();
    let by_name = |name: &str| sessions.iter().find(|s| s["name"] == name).unwrap();
    assert_eq!(by_name("rocky-todo-1e")["matched"], true);
    assert_eq!(by_name("forses-90")["matched"], false);
}

#[tokio::test]
async fn sessions_unavailable_is_reported() {
    let f = fx();
    let state = rebuild(&f, |o| {
        o.sessions = Some(fixed_sessions(SessionsResult::unavailable(
            "claude CLI 없음",
        )))
    });
    let (status, body) = get(&state, "/api/sessions").await;
    assert_eq!(status, 200);
    assert_eq!(body["available"], false);
    assert_eq!(body["reason"], "claude CLI 없음");
}

#[tokio::test]
async fn post_handoff_with_session_id_gives_snapshot() {
    let f = fx();
    let state = rebuild(&f, |o| {
        o.sessions = Some(fixed_sessions(fixture_sessions()))
    });
    let todo = create(&f, "rocky-todo", "x");
    let (status, body) = post(
        &state,
        &format!("/api/todos/{}/handoff", todo.id),
        json!({"sessionId":"sess-1","note":"테스트부터"}),
    )
    .await;
    assert_eq!(status, 201);
    assert_eq!(body["sessionName"], "rocky-todo-1e");
    assert_eq!(body["sessionCwd"], "/w/rocky-todo");
    assert_eq!(body["note"], "테스트부터");
}

#[tokio::test]
async fn post_handoff_returns_poke() {
    let f = fx();
    let state = rebuild(&f, |o| {
        o.sessions = Some(fixed_sessions(fixture_sessions()))
    });
    let todo = create(&f, "rocky-todo", "프렁크 래치 로깅");
    let (status, body) = post(
        &state,
        &format!("/api/todos/{}/handoff", todo.id),
        json!({"sessionId":"sess-1"}),
    )
    .await;
    assert_eq!(status, 201);
    // `to` 는 SendMessage 가 그대로 받는 세션 이름 — sessionId 가 아니다.
    assert_eq!(body["poke"]["to"], "rocky-todo-1e");
    let message = body["poke"]["message"].as_str().unwrap();
    assert!(message.contains("프렁크 래치 로깅"));
    assert!(message.contains("todo_list"));
}

#[tokio::test]
async fn post_handoff_auto_matches_board_when_session_omitted() {
    let f = fx();
    let state = rebuild(&f, |o| {
        o.sessions = Some(fixed_sessions(fixture_sessions()))
    });
    let todo = create(&f, "rocky-todo", "x");
    let (status, body) = post(
        &state,
        &format!("/api/todos/{}/handoff", todo.id),
        json!({}),
    )
    .await;
    assert_eq!(status, 201);
    assert_eq!(body["sessionId"], "sess-1");
}

#[tokio::test]
async fn no_or_many_candidates_is_409_with_list() {
    let f = fx();
    let state = rebuild(&f, |o| {
        o.sessions = Some(fixed_sessions(fixture_sessions()))
    });
    let todo = create(&f, "gotgan", "x");
    let (status, body) = post(
        &state,
        &format!("/api/todos/{}/handoff", todo.id),
        json!({}),
    )
    .await;
    assert_eq!(status, 409);
    assert!(body["error"].as_str().unwrap().contains("고르라"));
    assert!(body["candidates"].is_array());
}

#[tokio::test]
async fn existing_pending_is_409() {
    let f = fx();
    let state = rebuild(&f, |o| {
        o.sessions = Some(fixed_sessions(fixture_sessions()))
    });
    let todo = create(&f, "rocky-todo", "x");
    f.store
        .create_handoff(&handoff_input(&todo.id, "sess-1"))
        .unwrap();
    let (status, _) = post(
        &state,
        &format!("/api/todos/{}/handoff", todo.id),
        json!({"sessionId":"sess-1"}),
    )
    .await;
    assert_eq!(status, 409);
}

#[tokio::test]
async fn unknown_todo_is_404() {
    let f = fx();
    let state = rebuild(&f, |o| {
        o.sessions = Some(fixed_sessions(fixture_sessions()))
    });
    let (status, _) = post(
        &state,
        "/api/todos/zzzzzzzz/handoff",
        json!({"sessionId":"sess-1"}),
    )
    .await;
    assert_eq!(status, 404);
}

#[tokio::test]
async fn non_string_session_id_is_400_not_auto_match() {
    let f = fx();
    let state = rebuild(&f, |o| {
        o.sessions = Some(fixed_sessions(fixture_sessions()))
    });
    let todo = create(&f, "rocky-todo", "x");
    let (status, _) = post(
        &state,
        &format!("/api/todos/{}/handoff", todo.id),
        json!({"sessionId": 42}),
    )
    .await;
    assert_eq!(status, 400);
    assert!(f.store.pending_handoff_of(&todo.id).unwrap().is_none());
}

#[tokio::test]
async fn unknown_session_id_is_400() {
    let f = fx();
    let state = rebuild(&f, |o| {
        o.sessions = Some(fixed_sessions(fixture_sessions()))
    });
    let todo = create(&f, "rocky-todo", "x");
    let (status, _) = post(
        &state,
        &format!("/api/todos/{}/handoff", todo.id),
        json!({"sessionId":"ghost"}),
    )
    .await;
    assert_eq!(status, 400);
}

#[tokio::test]
async fn claim_gives_one_then_204() {
    let f = fx();
    let state = rebuild(&f, |o| {
        o.sessions = Some(fixed_sessions(fixture_sessions()))
    });
    let todo = create(&f, "rocky-todo", "핸드오프");
    f.store
        .create_handoff(&handoff_input(&todo.id, "sess-1"))
        .unwrap();

    let (status, body) = post(
        &state,
        "/api/handoffs/claim",
        json!({"sessionId":"sess-1","via":"stop"}),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(body["todoTitle"], "핸드오프");
    assert_eq!(body["remaining"], 0);

    let (status, _) = post(
        &state,
        "/api/handoffs/claim",
        json!({"sessionId":"sess-1","via":"stop"}),
    )
    .await;
    assert_eq!(status, 204);
}

#[tokio::test]
async fn get_handoffs_marks_gone_target_stale() {
    let f = fx();
    let state = rebuild(&f, |o| {
        o.sessions = Some(fixed_sessions(fixture_sessions()))
    });
    let todo = create(&f, "rocky-todo", "x");
    f.store
        .create_handoff(&handoff_input(&todo.id, "ghost-session"))
        .unwrap();
    let (status, body) = get(&state, "/api/handoffs?status=pending").await;
    assert_eq!(status, 200);
    assert_eq!(body[0]["stale"], true);
}

#[tokio::test]
async fn cancel_200_then_400() {
    let f = fx();
    let state = rebuild(&f, |o| {
        o.sessions = Some(fixed_sessions(fixture_sessions()))
    });
    let todo = create(&f, "rocky-todo", "x");
    let handoff = f
        .store
        .create_handoff(&handoff_input(&todo.id, "sess-1"))
        .unwrap();
    let (status, _) = post(
        &state,
        &format!("/api/handoffs/{}/cancel", handoff.id),
        json!({}),
    )
    .await;
    assert_eq!(status, 200);
    let (status, _) = post(
        &state,
        &format!("/api/handoffs/{}/cancel", handoff.id),
        json!({}),
    )
    .await;
    assert_eq!(status, 400);
}

#[tokio::test]
async fn get_handoffs_skips_session_lookup_without_pending() {
    let f = fx();
    let calls = Arc::new(AtomicUsize::new(0));
    let state = rebuild(&f, |o| {
        o.sessions = Some(counting(calls.clone(), fixture_sessions()))
    });
    let todo = create(&f, "rocky-todo", "x");
    let cancelled = f
        .store
        .create_handoff(&handoff_input(&todo.id, "sess-1"))
        .unwrap();
    f.store.cancel_handoff(&cancelled.id, "logan").unwrap();

    let (status, body) = get(&state, "/api/handoffs?status=pending").await;
    assert_eq!(status, 200);
    assert_eq!(body, json!([]));
    assert_eq!(calls.load(Ordering::SeqCst), 0);

    f.store
        .create_handoff(&handoff_input(&todo.id, "sess-1"))
        .unwrap();
    let (status, _) = get(&state, "/api/handoffs").await;
    assert_eq!(status, 200);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn get_handoffs_queries_sessions_for_unstarted_candidates() {
    let f = fx();
    let calls = Arc::new(AtomicUsize::new(0));
    let state = rebuild(&f, |o| {
        o.sessions = Some(counting(calls.clone(), fixture_sessions()))
    });
    let todo = create(&f, "rocky-todo", "x");
    f.store
        .create_handoff(&handoff_input(&todo.id, "sess-1"))
        .unwrap();
    f.store.claim_handoff("sess-1", HandoffVia::Stop).unwrap();

    let (status, body) = get(&state, "/api/handoffs").await;
    assert_eq!(status, 200);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    // sess-1 은 idle — 집어가 놓고 아무것도 안 했다.
    assert_eq!(body[0]["phase"], "delivered");
    assert_eq!(body[0]["unstarted"], true);
}

#[tokio::test]
async fn accepted_handoff_is_not_unstarted() {
    let f = fx();
    let state = rebuild(&f, |o| {
        o.sessions = Some(fixed_sessions(fixture_sessions()))
    });
    let todo = create(&f, "rocky-todo", "x");
    f.store
        .create_handoff(&handoff_input(&todo.id, "sess-1"))
        .unwrap();
    f.store.claim_handoff("sess-1", HandoffVia::Stop).unwrap();
    f.store
        .set_todo_status(&todo.id, StatusAction::Start, "claude-code", None)
        .unwrap();

    let (_, body) = get(&state, "/api/handoffs").await;
    assert_eq!(body[0]["phase"], "accepted");
    assert_eq!(body[0]["unstarted"], false);
}

#[tokio::test]
async fn open_true_includes_pending_and_undone_delivered() {
    let f = fx();
    let state = rebuild(&f, |o| {
        o.sessions = Some(fixed_sessions(fixture_sessions()))
    });
    let waiting = create(&f, "rocky-todo", "대기");
    let finished = create(&f, "rocky-todo", "완료");
    f.store
        .create_handoff(&handoff_input(&waiting.id, "sess-1"))
        .unwrap();
    f.store
        .create_handoff(&handoff_input(&finished.id, "sess-2"))
        .unwrap();
    f.store.claim_handoff("sess-2", HandoffVia::Stop).unwrap();
    f.store
        .set_todo_status(&finished.id, StatusAction::Done, "claude-code", None)
        .unwrap();

    let (_, body) = get(&state, "/api/handoffs?open=true&board=rocky-todo").await;
    let todo_ids: Vec<&str> = body
        .as_array()
        .unwrap()
        .iter()
        .map(|h| h["todoId"].as_str().unwrap())
        .collect();
    assert_eq!(todo_ids, vec![waiting.id.as_str()]);
}

// ── doingState — GET /api/todos ──

fn started_by_session(f: &Fx, session_id: &str) -> Todo {
    let todo = create(f, "rocky-todo", "작업");
    f.store
        .create_handoff(&handoff_input(&todo.id, session_id))
        .unwrap();
    f.store.claim_handoff(session_id, HandoffVia::Stop).unwrap();
    f.store
        .set_todo_status(&todo.id, StatusAction::Start, "claude-code", None)
        .unwrap();
    todo
}

async fn doing_state_of(
    state: &Arc<rocky_todod::server::ServerState>,
    todo_id: &str,
) -> Option<String> {
    let (_, body) = get(state, "/api/todos?board=rocky-todo").await;
    body.as_array()
        .unwrap()
        .iter()
        .find(|t| t["id"] == todo_id)
        .and_then(|t| t.get("doingState"))
        .and_then(|v| v.as_str())
        .map(str::to_string)
}

#[tokio::test]
async fn doing_state_busy_session_is_live() {
    let f = fx();
    let state = rebuild(&f, |o| {
        o.sessions = Some(fixed_sessions(fixture_sessions()))
    });
    let todo = started_by_session(&f, "sess-2"); // busy
    assert_eq!(
        doing_state_of(&state, &todo.id).await.as_deref(),
        Some("live")
    );
}

#[tokio::test]
async fn doing_state_idle_session_is_idle() {
    let f = fx();
    let state = rebuild(&f, |o| {
        o.sessions = Some(fixed_sessions(fixture_sessions()))
    });
    let todo = started_by_session(&f, "sess-1"); // idle
    assert_eq!(
        doing_state_of(&state, &todo.id).await.as_deref(),
        Some("idle")
    );
}

#[tokio::test]
async fn doing_state_missing_session_is_gone() {
    let f = fx();
    let state = rebuild(&f, |o| {
        o.sessions = Some(fixed_sessions(fixture_sessions()))
    });
    let todo = started_by_session(&f, "ghost");
    assert_eq!(
        doing_state_of(&state, &todo.id).await.as_deref(),
        Some("gone")
    );
}

#[tokio::test]
async fn doing_state_unattributed_no_board_session_is_gone() {
    let f = fx();
    let state = rebuild(&f, |o| {
        o.sessions = Some(fixed_sessions(available(vec![sess(
            2,
            "/w/forses",
            "sess-2",
            "forses-90",
            "busy",
        )])))
    });
    let todo = create(&f, "rocky-todo", "x");
    f.store
        .set_todo_status(&todo.id, StatusAction::Start, "claude-code", None)
        .unwrap();
    assert_eq!(
        doing_state_of(&state, &todo.id).await.as_deref(),
        Some("gone")
    );
}

#[tokio::test]
async fn doing_state_unavailable_sessions_is_unknown() {
    let f = fx();
    let state = rebuild(&f, |o| {
        o.sessions = Some(fixed_sessions(SessionsResult::unavailable("claude 없음")))
    });
    let todo = started_by_session(&f, "sess-1");
    assert_eq!(
        doing_state_of(&state, &todo.id).await.as_deref(),
        Some("unknown")
    );
}

#[tokio::test]
async fn no_doing_skips_session_lookup() {
    let f = fx();
    let calls = Arc::new(AtomicUsize::new(0));
    let state = rebuild(&f, |o| {
        o.sessions = Some(counting(calls.clone(), fixture_sessions()))
    });
    create(&f, "rocky-todo", "그냥 todo");
    let (status, _) = get(&state, "/api/todos?board=rocky-todo").await;
    assert_eq!(status, 200);
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn non_doing_items_have_no_doing_state() {
    let f = fx();
    let state = rebuild(&f, |o| {
        o.sessions = Some(fixed_sessions(fixture_sessions()))
    });
    let plain = create(&f, "rocky-todo", "대기 항목");
    started_by_session(&f, "sess-1"); // doing 이 있어야 세션 조회가 일어난다
    let (_, body) = get(&state, "/api/todos?board=rocky-todo").await;
    let plain_out = body
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["id"] == plain.id.as_str())
        .unwrap();
    assert!(plain_out.get("doingState").is_none());
}

#[tokio::test]
async fn unknown_board_gives_empty_list_not_whole_queue() {
    let f = fx();
    let state = rebuild(&f, |o| {
        o.sessions = Some(fixed_sessions(fixture_sessions()))
    });
    let todo = create(&f, "rocky-todo", "x");
    f.store
        .create_handoff(&handoff_input(&todo.id, "sess-1"))
        .unwrap();
    let (status, body) = get(&state, "/api/handoffs?board=no-such-board").await;
    assert_eq!(status, 200);
    assert_eq!(body, json!([]));
}

#[tokio::test]
async fn unavailable_sessions_do_not_mark_stale() {
    let f = fx();
    let state = rebuild(&f, |o| {
        o.sessions = Some(fixed_sessions(SessionsResult::unavailable("claude 없음")))
    });
    let todo = create(&f, "rocky-todo", "x");
    f.store
        .create_handoff(&handoff_input(&todo.id, "sess-1"))
        .unwrap();
    let (_, body) = get(&state, "/api/handoffs?status=pending").await;
    assert_eq!(body[0]["stale"], false);
}

// ── claim 로컬 게이트 ──

#[tokio::test]
async fn claim_blocks_lan_with_404() {
    let f = fx();
    let todo = create(&f, "rocky-todo", "x");
    f.store
        .create_handoff(&handoff_input(&todo.id, "sess-1"))
        .unwrap();
    let (status, body) = call(
        &f.state,
        "POST",
        "/api/handoffs/claim",
        Some(json!({"sessionId":"sess-1","via":"stop"})),
        ReqOptions {
            peer: Some("192.168.1.20"),
            ..Default::default()
        },
    )
    .await;
    assert_eq!(status, 404); // 403 이 아니다 — 존재 자체를 숨긴다
    assert!(body["error"].as_str().unwrap().contains("not found"));
    assert!(f.store.pending_handoff_of(&todo.id).unwrap().is_some()); // 큐 소진 안 됨
}

#[tokio::test]
async fn claim_blocks_tailscale_proxy_with_404() {
    let f = fx();
    let todo = create(&f, "rocky-todo", "x");
    f.store
        .create_handoff(&handoff_input(&todo.id, "sess-1"))
        .unwrap();
    let (status, _) = call(
        &f.state,
        "POST",
        "/api/handoffs/claim",
        Some(json!({"sessionId":"sess-1","via":"stop"})),
        ReqOptions {
            headers: vec![("tailscale-user-login", "someone@example.com")],
            peer: Some("127.0.0.1"),
            ..Default::default()
        },
    )
    .await;
    assert_eq!(status, 404);
    assert!(f.store.pending_handoff_of(&todo.id).unwrap().is_some());
}

#[tokio::test]
async fn claim_accepts_local_hook() {
    let f = fx();
    let todo = create(&f, "rocky-todo", "x");
    f.store
        .create_handoff(&handoff_input(&todo.id, "sess-1"))
        .unwrap();
    let (status, body) = post(
        &f.state,
        "/api/handoffs/claim",
        json!({"sessionId":"sess-1","via":"prompt"}),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(body["handoff"]["deliveredVia"], "prompt");
}
