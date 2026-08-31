//! TS `src/server.test.ts` 포팅 4/4 — spawn 라우트 + body.path + 게이트 힌트.

mod common;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use common::*;
use rocky_todo_core::sessions::SessionsResult;
use rocky_todo_core::types::*;
use rocky_todod::server::ServerState;
use rocky_todod::sessions_exec::fixed_sessions;
use rocky_todod::spawnctl::{SpawnFailedError, SpawnFn, SpawnInput};
use serde_json::json;

fn ok_spawn() -> SpawnFn {
    Arc::new(|_input| Box::pin(async { Ok("5acaaaeb".to_string()) }))
}

fn counting_spawn(counter: Arc<AtomicUsize>) -> SpawnFn {
    Arc::new(move |_input| {
        counter.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Ok("5acaaaeb".to_string()) })
    })
}

fn failing_spawn(message: &str, started: Option<bool>) -> SpawnFn {
    let message = message.to_string();
    Arc::new(move |_input| {
        let message = message.clone();
        Box::pin(async move { Err(SpawnFailedError { message, started }) })
    })
}

/// TS `useHandle` — 세션·spawn·경로 검사·정규화 주입. realPath 기본 항등.
fn use_handle(
    f: &Fx,
    sessions: Option<SessionsResult>,
    spawn: Option<SpawnFn>,
    real_path: Option<rocky_todod::server::RealPath>,
) -> Arc<ServerState> {
    rebuild(f, |o| {
        o.sessions = Some(fixed_sessions(
            sessions.unwrap_or_else(|| available(vec![])),
        ));
        o.spawn = Some(spawn.unwrap_or_else(ok_spawn));
        o.path_exists = Some(Arc::new(|_| true));
        o.real_path = Some(real_path.unwrap_or_else(|| Arc::new(|p| Ok(p.to_string()))));
    })
}

/// 경로가 설정된 보드 + todo 하나.
fn seed(f: &Fx) -> Todo {
    f.store.ensure_board("rocky-todo", None, "logan").unwrap();
    f.store
        .set_board_path("rocky-todo", "/repo", "logan")
        .unwrap();
    f.store
        .create_todo(
            &CreateTodoInput {
                board: "rocky-todo".into(),
                title: "세션 띄우기".into(),
                ..Default::default()
            },
            "logan",
        )
        .unwrap()
}

fn handoffs_of(f: &Fx, todo_id: &str) -> Vec<Handoff> {
    f.store
        .list_handoffs(&ListHandoffsFilter {
            todo_id: Some(todo_id.to_string()),
            ..Default::default()
        })
        .unwrap()
}

#[tokio::test]
async fn missing_board_path_is_400() {
    let f = fx();
    let state = use_handle(&f, None, None, None);
    let todo = f
        .store
        .create_todo(
            &CreateTodoInput {
                board: "rocky-todo".into(),
                title: "x".into(),
                ..Default::default()
            },
            "logan",
        )
        .unwrap();
    let (status, body) = call(
        &state,
        "POST",
        &format!("/api/todos/{}/spawn", todo.id),
        None,
        ReqOptions::default(),
    )
    .await;
    assert_eq!(status, 400);
    assert!(body["error"].as_str().unwrap().contains("경로가 없다"));
}

#[tokio::test]
async fn non_local_spawn_is_403() {
    let f = fx();
    let state = use_handle(&f, None, None, None);
    let todo = seed(&f);
    let (status, _) = call(
        &state,
        "POST",
        &format!("/api/todos/{}/spawn", todo.id),
        None,
        ReqOptions {
            peer: Some("192.168.1.20"),
            ..Default::default()
        },
    )
    .await;
    assert_eq!(status, 403);
}

#[tokio::test]
async fn not_a_git_worktree_is_400() {
    let f = fx();
    let state = rebuild(&f, |o| {
        o.sessions = Some(fixed_sessions(available(vec![])));
        o.spawn = Some(ok_spawn());
        o.path_exists = Some(Arc::new(|_| false));
        o.real_path = Some(Arc::new(|p| Ok(p.to_string())));
    });
    let todo = seed(&f);
    let (status, body) = call(
        &state,
        "POST",
        &format!("/api/todos/{}/spawn", todo.id),
        None,
        ReqOptions::default(),
    )
    .await;
    assert_eq!(status, 400);
    assert!(body["error"]
        .as_str()
        .unwrap()
        .contains("git 워크트리가 아니다"));
}

#[tokio::test]
async fn spawns_new_session_and_records_via_spawn() {
    let f = fx();
    let state = use_handle(&f, None, None, None);
    let todo = seed(&f);
    let (status, body) = post(
        &state,
        &format!("/api/todos/{}/spawn", todo.id),
        json!({"note":"테스트부터"}),
    )
    .await;
    assert_eq!(status, 201, "{body}");
    assert_eq!(body["reused"], false);
    assert_eq!(body["sessionShortId"], "5acaaaeb");
    assert_eq!(
        body["worktreePath"],
        format!("/repo/.claude/worktrees/todo-{}", todo.number)
    );
    assert_eq!(body["handoff"]["deliveredVia"], "spawn");
    assert_eq!(body["handoff"]["status"], "delivered");
}

#[tokio::test]
async fn live_session_at_worktree_queues_instead_of_spawn() {
    let f = fx();
    f.store.ensure_board("rocky-todo", None, "logan").unwrap();
    f.store
        .set_board_path("rocky-todo", "/repo", "logan")
        .unwrap();
    let todo = f
        .store
        .create_todo(
            &CreateTodoInput {
                board: "rocky-todo".into(),
                title: "x".into(),
                ..Default::default()
            },
            "logan",
        )
        .unwrap();
    let mut live = sess(
        1,
        &format!("/repo/.claude/worktrees/todo-{}", todo.number),
        "live-session-uuid",
        "rocky-todo-live",
        "busy",
    );
    live.kind = "background".into();
    live.state = Some("working".into());
    let state = use_handle(
        &f,
        Some(available(vec![live])),
        Some(failing_spawn(
            "살아있는 세션이 있으면 spawn 하면 안 된다",
            Some(false),
        )),
        None,
    );
    let (status, body) = call(
        &state,
        "POST",
        &format!("/api/todos/{}/spawn", todo.id),
        None,
        ReqOptions::default(),
    )
    .await;
    assert_eq!(status, 201, "{body}");
    assert_eq!(body["reused"], true);
    assert_eq!(body["handoff"]["status"], "pending");
    assert_eq!(body["handoff"]["sessionId"], "live-session-uuid");
    assert!(body.get("sessionShortId").is_none());
}

#[tokio::test]
async fn failed_spawn_is_400_with_no_delivery_record() {
    let f = fx();
    let state = use_handle(
        &f,
        None,
        Some(failing_spawn(
            "세션을 띄우지 못했다 — claude: command not found",
            Some(false),
        )),
        None,
    );
    let todo = seed(&f);
    let (status, _) = call(
        &state,
        "POST",
        &format!("/api/todos/{}/spawn", todo.id),
        None,
        ReqOptions::default(),
    )
    .await;
    assert_eq!(status, 400);
    assert!(handoffs_of(&f, &todo.id).is_empty());
}

#[tokio::test]
async fn existing_pending_is_409() {
    let f = fx();
    let state = use_handle(&f, None, None, None);
    let todo = seed(&f);
    f.store
        .create_handoff(&CreateHandoffInput {
            todo_ref: todo.id.clone(),
            session_id: "other-session".into(),
            session_name: None,
            session_cwd: None,
            note: None,
            actor: "logan".into(),
            current_board_id: None,
        })
        .unwrap();
    let (status, _) = call(
        &state,
        "POST",
        &format!("/api/todos/{}/spawn", todo.id),
        None,
        ReqOptions::default(),
    )
    .await;
    assert_eq!(status, 409);
}

#[tokio::test]
async fn unknown_todo_is_404() {
    let f = fx();
    let state = use_handle(&f, None, None, None);
    let (status, _) = call(
        &state,
        "POST",
        "/api/todos/nope/spawn",
        None,
        ReqOptions::default(),
    )
    .await;
    assert_eq!(status, 404);
}

#[tokio::test]
async fn archived_todo_is_400_and_no_spawn() {
    let f = fx();
    let calls = Arc::new(AtomicUsize::new(0));
    let state = use_handle(&f, None, Some(counting_spawn(calls.clone())), None);
    let todo = seed(&f);
    f.store
        .set_todo_status(&todo.id, StatusAction::Archive, "logan", None)
        .unwrap();
    let (status, body) = call(
        &state,
        "POST",
        &format!("/api/todos/{}/spawn", todo.id),
        None,
        ReqOptions::default(),
    )
    .await;
    assert_eq!(status, 400);
    assert!(body["error"].as_str().unwrap().contains("archived"));
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert!(handoffs_of(&f, &todo.id).is_empty());
}

#[tokio::test]
async fn unavailable_sessions_is_409_like_handoff() {
    let f = fx();
    let state = use_handle(
        &f,
        Some(SessionsResult::unavailable("claude CLI 를 실행할 수 없다")),
        None,
        None,
    );
    let todo = seed(&f);
    let (status, body) = call(
        &state,
        "POST",
        &format!("/api/todos/{}/spawn", todo.id),
        None,
        ReqOptions::default(),
    )
    .await;
    assert_eq!(status, 409);
    assert!(body["error"].as_str().unwrap().contains("claude CLI"));

    let (status, _) = post(
        &state,
        &format!("/api/todos/{}/handoff", todo.id),
        json!({}),
    )
    .await;
    assert_eq!(status, 409);
}

#[tokio::test]
async fn concurrent_requests_spawn_only_once() {
    // 예약(remember)이 await 앞에 있어야 한다 — 뒤로 밀리면 둘 다 게이트를 통과한다.
    // 첫 요청의 spawn 이 50ms 걸리는 동안 10ms 시점의 두 번째 요청이 409 를 받아야 한다.
    let f = fx();
    let calls = Arc::new(AtomicUsize::new(0));
    let spawn: SpawnFn = {
        let calls = calls.clone();
        Arc::new(move |_input: SpawnInput| {
            calls.fetch_add(1, Ordering::SeqCst);
            Box::pin(async move {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                Ok("5acaaaeb".to_string())
            })
        })
    };
    let state = use_handle(&f, None, Some(spawn), None);
    let todo = seed(&f);

    let path = format!("/api/todos/{}/spawn", todo.id);
    let first = call(&state, "POST", &path, None, ReqOptions::default());
    let second = async {
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        call(&state, "POST", &path, None, ReqOptions::default()).await
    };
    let (first, second) = tokio::join!(first, second);
    let mut statuses = [first.0, second.0];
    statuses.sort();
    assert_eq!(statuses, [201, 409]);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(handoffs_of(&f, &todo.id).len(), 1);
}

#[tokio::test]
async fn definitely_failed_spawn_releases_reservation() {
    let f = fx();
    let calls = Arc::new(AtomicUsize::new(0));
    let spawn: SpawnFn = {
        let calls = calls.clone();
        Arc::new(move |_input: SpawnInput| {
            let n = calls.fetch_add(1, Ordering::SeqCst);
            Box::pin(async move {
                if n == 0 {
                    Err(SpawnFailedError {
                        message: "세션을 띄우지 못했다 — claude: command not found".into(),
                        started: Some(false),
                    })
                } else {
                    Ok("5acaaaeb".to_string())
                }
            })
        })
    };
    let state = use_handle(&f, None, Some(spawn), None);
    let todo = seed(&f);

    let (status, body) = call(
        &state,
        "POST",
        &format!("/api/todos/{}/spawn", todo.id),
        None,
        ReqOptions::default(),
    )
    .await;
    assert_eq!(status, 400);
    assert!(body["error"].as_str().unwrap().contains("띄우지 못했다"));
    let (status, _) = call(
        &state,
        "POST",
        &format!("/api/todos/{}/spawn", todo.id),
        None,
        ReqOptions::default(),
    )
    .await;
    assert_eq!(status, 201);
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert_eq!(handoffs_of(&f, &todo.id).len(), 1);
}

#[tokio::test]
async fn unknown_outcome_failure_keeps_reservation() {
    let f = fx();
    let calls = Arc::new(AtomicUsize::new(0));
    let spawn: SpawnFn = {
        let calls = calls.clone();
        Arc::new(move |_input: SpawnInput| {
            calls.fetch_add(1, Ordering::SeqCst);
            Box::pin(async {
                Err(SpawnFailedError {
                    message: "세션이 떴는지 확인할 수 없다 — claude agents 로 확인하라".into(),
                    started: None,
                })
            })
        })
    };
    let state = use_handle(&f, None, Some(spawn), None);
    let todo = seed(&f);

    let (status, body) = call(
        &state,
        "POST",
        &format!("/api/todos/{}/spawn", todo.id),
        None,
        ReqOptions::default(),
    )
    .await;
    assert_eq!(status, 400);
    assert!(body["error"].as_str().unwrap().contains("확인할 수 없다"));

    let (status, body) = call(
        &state,
        "POST",
        &format!("/api/todos/{}/spawn", todo.id),
        None,
        ReqOptions::default(),
    )
    .await;
    assert_eq!(status, 409);
    assert!(body["error"].as_str().unwrap().contains("방금 이 워크트리"));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(handoffs_of(&f, &todo.id).is_empty());
}

#[tokio::test]
async fn relative_board_path_is_400() {
    let f = fx();
    let state = use_handle(&f, None, None, None);
    f.store.ensure_board("rocky-todo", None, "logan").unwrap();
    f.store
        .set_board_path("rocky-todo", "repo", "logan")
        .unwrap();
    let todo = f
        .store
        .create_todo(
            &CreateTodoInput {
                board: "rocky-todo".into(),
                title: "x".into(),
                ..Default::default()
            },
            "logan",
        )
        .unwrap();
    let (status, body) = call(
        &state,
        "POST",
        &format!("/api/todos/{}/spawn", todo.id),
        None,
        ReqOptions::default(),
    )
    .await;
    assert_eq!(status, 400);
    assert!(body["error"].as_str().unwrap().contains("절대경로"));
}

#[tokio::test]
async fn normalized_path_used_for_worktree_and_cwd() {
    let f = fx();
    let seen = Arc::new(Mutex::new(String::new()));
    let spawn: SpawnFn = {
        let seen = seen.clone();
        Arc::new(move |input: SpawnInput| {
            *seen.lock().unwrap() = input.board_path.clone();
            Box::pin(async { Ok("5acaaaeb".to_string()) })
        })
    };
    let real_path: rocky_todod::server::RealPath = Arc::new(|p| {
        Ok(if p == "/link/repo" {
            "/real/repo".into()
        } else {
            p.to_string()
        })
    });
    let state = use_handle(&f, None, Some(spawn), Some(real_path));
    f.store.ensure_board("rocky-todo", None, "logan").unwrap();
    f.store
        .set_board_path("rocky-todo", "/link/repo", "logan")
        .unwrap();
    let todo = f
        .store
        .create_todo(
            &CreateTodoInput {
                board: "rocky-todo".into(),
                title: "x".into(),
                ..Default::default()
            },
            "logan",
        )
        .unwrap();
    let (status, body) = call(
        &state,
        "POST",
        &format!("/api/todos/{}/spawn", todo.id),
        None,
        ReqOptions::default(),
    )
    .await;
    assert_eq!(status, 201);
    assert_eq!(*seen.lock().unwrap(), "/real/repo");
    assert_eq!(
        body["worktreePath"],
        format!("/real/repo/.claude/worktrees/todo-{}", todo.number)
    );
}

#[tokio::test]
async fn normalized_path_makes_concurrency_guard_hold() {
    let f = fx();
    f.store.ensure_board("rocky-todo", None, "logan").unwrap();
    f.store
        .set_board_path("rocky-todo", "/link/repo", "logan")
        .unwrap();
    let todo = f
        .store
        .create_todo(
            &CreateTodoInput {
                board: "rocky-todo".into(),
                title: "x".into(),
                ..Default::default()
            },
            "logan",
        )
        .unwrap();
    let mut live = sess(
        1,
        &format!("/real/repo/.claude/worktrees/todo-{}", todo.number),
        "live-session-uuid",
        "rocky-todo-live",
        "busy",
    );
    live.kind = "background".into();
    live.state = Some("working".into());
    let real_path: rocky_todod::server::RealPath = Arc::new(|p| {
        Ok(if p == "/link/repo" {
            "/real/repo".into()
        } else {
            p.to_string()
        })
    });
    let state = use_handle(
        &f,
        Some(available(vec![live])),
        Some(failing_spawn(
            "실경로가 같으면 가드가 걸려야 한다",
            Some(false),
        )),
        Some(real_path),
    );
    let (status, body) = call(
        &state,
        "POST",
        &format!("/api/todos/{}/spawn", todo.id),
        None,
        ReqOptions::default(),
    )
    .await;
    assert_eq!(status, 201);
    assert_eq!(body["reused"], true);
}

#[tokio::test]
async fn realpath_failure_is_400() {
    let f = fx();
    let real_path: rocky_todod::server::RealPath =
        Arc::new(|_| Err(std::io::Error::new(std::io::ErrorKind::NotFound, "ENOENT")));
    let state = use_handle(&f, None, None, Some(real_path));
    let todo = seed(&f);
    let (status, body) = call(
        &state,
        "POST",
        &format!("/api/todos/{}/spawn", todo.id),
        None,
        ReqOptions::default(),
    )
    .await;
    assert_eq!(status, 400);
    assert!(body["error"]
        .as_str()
        .unwrap()
        .contains("경로를 찾을 수 없다"));
}

// ── body.path (실패해도 저장되면 안 된다) ──

fn board_path_of(f: &Fx) -> Option<String> {
    f.store.get_board("rocky-todo").unwrap().unwrap().path
}

#[tokio::test]
async fn body_path_spawns_at_that_path() {
    let f = fx();
    let seen = Arc::new(Mutex::new(String::new()));
    let spawn: SpawnFn = {
        let seen = seen.clone();
        Arc::new(move |input: SpawnInput| {
            *seen.lock().unwrap() = input.board_path.clone();
            Box::pin(async { Ok("5acaaaeb".to_string()) })
        })
    };
    let state = use_handle(&f, None, Some(spawn), None);
    let todo = f
        .store
        .create_todo(
            &CreateTodoInput {
                board: "rocky-todo".into(),
                title: "x".into(),
                ..Default::default()
            },
            "logan",
        )
        .unwrap();
    let (status, _) = post(
        &state,
        &format!("/api/todos/{}/spawn", todo.id),
        json!({"path":"/given/repo"}),
    )
    .await;
    assert_eq!(status, 201);
    assert_eq!(*seen.lock().unwrap(), "/given/repo");
}

#[tokio::test]
async fn failed_spawn_does_not_persist_body_path() {
    let f = fx();
    let state = use_handle(&f, None, Some(failing_spawn("실패", Some(false))), None);
    f.store.ensure_board("rocky-todo", None, "logan").unwrap();
    let todo = f
        .store
        .create_todo(
            &CreateTodoInput {
                board: "rocky-todo".into(),
                title: "x".into(),
                ..Default::default()
            },
            "logan",
        )
        .unwrap();
    let (status, _) = post(
        &state,
        &format!("/api/todos/{}/spawn", todo.id),
        json!({"path":"/typo/repo"}),
    )
    .await;
    assert_eq!(status, 400);
    assert_eq!(board_path_of(&f), None);
}

#[tokio::test]
async fn successful_spawn_persists_body_path() {
    let f = fx();
    let state = use_handle(&f, None, None, None);
    f.store.ensure_board("rocky-todo", None, "logan").unwrap();
    let todo = f
        .store
        .create_todo(
            &CreateTodoInput {
                board: "rocky-todo".into(),
                title: "x".into(),
                ..Default::default()
            },
            "logan",
        )
        .unwrap();
    let (status, _) = post(
        &state,
        &format!("/api/todos/{}/spawn", todo.id),
        json!({"path":"/given/repo"}),
    )
    .await;
    assert_eq!(status, 201);
    assert_eq!(board_path_of(&f).as_deref(), Some("/given/repo"));
}

#[tokio::test]
async fn reused_branch_also_persists_body_path() {
    let f = fx();
    f.store.ensure_board("rocky-todo", None, "logan").unwrap();
    let todo = f
        .store
        .create_todo(
            &CreateTodoInput {
                board: "rocky-todo".into(),
                title: "x".into(),
                ..Default::default()
            },
            "logan",
        )
        .unwrap();
    let mut live = sess(
        1,
        &format!("/given/repo/.claude/worktrees/todo-{}", todo.number),
        "live-session-uuid",
        "rocky-todo-live",
        "busy",
    );
    live.kind = "background".into();
    live.state = Some("working".into());
    let state = use_handle(
        &f,
        Some(available(vec![live])),
        Some(failing_spawn("재사용이어야 한다", Some(false))),
        None,
    );
    let (status, body) = post(
        &state,
        &format!("/api/todos/{}/spawn", todo.id),
        json!({"path":"/given/repo"}),
    )
    .await;
    assert_eq!(status, 201);
    assert_eq!(body["reused"], true);
    assert_eq!(board_path_of(&f).as_deref(), Some("/given/repo"));
}

#[tokio::test]
async fn existing_board_path_used_without_body_path() {
    let f = fx();
    let state = use_handle(&f, None, None, None);
    let todo = seed(&f); // path=/repo
    let (status, body) = call(
        &state,
        "POST",
        &format!("/api/todos/{}/spawn", todo.id),
        None,
        ReqOptions::default(),
    )
    .await;
    assert_eq!(status, 201);
    assert_eq!(
        body["worktreePath"],
        format!("/repo/.claude/worktrees/todo-{}", todo.number)
    );
}

#[tokio::test]
async fn board_stores_normalized_path() {
    let f = fx();
    let real_path: rocky_todod::server::RealPath = Arc::new(|p| {
        Ok(if p == "/link/repo" {
            "/real/repo".into()
        } else {
            p.to_string()
        })
    });
    let state = use_handle(&f, None, None, Some(real_path));
    f.store.ensure_board("rocky-todo", None, "logan").unwrap();
    let todo = f
        .store
        .create_todo(
            &CreateTodoInput {
                board: "rocky-todo".into(),
                title: "x".into(),
                ..Default::default()
            },
            "logan",
        )
        .unwrap();
    let (status, _) = post(
        &state,
        &format!("/api/todos/{}/spawn", todo.id),
        json!({"path":"/link/repo"}),
    )
    .await;
    assert_eq!(status, 201);
    assert_eq!(board_path_of(&f).as_deref(), Some("/real/repo"));
}

#[tokio::test]
async fn relative_body_path_is_400_and_not_persisted() {
    let f = fx();
    let state = use_handle(&f, None, None, None);
    f.store.ensure_board("rocky-todo", None, "logan").unwrap();
    let todo = f
        .store
        .create_todo(
            &CreateTodoInput {
                board: "rocky-todo".into(),
                title: "x".into(),
                ..Default::default()
            },
            "logan",
        )
        .unwrap();
    let (status, _) = post(
        &state,
        &format!("/api/todos/{}/spawn", todo.id),
        json!({"path":"relative/repo"}),
    )
    .await;
    assert_eq!(status, 400);
    assert_eq!(board_path_of(&f), None);
}

#[tokio::test]
async fn non_string_body_path_is_400() {
    let f = fx();
    let state = use_handle(&f, None, None, None);
    let todo = seed(&f);
    let (status, _) = post(
        &state,
        &format!("/api/todos/{}/spawn", todo.id),
        json!({"path": 123}),
    )
    .await;
    assert_eq!(status, 400);
}

#[tokio::test]
async fn blank_body_path_is_400() {
    let f = fx();
    let state = use_handle(&f, None, None, None);
    let todo = seed(&f);
    let (status, _) = post(
        &state,
        &format!("/api/todos/{}/spawn", todo.id),
        json!({"path":"  "}),
    )
    .await;
    assert_eq!(status, 400);
}

#[tokio::test]
async fn health_reports_spawn_allowed() {
    let f = fx();
    let (_, local) = get(&f.state, "/api/health").await;
    assert_eq!(local["spawnAllowed"], true);
    let (_, remote) = call(
        &f.state,
        "GET",
        "/api/health",
        None,
        ReqOptions {
            peer: Some("192.168.1.20"),
            ..Default::default()
        },
    )
    .await;
    assert_eq!(remote["spawnAllowed"], false);
}
