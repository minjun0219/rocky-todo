//! TS `src/mcp.test.ts` 포팅 — InMemoryTransport 대신 **실제 HTTP JSON-RPC 표면**으로
//! 검증한다(rmcp stateless 통합까지 함께 커버).

mod common;

use std::sync::Arc;

use axum::body::Body;
use axum::extract::connect_info::ConnectInfo;
use axum::http::Request;
use common::{fx, rebuild, Fx};
use rocky_todod::daemon::build_router;
use rocky_todod::runner::{CmdOutput, Runner};
use rocky_todod::server::ServerState;
use serde_json::{json, Value};
use tower::ServiceExt;

const TOOLS: [&str; 5] = [
    "todo_list",
    "todo_write",
    "todo_status",
    "note_list",
    "note_write",
];

async fn rpc(
    state: &Arc<ServerState>,
    peer: &str,
    body: Value,
    extra_headers: &[(&str, &str)],
) -> Value {
    let router = build_router(state.clone(), None);
    let mut builder = Request::builder()
        .method("POST")
        .uri("http://127.0.0.1:8636/mcp")
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream");
    for (name, value) in extra_headers {
        builder = builder.header(*name, *value);
    }
    let mut request = builder.body(Body::from(body.to_string())).unwrap();
    request
        .extensions_mut()
        .insert(ConnectInfo(std::net::SocketAddr::from((
            peer.parse::<std::net::IpAddr>().unwrap(),
            50000,
        ))));
    let response = router.oneshot(request).await.unwrap();
    let status = response.status().as_u16();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let text = String::from_utf8_lossy(&bytes).to_string();
    serde_json::from_str(&text).unwrap_or(json!({"httpStatus": status, "raw": text}))
}

/// tools/call 한 번 → (isError, content[0].text 의 JSON 또는 원문 텍스트).
async fn tool_call(state: &Arc<ServerState>, peer: &str, name: &str, args: Value) -> (bool, Value) {
    let envelope = rpc(
        state,
        peer,
        json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":name,"arguments":args}}),
        &[],
    )
    .await;
    let result = &envelope["result"];
    assert!(
        !result.is_null(),
        "프로토콜 에러가 아니어야 한다: {envelope}"
    );
    let is_error = result["isError"] == json!(true);
    let text = result["content"][0]["text"].as_str().unwrap_or_default();
    let value = serde_json::from_str(text).unwrap_or(Value::String(text.to_string()));
    (is_error, value)
}

async fn ok_call(state: &Arc<ServerState>, name: &str, args: Value) -> Value {
    let (is_error, value) = tool_call(state, "127.0.0.1", name, args).await;
    assert!(!is_error, "{value}");
    value
}

async fn err_call(state: &Arc<ServerState>, name: &str, args: Value) -> String {
    let (is_error, value) = tool_call(state, "127.0.0.1", name, args).await;
    assert!(is_error, "{value}");
    value.as_str().unwrap().to_string()
}

async fn list_tools(state: &Arc<ServerState>) -> Vec<Value> {
    let envelope = rpc(
        state,
        "127.0.0.1",
        json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}),
        &[],
    )
    .await;
    envelope["result"]["tools"].as_array().unwrap().clone()
}

fn ok_gh(f: &Fx) -> Arc<ServerState> {
    let runner: Runner = Arc::new(|_c, _s, _t| {
        Box::pin(async {
            CmdOutput {
                code: 0,
                stdout: "https://github.com/o/n/issues/7\n".into(),
                stderr: String::new(),
            }
        })
    });
    rebuild(f, |o| o.gh_runner = Some(runner))
}

// ── surface ──

#[tokio::test]
async fn exactly_five_compact_tools() {
    let f = fx();
    let mut names: Vec<String> = list_tools(&f.state)
        .await
        .iter()
        .map(|t| t["name"].as_str().unwrap().to_string())
        .collect();
    names.sort();
    let mut expected: Vec<String> = TOOLS.iter().map(|s| s.to_string()).collect();
    expected.sort();
    assert_eq!(names, expected);
}

#[tokio::test]
async fn note_descriptions_explain_global_bare_number() {
    let f = fx();
    let tools = list_tools(&f.state).await;
    for name in ["note_list", "note_write"] {
        let tool = tools.iter().find(|t| t["name"] == name).unwrap();
        let description = tool["description"].as_str().unwrap();
        assert!(description.contains("생략"), "{name}");
        assert!(
            description.contains("note-N") || description.contains("note-3"),
            "{name}"
        );
    }
}

// ── round trips ──

#[tokio::test]
async fn create_list_detail_status_round_trip() {
    let f = fx();
    let created = ok_call(
        &f.state,
        "todo_write",
        json!({"board":"rocky","title":"엠씨피","priority":"p2","actor":"claude-code"}),
    )
    .await;
    assert_eq!(created["title"], "엠씨피");
    assert_eq!(created["priority"], "p2");
    let id = created["id"].as_str().unwrap();

    let listed = ok_call(&f.state, "todo_list", json!({"board":"rocky"})).await;
    assert_eq!(listed["todos"].as_array().unwrap().len(), 1);

    let detail = ok_call(&f.state, "todo_list", json!({"id": id})).await;
    assert_eq!(detail["todo"]["id"], created["id"]);
    assert!(detail["history"].as_array().is_some());

    let started = ok_call(
        &f.state,
        "todo_status",
        json!({"id": id, "action":"start","actor":"claude-code"}),
    )
    .await;
    assert_eq!(started["status"], "doing");
    assert_eq!(started["doingBy"], "claude-code");
}

#[tokio::test]
async fn todo_write_with_id_patches() {
    let f = fx();
    let created = ok_call(
        &f.state,
        "todo_write",
        json!({"board":"rocky","title":"이전"}),
    )
    .await;
    let id = created["id"].as_str().unwrap();
    let patched = ok_call(
        &f.state,
        "todo_write",
        json!({"id": id, "title":"이후","priority":"p1"}),
    )
    .await;
    assert_eq!(patched["title"], "이후");
    assert_eq!(patched["priority"], "p1");
}

#[tokio::test]
async fn boards_flag_returns_board_list() {
    let f = fx();
    ok_call(&f.state, "todo_write", json!({"board":"rocky","title":"x"})).await;
    let boards = ok_call(&f.state, "todo_list", json!({"boards": true})).await;
    assert_eq!(boards["boards"][0]["key"], "rocky");
}

#[tokio::test]
async fn errors_surface_as_is_error_result() {
    let f = fx();
    let message = err_call(&f.state, "todo_list", json!({"id":"nosuchid"})).await;
    assert!(message.contains("todo not found"));
}

// ── number / ref 참조 문법 ──

#[tokio::test]
async fn write_carries_number_and_scoped_ref_detail_works() {
    let f = fx();
    let created = ok_call(&f.state, "todo_write", json!({"board":"rocky","title":"x"})).await;
    assert_eq!(created["number"], 1);
    let detail = ok_call(&f.state, "todo_list", json!({"id":"rocky#1"})).await;
    assert_eq!(detail["todo"]["id"], created["id"]);
    let dashed = ok_call(&f.state, "todo_list", json!({"id":"rocky-1"})).await;
    assert_eq!(dashed["todo"]["id"], created["id"]);
}

#[tokio::test]
async fn status_accepts_scoped_ref() {
    let f = fx();
    ok_call(&f.state, "todo_write", json!({"board":"rocky","title":"x"})).await;
    let started = ok_call(
        &f.state,
        "todo_status",
        json!({"id":"rocky#1","action":"start"}),
    )
    .await;
    assert_eq!(started["status"], "doing");
}

#[tokio::test]
async fn bare_number_without_board_is_error_not_crash() {
    let f = fx();
    ok_call(&f.state, "todo_write", json!({"board":"rocky","title":"x"})).await;
    let message = err_call(&f.state, "todo_list", json!({"id":"1"})).await;
    assert!(message.contains("board"), "{message}");
}

#[tokio::test]
async fn note_write_carries_number_and_scoped_ref() {
    let f = fx();
    let note = ok_call(
        &f.state,
        "note_write",
        json!({"board":"rocky","title":"메모"}),
    )
    .await;
    assert_eq!(note["number"], 1);
    let detail = ok_call(&f.state, "note_list", json!({"id":"rocky#1"})).await;
    assert_eq!(detail["note"]["id"], note["id"]);
}

#[tokio::test]
async fn bare_number_with_board_resolves_across_tools() {
    let f = fx();
    let todo = ok_call(&f.state, "todo_write", json!({"board":"rocky","title":"x"})).await;
    // todo_list
    let detail = ok_call(&f.state, "todo_list", json!({"id":"#1","board":"rocky"})).await;
    assert_eq!(detail["todo"]["id"], todo["id"]);
    // todo_write patch
    let patched = ok_call(
        &f.state,
        "todo_write",
        json!({"id":"#1","board":"rocky","title":"고침"}),
    )
    .await;
    assert_eq!(patched["id"], todo["id"]);
    // todo_status
    let started = ok_call(
        &f.state,
        "todo_status",
        json!({"id":"#1","board":"rocky","action":"start"}),
    )
    .await;
    assert_eq!(started["id"], todo["id"]);
    // notes
    let note = ok_call(
        &f.state,
        "note_write",
        json!({"board":"rocky","title":"메모"}),
    )
    .await;
    let note_detail = ok_call(&f.state, "note_list", json!({"id":"#1","board":"rocky"})).await;
    assert_eq!(note_detail["note"]["id"], note["id"]);
    let edited = ok_call(
        &f.state,
        "note_write",
        json!({"id":"#1","board":"rocky","content":"수정","mode":"set"}),
    )
    .await;
    assert_eq!(edited["id"], note["id"]);
}

#[tokio::test]
async fn note_write_bare_number_without_board_hits_global_space() {
    let f = fx();
    // 전역 메모가 없으니 not found — 크래시가 아니라 isError.
    let message = err_call(&f.state, "note_write", json!({"id":"1","content":"x"})).await;
    assert!(message.contains("note not found"), "{message}");
}

#[tokio::test]
async fn unknown_board_key_surfaces_store_error() {
    let f = fx();
    ok_call(&f.state, "todo_write", json!({"board":"rocky","title":"x"})).await;
    let message = err_call(&f.state, "todo_list", json!({"id":"1","board":"no-such"})).await;
    assert!(message.contains("unknown board"), "{message}");
}

#[tokio::test]
async fn note_tools_do_not_silently_fall_back_to_global() {
    let f = fx();
    ok_call(&f.state, "note_write", json!({"title":"전역 메모"})).await; // note-1
    let message = err_call(
        &f.state,
        "note_list",
        json!({"id":"1","board":"typo-board"}),
    )
    .await;
    assert!(message.contains("unknown board"), "{message}");
    let message = err_call(
        &f.state,
        "note_write",
        json!({"id":"1","board":"typo-board","content":"x"}),
    )
    .await;
    assert!(message.contains("unknown board"), "{message}");
}

#[tokio::test]
async fn scoped_and_id_refs_survive_unknown_board_arg() {
    let f = fx();
    let todo = ok_call(&f.state, "todo_write", json!({"board":"rocky","title":"x"})).await;
    let id = todo["id"].as_str().unwrap();
    // scoped
    let detail = ok_call(
        &f.state,
        "todo_list",
        json!({"id":"rocky#1","board":"not-a-board"}),
    )
    .await;
    assert_eq!(detail["todo"]["id"], todo["id"]);
    // raw id
    let detail = ok_call(
        &f.state,
        "todo_list",
        json!({"id": id, "board":"not-a-board"}),
    )
    .await;
    assert_eq!(detail["todo"]["id"], todo["id"]);
    // id prefix
    let prefix = common::id_prefix(id);
    let detail = ok_call(
        &f.state,
        "todo_list",
        json!({"id": prefix, "board":"not-a-board"}),
    )
    .await;
    assert_eq!(detail["todo"]["id"], todo["id"]);
    // 맨숫자는 여전히 에러 (wrong-row 보호)
    let message = err_call(
        &f.state,
        "todo_list",
        json!({"id":"1","board":"not-a-board"}),
    )
    .await;
    assert!(message.contains("unknown board"));
}

#[tokio::test]
async fn bare_todo_ref_without_board_says_context_required() {
    let f = fx();
    ok_call(&f.state, "todo_write", json!({"board":"rocky","title":"x"})).await;
    let message = err_call(&f.state, "todo_list", json!({"id":"1"})).await;
    assert!(message.contains("board context required"), "{message}");
}

#[tokio::test]
async fn global_note_bare_number_resolves_without_board() {
    let f = fx();
    let note = ok_call(&f.state, "note_write", json!({"title":"전역"})).await;
    let detail = ok_call(&f.state, "note_list", json!({"id":"#1"})).await;
    assert_eq!(detail["note"]["id"], note["id"]);
}

// ── ref 직렬화 ──

#[tokio::test]
async fn write_response_carries_ref() {
    let f = fx();
    let created = ok_call(&f.state, "todo_write", json!({"board":"rocky","title":"x"})).await;
    assert_eq!(created["ref"], "rocky-1");
}

#[tokio::test]
async fn same_number_on_two_boards_distinguished_by_ref() {
    let f = fx();
    let a = ok_call(&f.state, "todo_write", json!({"board":"alpha","title":"a"})).await;
    let b = ok_call(&f.state, "todo_write", json!({"board":"beta","title":"b"})).await;
    assert_eq!(a["number"], b["number"]);
    assert_eq!(a["ref"], "alpha-1");
    assert_eq!(b["ref"], "beta-1");
}

#[tokio::test]
async fn detail_and_status_responses_carry_ref() {
    let f = fx();
    let created = ok_call(&f.state, "todo_write", json!({"board":"rocky","title":"x"})).await;
    let id = created["id"].as_str().unwrap();
    let detail = ok_call(&f.state, "todo_list", json!({"id": id})).await;
    assert_eq!(detail["todo"]["ref"], "rocky-1");
    let started = ok_call(&f.state, "todo_status", json!({"id": id, "action":"start"})).await;
    assert_eq!(started["ref"], "rocky-1");
}

#[tokio::test]
async fn board_note_vs_global_note_refs() {
    let f = fx();
    let board_note = ok_call(
        &f.state,
        "note_write",
        json!({"board":"rocky","title":"보드"}),
    )
    .await;
    assert_eq!(board_note["ref"], "rocky-1");
    let global_note = ok_call(&f.state, "note_write", json!({"title":"글로벌"})).await;
    assert_eq!(global_note["ref"], "note-1");
}

// ── comments through MCP ──

fn history_actions(f: &Fx, todo_id: &str) -> Vec<String> {
    f.store
        .list_history(&rocky_todo_core::types::ListHistoryFilter {
            entity_id: Some(todo_id.to_string()),
            ..Default::default()
        })
        .unwrap()
        .into_iter()
        .map(|h| h.action)
        .collect()
}

#[tokio::test]
async fn comment_only_write_creates_no_update_history() {
    let f = fx();
    let created = ok_call(&f.state, "todo_write", json!({"board":"rocky","title":"x"})).await;
    let id = created["id"].as_str().unwrap();
    ok_call(
        &f.state,
        "todo_write",
        json!({"id": id, "comment":"진행 보고"}),
    )
    .await;
    let actions = history_actions(&f, id);
    assert!(actions.contains(&"comment".to_string()));
    assert!(!actions.contains(&"update".to_string()));
}

#[tokio::test]
async fn patch_and_comment_in_same_call() {
    let f = fx();
    let created = ok_call(&f.state, "todo_write", json!({"board":"rocky","title":"x"})).await;
    let id = created["id"].as_str().unwrap();
    let patched = ok_call(
        &f.state,
        "todo_write",
        json!({"id": id, "title":"고침","comment":"이유"}),
    )
    .await;
    assert_eq!(patched["title"], "고침");
    let actions = history_actions(&f, id);
    assert!(actions.contains(&"update".to_string()));
    assert!(actions.contains(&"comment".to_string()));
    assert_eq!(f.store.list_comments(id, false).unwrap().len(), 1);
}

#[tokio::test]
async fn create_with_first_comment() {
    let f = fx();
    let created = ok_call(
        &f.state,
        "todo_write",
        json!({"board":"rocky","title":"x","comment":"첫 댓글"}),
    )
    .await;
    let id = created["id"].as_str().unwrap();
    let comments = f.store.list_comments(id, false).unwrap();
    assert_eq!(comments.len(), 1);
    assert_eq!(comments[0].body, "첫 댓글");
}

#[tokio::test]
async fn include_archived_reveals_archived_comments() {
    let f = fx();
    let created = ok_call(&f.state, "todo_write", json!({"board":"rocky","title":"x"})).await;
    let id = created["id"].as_str().unwrap();
    let comment = f.store.add_comment(id, "보관될 것", "logan", None).unwrap();
    f.store
        .set_comment_archived(&comment.id, true, "logan")
        .unwrap();

    let hidden = ok_call(&f.state, "todo_list", json!({"id": id})).await;
    assert_eq!(hidden["comments"].as_array().unwrap().len(), 0);
    let shown = ok_call(
        &f.state,
        "todo_list",
        json!({"id": id, "includeArchived": true}),
    )
    .await;
    assert_eq!(shown["comments"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn empty_comment_rejects_instead_of_noop() {
    let f = fx();
    let created = ok_call(&f.state, "todo_write", json!({"board":"rocky","title":"x"})).await;
    let id = created["id"].as_str().unwrap();
    let message = err_call(&f.state, "todo_write", json!({"id": id, "comment":""})).await;
    assert!(message.contains("comment body is required"));
}

#[tokio::test]
async fn create_with_empty_comment_leaves_no_todo() {
    let f = fx();
    let message = err_call(
        &f.state,
        "todo_write",
        json!({"board":"rocky","title":"x","comment":"  "}),
    )
    .await;
    assert!(message.contains("comment body is required"));
    let todos = f
        .store
        .list_todos(&rocky_todo_core::types::ListTodosFilter::default())
        .unwrap();
    assert!(todos.is_empty());
}

#[tokio::test]
async fn patch_with_blank_comment_does_not_apply_title() {
    let f = fx();
    let created = ok_call(
        &f.state,
        "todo_write",
        json!({"board":"rocky","title":"원래"}),
    )
    .await;
    let id = created["id"].as_str().unwrap();
    err_call(
        &f.state,
        "todo_write",
        json!({"id": id, "title":"바꿈","comment":"\n"}),
    )
    .await;
    assert_eq!(f.store.get_todo(id, None).unwrap().unwrap().title, "원래");
}

#[tokio::test]
async fn plain_patch_without_comment_still_works() {
    let f = fx();
    let created = ok_call(
        &f.state,
        "todo_write",
        json!({"board":"rocky","title":"원래"}),
    )
    .await;
    let id = created["id"].as_str().unwrap();
    let patched = ok_call(&f.state, "todo_write", json!({"id": id, "title":"바꿈"})).await;
    assert_eq!(patched["title"], "바꿈");
}

// ── note lifecycle ──

#[tokio::test]
async fn note_create_append_archive_lifecycle() {
    let f = fx();
    let note = ok_call(
        &f.state,
        "note_write",
        json!({"board":"rocky","title":"메모","content":"첫"}),
    )
    .await;
    let id = note["id"].as_str().unwrap();
    let appended = ok_call(
        &f.state,
        "note_write",
        json!({"id": id, "content":"둘","mode":"append"}),
    )
    .await;
    assert_eq!(appended["content"], "첫\n둘");
    let archived = ok_call(&f.state, "note_write", json!({"id": id, "mode":"archive"})).await;
    assert!(archived["archivedAt"].is_string());
    let listed = ok_call(&f.state, "note_list", json!({"board":"rocky"})).await;
    assert_eq!(listed["notes"].as_array().unwrap().len(), 0);
    let restored = ok_call(
        &f.state,
        "note_write",
        json!({"id": id, "mode":"unarchive"}),
    )
    .await;
    assert!(restored.get("archivedAt").is_none());
}

// ── createIssue through MCP ──

#[tokio::test]
async fn create_issue_only_write_creates_no_update_history() {
    let f = fx();
    let state = ok_gh(&f);
    let created = ok_call(&state, "todo_write", json!({"board":"rocky","title":"x"})).await;
    let id = created["id"].as_str().unwrap();
    f.store.set_board_repo("rocky", "o/n", "logan").unwrap();
    let updated = ok_call(&state, "todo_write", json!({"id": id, "createIssue": true})).await;
    assert_eq!(
        updated["links"][0]["url"],
        "https://github.com/o/n/issues/7"
    );
    // 링크 부착의 update 는 남지만, "빈 patch" 로 인한 이중 update 는 없다
    let updates = history_actions(&f, id)
        .into_iter()
        .filter(|a| a == "update")
        .count();
    assert_eq!(updates, 1);
}

#[tokio::test]
async fn create_issue_without_repo_fails_and_changes_nothing() {
    let f = fx();
    let state = ok_gh(&f);
    let created = ok_call(&state, "todo_write", json!({"board":"rocky","title":"x"})).await;
    let id = created["id"].as_str().unwrap();
    let message = err_call(&state, "todo_write", json!({"id": id, "createIssue": true})).await;
    assert!(message.contains("no GitHub repo"));
    assert!(f
        .store
        .get_todo(id, None)
        .unwrap()
        .unwrap()
        .links
        .is_empty());
}

#[tokio::test]
async fn creating_with_issue_on_repo_less_board_leaves_no_todo() {
    let f = fx();
    let state = ok_gh(&f);
    f.store.ensure_board("rocky", None, "logan").unwrap();
    let message = err_call(
        &state,
        "todo_write",
        json!({"board":"rocky","title":"x","createIssue": true}),
    )
    .await;
    assert!(message.contains("no GitHub repo"));
    let todos = f
        .store
        .list_todos(&rocky_todo_core::types::ListTodosFilter::default())
        .unwrap();
    assert!(todos.is_empty());
}

#[tokio::test]
async fn refused_origin_cannot_create_issue() {
    // 비로컬 peer → allowIssueCreate=false 서비스가 응답한다.
    let f = fx();
    let state = ok_gh(&f);
    let created = ok_call(&state, "todo_write", json!({"board":"rocky","title":"x"})).await;
    let id = created["id"].as_str().unwrap();
    f.store.set_board_repo("rocky", "o/n", "logan").unwrap();
    let (is_error, value) = tool_call(
        &state,
        "192.168.1.20",
        "todo_write",
        json!({"id": id, "createIssue": true}),
    )
    .await;
    assert!(is_error);
    assert!(value.as_str().unwrap().contains("로컬(루프백)"));
    assert!(f
        .store
        .get_todo(id, None)
        .unwrap()
        .unwrap()
        .links
        .is_empty());
}

#[tokio::test]
async fn refused_origin_does_not_apply_patch_either() {
    let f = fx();
    let state = ok_gh(&f);
    let created = ok_call(
        &state,
        "todo_write",
        json!({"board":"rocky","title":"원래"}),
    )
    .await;
    let id = created["id"].as_str().unwrap();
    f.store.set_board_repo("rocky", "o/n", "logan").unwrap();
    let (is_error, _) = tool_call(
        &state,
        "192.168.1.20",
        "todo_write",
        json!({"id": id, "title":"바꿈","createIssue": true}),
    )
    .await;
    assert!(is_error);
    assert_eq!(f.store.get_todo(id, None).unwrap().unwrap().title, "원래");
}

#[tokio::test]
async fn refused_origin_creating_new_todo_leaves_nothing() {
    let f = fx();
    let state = ok_gh(&f);
    f.store.ensure_board("rocky", None, "logan").unwrap();
    f.store.set_board_repo("rocky", "o/n", "logan").unwrap();
    let (is_error, _) = tool_call(
        &state,
        "192.168.1.20",
        "todo_write",
        json!({"board":"rocky","title":"x","createIssue": true}),
    )
    .await;
    assert!(is_error);
    let todos = f
        .store
        .list_todos(&rocky_todo_core::types::ListTodosFilter::default())
        .unwrap();
    assert!(todos.is_empty());
}

// ── cross-site 가드 ──

#[tokio::test]
async fn cross_site_post_is_403_normal_clients_pass() {
    let f = fx();
    let blocked = rpc(
        &f.state,
        "127.0.0.1",
        json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}),
        &[("sec-fetch-site", "cross-site")],
    )
    .await;
    assert!(
        blocked["error"].as_str().unwrap().contains("CSRF"),
        "{blocked}"
    );

    let allowed = rpc(
        &f.state,
        "127.0.0.1",
        json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}),
        &[],
    )
    .await;
    assert!(allowed["result"]["tools"].is_array());
}
