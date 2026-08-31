//! TS `src/server.test.ts` 포팅 1/4 — health·todos·notes·boards·sections·changes·
//! ref 직렬화·SSE·comments·move·cross-site·CSRF 심층 방어.

mod common;

use common::*;
use rocky_todo_core::types::*;
use serde_json::json;

// ── health ──

#[tokio::test]
async fn health_responds_ok() {
    let f = fx();
    let (status, body) = get(&f.state, "/api/health").await;
    assert_eq!(status, 200);
    assert_eq!(body["ok"], true);
}

#[tokio::test]
async fn health_reports_running_version() {
    let f = fx();
    let (_, body) = get(&f.state, "/api/health").await;
    assert_eq!(body["name"], "rocky-todo");
    let version = body["version"].as_str().unwrap();
    assert!(version.split('.').count() >= 3, "{version}");
}

// ── todos REST ──

#[tokio::test]
async fn post_todos_creates_and_records_actor_from_header() {
    let f = fx();
    let (status, todo) = call(
        &f.state,
        "POST",
        "/api/todos",
        Some(json!({"board":"rocky","title":"작업","labels":["bug"]})),
        ReqOptions {
            actor: "claude-code",
            ..Default::default()
        },
    )
    .await;
    assert_eq!(status, 201);
    assert_eq!(todo["title"], "작업");
    let history = f
        .store
        .list_history(&ListHistoryFilter {
            entity_id: Some(todo["id"].as_str().unwrap().to_string()),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(history[0].actor, "claude-code");
}

#[tokio::test]
async fn get_todos_filters_by_board() {
    let f = fx();
    post(&f.state, "/api/todos", json!({"board":"a","title":"x"})).await;
    post(&f.state, "/api/todos", json!({"board":"b","title":"y"})).await;

    let (_, all) = get(&f.state, "/api/todos").await;
    assert_eq!(all.as_array().unwrap().len(), 2);

    let (_, only_a) = get(&f.state, "/api/todos?board=a").await;
    assert_eq!(only_a.as_array().unwrap().len(), 1);
    assert_eq!(only_a[0]["title"], "x");
}

#[tokio::test]
async fn get_todo_detail_with_history() {
    let f = fx();
    let (_, created) = post(&f.state, "/api/todos", json!({"board":"a","title":"x"})).await;
    let id = created["id"].as_str().unwrap();
    let (status, body) = get(&f.state, &format!("/api/todos/{id}")).await;
    assert_eq!(status, 200);
    assert_eq!(body["todo"]["id"], created["id"]);
    assert_eq!(body["history"][0]["action"], "create");
}

#[tokio::test]
async fn patch_todo_updates_fields() {
    let f = fx();
    let (_, created) = post(&f.state, "/api/todos", json!({"board":"a","title":"x"})).await;
    let id = created["id"].as_str().unwrap();
    let (status, updated) = patch(
        &f.state,
        &format!("/api/todos/{id}"),
        json!({"title":"y","priority":"p1"}),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(updated["title"], "y");
    assert_eq!(updated["priority"], "p1");
}

#[tokio::test]
async fn status_transitions() {
    let f = fx();
    let (_, created) = post(&f.state, "/api/todos", json!({"board":"a","title":"x"})).await;
    let id = created["id"].as_str().unwrap();
    let (status, started) = post(
        &f.state,
        &format!("/api/todos/{id}/status"),
        json!({"action":"start"}),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(started["status"], "doing");
    let (_, done) = post(
        &f.state,
        &format!("/api/todos/{id}/status"),
        json!({"action":"done"}),
    )
    .await;
    assert_eq!(done["status"], "done");
    assert!(done["completedAt"].is_string());
}

#[tokio::test]
async fn unknown_id_404_unknown_action_400() {
    let f = fx();
    let (status, _) = post(
        &f.state,
        "/api/todos/nosuchid/status",
        json!({"action":"start"}),
    )
    .await;
    assert_eq!(status, 404);

    let (_, created) = post(&f.state, "/api/todos", json!({"board":"a","title":"x"})).await;
    let id = created["id"].as_str().unwrap();
    let (status, _) = post(
        &f.state,
        &format!("/api/todos/{id}/status"),
        json!({"action":"explode"}),
    )
    .await;
    assert_eq!(status, 400);
}

#[tokio::test]
async fn post_todos_without_title_is_400() {
    let f = fx();
    let (status, _) = post(&f.state, "/api/todos", json!({"board":"a"})).await;
    assert_eq!(status, 400);
}

// ── notes REST ──

#[tokio::test]
async fn notes_lifecycle() {
    let f = fx();
    let (status, note) = post(
        &f.state,
        "/api/notes",
        json!({"board":"rocky","title":"메모","content":"첫"}),
    )
    .await;
    assert_eq!(status, 201);
    let id = note["id"].as_str().unwrap();

    let (_, updated) = patch(
        &f.state,
        &format!("/api/notes/{id}"),
        json!({"content":"둘","mode":"append"}),
    )
    .await;
    assert_eq!(updated["content"], "첫\n둘");

    let (status, archived) = post(&f.state, &format!("/api/notes/{id}/archive"), json!({})).await;
    assert_eq!(status, 200);
    assert!(archived["archivedAt"].is_string());

    let (_, listed) = get(&f.state, "/api/notes?board=rocky").await;
    assert_eq!(listed.as_array().unwrap().len(), 0);
    let (_, with_archived) = get(&f.state, "/api/notes?board=rocky&includeArchived=true").await;
    assert_eq!(with_archived.as_array().unwrap().len(), 1);
}

// ── boards & sections ──

#[tokio::test]
async fn boards_list_and_sections_require_board() {
    let f = fx();
    post(&f.state, "/api/todos", json!({"board":"rocky","title":"x"})).await;
    let (_, boards) = get(&f.state, "/api/boards").await;
    assert_eq!(boards.as_array().unwrap().len(), 1);
    assert_eq!(boards[0]["key"], "rocky");

    let (status, _) = get(&f.state, "/api/sections").await;
    assert_eq!(status, 400);
    let (status, sections) = get(&f.state, "/api/sections?board=rocky").await;
    assert_eq!(status, 200);
    assert_eq!(sections.as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn post_sections_creates_empty_section() {
    let f = fx();
    post(&f.state, "/api/boards", json!({"key":"rocky"})).await;
    let (status, section) = post(
        &f.state,
        "/api/sections",
        json!({"board":"rocky","title":"설계"}),
    )
    .await;
    assert_eq!(status, 201);
    assert_eq!(section["title"], "설계");
    let (_, sections) = get(&f.state, "/api/sections?board=rocky").await;
    assert_eq!(sections.as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn post_sections_upserts_by_name() {
    let f = fx();
    post(&f.state, "/api/boards", json!({"key":"rocky"})).await;
    let (_, first) = post(
        &f.state,
        "/api/sections",
        json!({"board":"rocky","title":"설계"}),
    )
    .await;
    let (_, second) = post(
        &f.state,
        "/api/sections",
        json!({"board":"rocky","title":"설계"}),
    )
    .await;
    assert_eq!(first["id"], second["id"]);
    let (_, sections) = get(&f.state, "/api/sections?board=rocky").await;
    assert_eq!(sections.as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn post_sections_requires_board_and_title() {
    let f = fx();
    post(&f.state, "/api/boards", json!({"key":"rocky"})).await;
    let (status, _) = post(&f.state, "/api/sections", json!({"title":"설계"})).await;
    assert_eq!(status, 400);
    let (status, _) = post(
        &f.state,
        "/api/sections",
        json!({"board":"rocky","title":"  "}),
    )
    .await;
    assert_eq!(status, 400);
}

#[tokio::test]
async fn archive_section_returns_items_to_unsectioned() {
    let f = fx();
    let (_, todo) = post(
        &f.state,
        "/api/todos",
        json!({"board":"rocky","title":"x","section":"설계"}),
    )
    .await;
    let section_id = todo["sectionId"].as_str().unwrap();
    let (status, _) = post(
        &f.state,
        &format!("/api/sections/{section_id}/archive"),
        json!({}),
    )
    .await;
    assert_eq!(status, 200);
    let id = todo["id"].as_str().unwrap();
    let (_, detail) = get(&f.state, &format!("/api/todos/{id}")).await;
    assert!(detail["todo"]["sectionId"].is_null());
}

#[tokio::test]
async fn post_sections_unknown_board_is_404_and_creates_nothing() {
    let f = fx();
    let (status, _) = post(
        &f.state,
        "/api/sections",
        json!({"board":"nope","title":"설계"}),
    )
    .await;
    assert_eq!(status, 404);
    let (_, boards) = get(&f.state, "/api/boards").await;
    assert_eq!(boards.as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn archive_unknown_section_is_404() {
    let f = fx();
    let (status, _) = post(&f.state, "/api/sections/nosuch/archive", json!({})).await;
    assert_eq!(status, 404);
}

#[tokio::test]
async fn post_boards_rejects_unusable_keys() {
    let f = fx();
    let (status, _) = post(&f.state, "/api/boards", json!({"key":"my repo"})).await;
    assert_eq!(status, 400);
    let (status, _) = post(&f.state, "/api/boards", json!({"key":"a#b"})).await;
    assert_eq!(status, 400);
}

// ── changes feed ──

#[tokio::test]
async fn changes_feed_after_since_id() {
    let f = fx();
    let (_, todo) = post(
        &f.state,
        "/api/todos",
        json!({"board":"rocky","title":"피드"}),
    )
    .await;
    let (_, base) = get(&f.state, "/api/changes?sinceId=0").await;
    let last_id = base["lastId"].as_i64().unwrap();
    assert!(!base["entries"].as_array().unwrap().is_empty());

    let id = todo["id"].as_str().unwrap();
    patch(
        &f.state,
        &format!("/api/todos/{id}"),
        json!({"title":"피드 v2"}),
    )
    .await;
    let (_, feed) = get(&f.state, &format!("/api/changes?sinceId={last_id}")).await;
    assert_eq!(feed["entries"].as_array().unwrap().len(), 1);
    assert_eq!(feed["entries"][0]["action"], "update");
    assert_eq!(feed["entries"][0]["title"], "피드 v2");
    assert_eq!(feed["entries"][0]["boardKey"], "rocky");

    let (status, _) = get(&f.state, "/api/changes?sinceId=-1").await;
    assert_eq!(status, 400);
}

// ── number / ref 직렬화 ──

#[tokio::test]
async fn todo_response_carries_number_and_ref() {
    let f = fx();
    let (_, todo) = post(&f.state, "/api/todos", json!({"board":"rocky","title":"x"})).await;
    assert_eq!(todo["number"], 1);
    assert_eq!(todo["ref"], "rocky-1");
}

#[tokio::test]
async fn number_refs_resolve() {
    let f = fx();
    let (_, todo) = post(&f.state, "/api/todos", json!({"board":"rocky","title":"x"})).await;
    let (status, body) = get(&f.state, "/api/todos/rocky%231").await; // rocky#1
    assert_eq!(status, 200);
    assert_eq!(body["todo"]["id"], todo["id"]);
    let (status, body) = get(&f.state, "/api/todos/rocky-1").await;
    assert_eq!(status, 200);
    assert_eq!(body["todo"]["id"], todo["id"]);
}

#[tokio::test]
async fn todos_list_carries_ref() {
    let f = fx();
    post(&f.state, "/api/todos", json!({"board":"rocky","title":"x"})).await;
    let (_, list) = get(&f.state, "/api/todos").await;
    assert_eq!(list[0]["ref"], "rocky-1");
}

#[tokio::test]
async fn note_responses_carry_number_and_ref() {
    let f = fx();
    let (_, board_note) = post(
        &f.state,
        "/api/notes",
        json!({"board":"rocky","title":"보드"}),
    )
    .await;
    assert_eq!(board_note["ref"], "rocky-1");
    let (_, global_note) = post(&f.state, "/api/notes", json!({"title":"글로벌"})).await;
    assert_eq!(global_note["ref"], "note-1");
}

#[tokio::test]
async fn bare_number_without_board_is_4xx_not_500() {
    let f = fx();
    post(&f.state, "/api/todos", json!({"board":"rocky","title":"x"})).await;
    let (status, _) = get(&f.state, "/api/todos/1").await;
    assert_eq!(status, 400);
}

#[tokio::test]
async fn board_query_scopes_bare_number() {
    let f = fx();
    let (_, todo) = post(&f.state, "/api/todos", json!({"board":"rocky","title":"x"})).await;
    let (status, body) = get(&f.state, "/api/todos/1?board=rocky").await;
    assert_eq!(status, 200);
    assert_eq!(body["todo"]["id"], todo["id"]);
}

#[tokio::test]
async fn unknown_board_query_does_not_leak_note_to_global() {
    let f = fx();
    post(&f.state, "/api/notes", json!({"title":"글로벌"})).await; // note-1 (전역)
    let (status, body) = get(&f.state, "/api/notes/1?board=typo-board").await;
    assert_eq!(status, 400, "{body}");
    assert!(body["error"].as_str().unwrap().contains("unknown board"));
}

#[tokio::test]
async fn scoped_ref_survives_unknown_board_query() {
    let f = fx();
    let (_, todo) = post(&f.state, "/api/todos", json!({"board":"rocky","title":"x"})).await;
    let (status, body) = get(&f.state, "/api/todos/rocky%231?board=not-a-board").await;
    assert_eq!(status, 200);
    assert_eq!(body["todo"]["id"], todo["id"]);
}

#[tokio::test]
async fn raw_id_survives_unknown_board_query() {
    let f = fx();
    let (_, todo) = post(&f.state, "/api/todos", json!({"board":"rocky","title":"x"})).await;
    let id = todo["id"].as_str().unwrap();
    let (status, body) = get(&f.state, &format!("/api/todos/{id}?board=not-a-board")).await;
    assert_eq!(status, 200);
    assert_eq!(body["todo"]["id"], todo["id"]);
}

#[tokio::test]
async fn id_prefix_survives_unknown_board_query() {
    let f = fx();
    let (_, todo) = post(&f.state, "/api/todos", json!({"board":"rocky","title":"x"})).await;
    let prefix = id_prefix(todo["id"].as_str().unwrap());
    let (status, body) = get(&f.state, &format!("/api/todos/{prefix}?board=not-a-board")).await;
    assert_eq!(status, 200);
    assert_eq!(body["todo"]["id"], todo["id"]);
}

#[tokio::test]
async fn bare_number_still_errors_on_unknown_board_query() {
    let f = fx();
    post(&f.state, "/api/todos", json!({"board":"rocky","title":"x"})).await;
    let (status, body) = get(&f.state, "/api/todos/1?board=not-a-board").await;
    assert_eq!(status, 400);
    assert!(body["error"].as_str().unwrap().contains("unknown board"));
}

#[tokio::test]
async fn bare_number_without_board_says_context_required() {
    let f = fx();
    post(&f.state, "/api/todos", json!({"board":"rocky","title":"x"})).await;
    let (_, body) = get(&f.state, "/api/todos/1").await;
    assert!(body["error"]
        .as_str()
        .unwrap()
        .contains("board context required"));
}

#[tokio::test]
async fn global_note_bare_number_resolves_without_board() {
    let f = fx();
    let (_, note) = post(&f.state, "/api/notes", json!({"title":"글로벌"})).await;
    let (status, body) = get(&f.state, "/api/notes/%231").await; // #1
    assert_eq!(status, 200);
    assert_eq!(body["note"]["id"], note["id"]);
}

// ── SSE ──

#[tokio::test]
async fn sse_streams_change_events() {
    use axum::body::Body;
    use axum::http::Request;
    use tokio_stream::StreamExt;

    let f = fx();
    let request = Request::builder()
        .method("GET")
        .uri("http://localhost/api/events")
        .body(Body::empty())
        .unwrap();
    let response =
        rocky_todod::server::handle_api(&f.state, request, Some("127.0.0.1".into())).await;
    assert_eq!(response.status(), 200);
    assert!(response
        .headers()
        .get("content-type")
        .unwrap()
        .to_str()
        .unwrap()
        .contains("text/event-stream"));
    let mut stream = response.into_body().into_data_stream();

    // 첫 프레임 — connected 주석
    let first = tokio::time::timeout(std::time::Duration::from_secs(2), stream.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(String::from_utf8_lossy(&first), ": connected\n\n");

    post(
        &f.state,
        "/api/todos",
        json!({"board":"rocky","title":"SSE"}),
    )
    .await;

    let mut collected = String::new();
    while !collected.contains("data:") {
        let frame = tokio::time::timeout(std::time::Duration::from_secs(2), stream.next())
            .await
            .expect("SSE 이벤트가 시간 안에 와야 한다")
            .unwrap()
            .unwrap();
        collected.push_str(&String::from_utf8_lossy(&frame));
    }
    assert!(collected.contains("\"action\":\"create\""), "{collected}");
    assert!(
        collected.contains("\"entity\":\"board\"") || collected.contains("\"entity\":\"todo\"")
    );
}

// ── comments ──

#[tokio::test]
async fn post_comment_creates() {
    let f = fx();
    let (_, todo) = post(
        &f.state,
        "/api/todos",
        json!({"board":"rocky","title":"작업"}),
    )
    .await;
    let id = todo["id"].as_str().unwrap();
    let (status, comment) = call(
        &f.state,
        "POST",
        &format!("/api/todos/{id}/comments"),
        Some(json!({"body":"진행 중"})),
        ReqOptions {
            actor: "claude-code",
            ..Default::default()
        },
    )
    .await;
    assert_eq!(status, 201);
    assert_eq!(comment["body"], "진행 중");
    assert_eq!(comment["actor"], "claude-code");
}

#[tokio::test]
async fn todo_detail_includes_comments() {
    let f = fx();
    let (_, todo) = post(
        &f.state,
        "/api/todos",
        json!({"board":"rocky","title":"작업"}),
    )
    .await;
    let id = todo["id"].as_str().unwrap();
    post(
        &f.state,
        &format!("/api/todos/{id}/comments"),
        json!({"body":"하나"}),
    )
    .await;
    let (_, detail) = get(&f.state, &format!("/api/todos/{id}")).await;
    assert_eq!(detail["comments"].as_array().unwrap().len(), 1);
    assert_eq!(detail["comments"][0]["body"], "하나");
}

#[tokio::test]
async fn patch_comment_edits_body() {
    let f = fx();
    let (_, todo) = post(
        &f.state,
        "/api/todos",
        json!({"board":"rocky","title":"작업"}),
    )
    .await;
    let id = todo["id"].as_str().unwrap();
    let (_, comment) = post(
        &f.state,
        &format!("/api/todos/{id}/comments"),
        json!({"body":"오타"}),
    )
    .await;
    let comment_id = comment["id"].as_str().unwrap();
    let (status, updated) = patch(
        &f.state,
        &format!("/api/comments/{comment_id}"),
        json!({"body":"고침"}),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(updated["body"], "고침");
}

#[tokio::test]
async fn comment_archive_hides_and_unarchive_restores() {
    let f = fx();
    let (_, todo) = post(
        &f.state,
        "/api/todos",
        json!({"board":"rocky","title":"작업"}),
    )
    .await;
    let id = todo["id"].as_str().unwrap();
    let (_, comment) = post(
        &f.state,
        &format!("/api/todos/{id}/comments"),
        json!({"body":"잘못"}),
    )
    .await;
    let comment_id = comment["id"].as_str().unwrap();

    post(
        &f.state,
        &format!("/api/comments/{comment_id}/archive"),
        json!({}),
    )
    .await;
    let (_, detail) = get(&f.state, &format!("/api/todos/{id}")).await;
    assert_eq!(detail["comments"].as_array().unwrap().len(), 0);

    post(
        &f.state,
        &format!("/api/comments/{comment_id}/unarchive"),
        json!({}),
    )
    .await;
    let (_, detail) = get(&f.state, &format!("/api/todos/{id}")).await;
    assert_eq!(detail["comments"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn detail_history_survives_many_comments() {
    // 회귀(finding 1): 댓글 55개가 create/start/done 을 히스토리 밖으로 밀어내면 안 된다.
    let f = fx();
    let (_, todo) = post(
        &f.state,
        "/api/todos",
        json!({"board":"rocky","title":"작업"}),
    )
    .await;
    let id = todo["id"].as_str().unwrap();
    post(
        &f.state,
        &format!("/api/todos/{id}/status"),
        json!({"action":"start"}),
    )
    .await;
    post(
        &f.state,
        &format!("/api/todos/{id}/status"),
        json!({"action":"done"}),
    )
    .await;
    for i in 0..55 {
        post(
            &f.state,
            &format!("/api/todos/{id}/comments"),
            json!({"body": format!("댓글 {i}")}),
        )
        .await;
    }
    let (_, detail) = get(&f.state, &format!("/api/todos/{id}")).await;
    let actions: Vec<String> = detail["history"]
        .as_array()
        .unwrap()
        .iter()
        .map(|h| h["action"].as_str().unwrap().to_string())
        .collect();
    assert!(actions.contains(&"create".to_string()));
    assert!(actions.contains(&"start".to_string()));
    assert!(actions.contains(&"done".to_string()));
}

#[tokio::test]
async fn include_archived_query_reveals_archived_comment() {
    let f = fx();
    let (_, todo) = post(
        &f.state,
        "/api/todos",
        json!({"board":"rocky","title":"작업"}),
    )
    .await;
    let id = todo["id"].as_str().unwrap();
    let (_, comment) = post(
        &f.state,
        &format!("/api/todos/{id}/comments"),
        json!({"body":"보관될 것"}),
    )
    .await;
    let comment_id = comment["id"].as_str().unwrap();
    post(
        &f.state,
        &format!("/api/comments/{comment_id}/archive"),
        json!({}),
    )
    .await;

    let (_, without) = get(&f.state, &format!("/api/todos/{id}")).await;
    assert_eq!(without["comments"].as_array().unwrap().len(), 0);
    let (_, with) = get(&f.state, &format!("/api/todos/{id}?includeArchived=true")).await;
    assert_eq!(with["comments"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn blank_comment_400_unknown_comment_404() {
    let f = fx();
    let (_, todo) = post(
        &f.state,
        "/api/todos",
        json!({"board":"rocky","title":"작업"}),
    )
    .await;
    let id = todo["id"].as_str().unwrap();
    let (status, _) = post(
        &f.state,
        &format!("/api/todos/{id}/comments"),
        json!({"body":"   "}),
    )
    .await;
    assert_eq!(status, 400);
    let (status, _) = patch(&f.state, "/api/comments/nosuchid", json!({"body":"본문"})).await;
    assert_eq!(status, 404);
}

// ── cross-site 가드 ──

#[tokio::test]
async fn cross_site_mutation_is_403() {
    let f = fx();
    let (status, body) = call(
        &f.state,
        "POST",
        "/api/todos",
        Some(json!({"board":"rocky","title":"x"})),
        ReqOptions {
            headers: vec![("sec-fetch-site", "cross-site")],
            ..Default::default()
        },
    )
    .await;
    assert_eq!(status, 403);
    assert!(body["error"].as_str().unwrap().contains("CSRF"));
}

#[tokio::test]
async fn same_origin_and_headerless_pass() {
    let f = fx();
    let (status, _) = call(
        &f.state,
        "POST",
        "/api/todos",
        Some(json!({"board":"rocky","title":"x"})),
        ReqOptions {
            headers: vec![("sec-fetch-site", "same-origin")],
            ..Default::default()
        },
    )
    .await;
    assert_eq!(status, 201);
    let (status, _) = post(&f.state, "/api/todos", json!({"board":"rocky","title":"y"})).await;
    assert_eq!(status, 201);
}

#[tokio::test]
async fn cross_site_reads_are_not_blocked() {
    let f = fx();
    let (status, _) = call(
        &f.state,
        "GET",
        "/api/todos",
        None,
        ReqOptions {
            headers: vec![("sec-fetch-site", "cross-site")],
            ..Default::default()
        },
    )
    .await;
    assert_eq!(status, 200);
}

// ── CSRF 심층 방어 (content-type) ──

#[tokio::test]
async fn text_plain_mutation_is_rejected() {
    let f = fx();
    let (status, _) = call(
        &f.state,
        "POST",
        "/api/todos",
        None,
        ReqOptions {
            raw_body: Some((r#"{"board":"rocky","title":"x"}"#, Some("text/plain"))),
            ..Default::default()
        },
    )
    .await;
    assert_eq!(status, 400);
}

#[tokio::test]
async fn empty_body_with_form_content_type_is_rejected() {
    let f = fx();
    let (_, todo) = post(&f.state, "/api/todos", json!({"board":"rocky","title":"x"})).await;
    let id = todo["id"].as_str().unwrap();
    let (status, _) = call(
        &f.state,
        "POST",
        &format!("/api/todos/{id}/issue"),
        None,
        ReqOptions {
            raw_body: Some(("", Some("text/plain"))),
            ..Default::default()
        },
    )
    .await;
    assert_eq!(status, 400);
}

#[tokio::test]
async fn empty_body_without_content_type_passes() {
    let f = fx();
    // issue 라우트는 body 없는 POST 가 정상 경로다 — repo 미설정이라 400 이지만
    // content-type 검증이 아니라 repo 없음 메시지여야 한다.
    let (_, todo) = post(&f.state, "/api/todos", json!({"board":"rocky","title":"x"})).await;
    let id = todo["id"].as_str().unwrap();
    let (status, body) = call(
        &f.state,
        "POST",
        &format!("/api/todos/{id}/issue"),
        None,
        ReqOptions::default(),
    )
    .await;
    assert_eq!(status, 400);
    assert!(
        body["error"].as_str().unwrap().contains("no GitHub repo"),
        "{body}"
    );
}

#[tokio::test]
async fn board_path_repo_changes_are_local_only() {
    let f = fx();
    post(&f.state, "/api/boards", json!({"key":"rocky"})).await;
    let (status, body) = call(
        &f.state,
        "PATCH",
        "/api/boards/rocky",
        Some(json!({"path":"/dev/rocky"})),
        ReqOptions {
            peer: Some("192.168.1.20"),
            ..Default::default()
        },
    )
    .await;
    assert_eq!(status, 403, "{body}");
    // title 은 원격에서도 편집 가능
    let (status, _) = call(
        &f.state,
        "PATCH",
        "/api/boards/rocky",
        Some(json!({"title":"바뀐 제목"})),
        ReqOptions {
            peer: Some("192.168.1.20"),
            ..Default::default()
        },
    )
    .await;
    assert_eq!(status, 200);
}

// ── move / board-move ──

#[tokio::test]
async fn move_requires_explicit_before() {
    let f = fx();
    let (_, a) = post(&f.state, "/api/todos", json!({"board":"rocky","title":"a"})).await;
    let id = a["id"].as_str().unwrap();
    let (status, body) = post(&f.state, &format!("/api/todos/{id}/move"), json!({})).await;
    assert_eq!(status, 400);
    assert!(body["error"]
        .as_str()
        .unwrap()
        .contains("before is required"));
    let (status, _) = post(
        &f.state,
        &format!("/api/todos/{id}/move"),
        json!({"before": 123}),
    )
    .await;
    assert_eq!(status, 400);
}

#[tokio::test]
async fn move_before_target_reorders() {
    let f = fx();
    let (_, a) = post(&f.state, "/api/todos", json!({"board":"rocky","title":"a"})).await;
    let (_, _b) = post(&f.state, "/api/todos", json!({"board":"rocky","title":"b"})).await;
    let (_, c) = post(&f.state, "/api/todos", json!({"board":"rocky","title":"c"})).await;
    let c_id = c["id"].as_str().unwrap();
    let (status, _) = post(
        &f.state,
        &format!("/api/todos/{c_id}/move"),
        json!({"before": a["id"].as_str().unwrap()}),
    )
    .await;
    assert_eq!(status, 200);
    let (_, list) = get(&f.state, "/api/todos?board=rocky").await;
    let titles: Vec<&str> = list
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["title"].as_str().unwrap())
        .collect();
    assert_eq!(titles, vec!["c", "a", "b"]);
}

#[tokio::test]
async fn board_move_returns_new_ref() {
    let f = fx();
    let (_, moving) = post(
        &f.state,
        "/api/todos",
        json!({"board":"origin","title":"m"}),
    )
    .await;
    post(
        &f.state,
        "/api/todos",
        json!({"board":"target","title":"t1"}),
    )
    .await;
    let id = moving["id"].as_str().unwrap();
    let (status, moved) = post(
        &f.state,
        &format!("/api/todos/{id}/board"),
        json!({"board":"target"}),
    )
    .await;
    assert_eq!(status, 200); // TS 는 json() 기본 = 200
    assert_eq!(moved["ref"], "target-2");
    let (status, _) = post(&f.state, &format!("/api/todos/{id}/board"), json!({})).await;
    assert_eq!(status, 400);
}
