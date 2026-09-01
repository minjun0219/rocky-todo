//! TS `src/notify.test.ts` 포팅.

use rocky_todo_core::notify::{
    build_notify_context, filter_human_changes, merge_context, read_cursor, write_cursor,
};
use rocky_todo_core::types::{ChangeFeedEntry, Changes, HistoryEntity, HistoryEntry};
use serde_json::json;

fn entry(id: i64, actor: &str, action: &str) -> ChangeFeedEntry {
    ChangeFeedEntry {
        history: HistoryEntry {
            id,
            entity: HistoryEntity::Todo,
            entity_id: "abcd1234".into(),
            actor: actor.into(),
            action: action.into(),
            changes: None,
            at: "2026-07-23T10:00:00.000Z".into(),
        },
        title: "제목".into(),
        board_key: Some("rocky".into()),
    }
}

fn with_changes(mut e: ChangeFeedEntry, changes: serde_json::Value) -> ChangeFeedEntry {
    let map: Changes = changes.as_object().cloned().unwrap_or_default();
    e.history.changes = Some(map);
    e
}

// ── filterHumanChanges ──────────────────────────────────────────────────────

#[test]
fn drops_agent_actors_keeps_human_actors() {
    let entries = vec![
        entry(1, "claude-code", "update"),
        entry(2, "logan", "update"),
        entry(3, "codex", "update"),
        entry(4, "web", "update"),
    ];
    let kept: Vec<i64> = filter_human_changes(entries)
        .iter()
        .map(|e| e.history.id)
        .collect();
    assert_eq!(kept, vec![2, 4]);
}

// ── buildNotifyContext ──────────────────────────────────────────────────────

#[test]
fn none_when_no_entries() {
    assert!(build_notify_context(&[]).is_none());
}

#[test]
fn formats_compact_korean_lines_with_board_action_and_diff() {
    let mut note = entry(2, "logan", "create");
    note.history.entity = HistoryEntity::Note;
    note.title = "메모".into();
    note.board_key = None;
    let mut done = entry(3, "logan", "done");
    done.title = "끝난 일".into();

    let context = build_notify_context(&[
        with_changes(entry(1, "logan", "update"), json!({ "title": ["a", "b"] })),
        note,
        done,
    ])
    .expect("컨텍스트가 있어야 한다");
    for needle in [
        "rocky-todo",
        "[rocky]",
        "logan",
        "제목",
        "title: a → b",
        "메모",
        "완료",
    ] {
        assert!(context.contains(needle), "{needle} 이 없다:\n{context}");
    }
}

// ── 댓글 렌더 ───────────────────────────────────────────────────────────────

#[test]
fn renders_a_comment_with_its_body_instead_of_a_field_diff() {
    let mut e = with_changes(
        entry(1, "logan", "comment"),
        json!({ "comment": [null, "이거 SSE 로도 흘러가나?"] }),
    );
    e.title = "댓글 기능 추가".into();
    let context = build_notify_context(&[e]).unwrap();
    assert!(
        context.contains("\"댓글 기능 추가\" 댓글 · \"이거 SSE 로도 흘러가나?\""),
        "{context}"
    );
    assert!(!context.contains("comment:"), "{context}");
}

#[test]
fn renders_an_edited_comment_with_the_new_body() {
    let e = with_changes(
        entry(1, "logan", "comment-edit"),
        json!({ "comment": ["오타", "고침"] }),
    );
    let context = build_notify_context(&[e]).unwrap();
    assert!(context.contains("댓글 수정 · \"고침\""), "{context}");
}

#[test]
fn folds_newlines_and_truncates_a_long_body() {
    let body = format!("{}\n둘째 줄", "가".repeat(250));
    let e = with_changes(
        entry(1, "logan", "comment"),
        json!({ "comment": [null, body] }),
    );
    let context = build_notify_context(&[e]).unwrap();
    assert!(context.contains('…'), "{context}");
    assert!(!context.contains("\n둘째 줄"), "{context}");
    let line = context.lines().find(|l| l.contains("댓글")).unwrap_or("");
    assert!(line.chars().count() < 300, "{}", line.chars().count());
}

#[test]
fn agent_comments_are_filtered_out_before_formatting() {
    let entries = vec![
        with_changes(
            entry(1, "claude-code", "comment"),
            json!({ "comment": [null, "봇"] }),
        ),
        with_changes(
            entry(2, "logan", "comment"),
            json!({ "comment": [null, "사람"] }),
        ),
    ];
    let context = build_notify_context(&filter_human_changes(entries)).unwrap();
    assert!(context.contains("\"사람\""), "{context}");
    assert!(!context.contains("\"봇\""), "{context}");
}

// ── 커서 저장 ───────────────────────────────────────────────────────────────

#[test]
fn read_missing_is_none_and_write_then_read_round_trips() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("hook-cursors.json");
    assert!(read_cursor(&file, "sess-1").is_none());
    write_cursor(&file, "sess-1", 42);
    assert_eq!(read_cursor(&file, "sess-1"), Some(42));
    write_cursor(&file, "sess-1", 50);
    assert_eq!(read_cursor(&file, "sess-1"), Some(50));
    assert!(read_cursor(&file, "sess-2").is_none());
}

/// 개수만 보면 "어느 100개가 남았는지"를 놓친다 — `at` 이 밀리초라 세션들이 같은 값을
/// 갖기 쉽고, 그때 잘려나가는 구간이 오래된 쪽이 아니라 임의의 밴드가 되던 버그가
/// 있었다. 남은 집합이 정확히 최신 100개인지까지 못 박는다.
#[test]
fn prunes_to_the_most_recent_100_sessions() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("hook-cursors.json");
    for i in 0..120 {
        write_cursor(&file, &format!("sess-{i}"), i);
    }
    let raw: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
    let keys = raw.as_object().unwrap();
    assert!(keys.len() <= 100, "{}", keys.len());
    assert_eq!(read_cursor(&file, "sess-119"), Some(119));
    assert!(read_cursor(&file, "sess-0").is_none());

    let survivors: Vec<i64> = (0..120)
        .filter(|i| keys.contains_key(&format!("sess-{i}")))
        .collect();
    let expected: Vec<i64> = (20..120).collect();
    assert_eq!(survivors, expected);
}

#[test]
fn corrupt_cursor_file_is_treated_as_empty() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("hook-cursors.json");
    write_cursor(&file, "a", 1);
    std::fs::write(&file, "{broken").unwrap();
    assert!(read_cursor(&file, "a").is_none());
    write_cursor(&file, "a", 2);
    assert_eq!(read_cursor(&file, "a"), Some(2));
}

// ── mergeContext ────────────────────────────────────────────────────────────

#[test]
fn both_present_are_joined_with_a_blank_line() {
    assert_eq!(
        merge_context(&[Some("A".into()), Some("B".into())]).as_deref(),
        Some("A\n\nB")
    );
}

#[test]
fn a_single_part_is_returned_alone() {
    assert_eq!(
        merge_context(&[None, Some("B".into())]).as_deref(),
        Some("B")
    );
    assert_eq!(
        merge_context(&[Some("A".into()), None]).as_deref(),
        Some("A")
    );
}

#[test]
fn nothing_to_inject_is_none() {
    assert!(merge_context(&[None, None]).is_none());
}

#[test]
fn empty_strings_count_as_absent() {
    assert_eq!(
        merge_context(&[Some(String::new()), Some("B".into())]).as_deref(),
        Some("B")
    );
}
