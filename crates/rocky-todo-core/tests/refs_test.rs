//! TS 원본 `src/refs.test.ts` 의 스토어 결합 구간 포팅 —
//! (순수 predicate 테스트는 src/refs.rs 의 유닛 테스트에 있다.)

use rocky_todo_core::refs::{ref_of, with_ref_todo};
use rocky_todo_core::store::TodoStore;
use rocky_todo_core::types::*;
use rusqlite::Connection;
use std::path::PathBuf;

struct Fx {
    _dir: tempfile::TempDir,
    db_path: PathBuf,
    store: TodoStore,
}

fn fx() -> Fx {
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("todo.db");
    let store = TodoStore::open(&db_path).unwrap();
    Fx {
        _dir: dir,
        db_path,
        store,
    }
}

impl Fx {
    fn raw(&self) -> Connection {
        Connection::open(&self.db_path).unwrap()
    }

    /// 레거시 malformed key 보드 + 그 항목을 raw SQL 로 심는다 — 지금의 생성 검증이
    /// 도입되기 전 구버전 데몬이 만들어둔 데이터를 재현한다.
    fn plant_legacy_board(&self, board_id: &str, key: &str) {
        let raw = self.raw();
        raw.execute(
            "INSERT INTO boards (id, key, title, created_at) VALUES (?1, ?2, ?2, '2026-07-01T00:00:00.000Z')",
            rusqlite::params![board_id, key],
        )
        .unwrap();
        raw.execute(
            "INSERT INTO todos (id, number, board_id, title, description, status, priority, labels, links, position, created_at, updated_at)
             VALUES ('aaaa1111', 1, ?1, '레거시 항목', '', 'todo', 'p4', '[]', '[]', 1, '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')",
            rusqlite::params![board_id],
        )
        .unwrap();
    }
}

#[test]
fn whitespace_legacy_key_falls_back_to_raw_id_and_round_trips() {
    let f = fx();
    f.plant_legacy_board("b1", "my repo");
    let todo = f.store.get_todo("aaaa1111", None).unwrap().unwrap();
    let r = ref_of(&f.store, Some(&todo.board_id), todo.number, &todo.id).unwrap();
    assert_eq!(r, "aaaa1111");
    assert_eq!(f.store.get_todo(&r, None).unwrap().unwrap().id, todo.id);
}

#[test]
fn hash_legacy_key_falls_back_to_raw_id_and_round_trips() {
    let f = fx();
    f.plant_legacy_board("b1", "a#b");
    let todo = f.store.get_todo("aaaa1111", None).unwrap().unwrap();
    let r = ref_of(&f.store, Some(&todo.board_id), todo.number, &todo.id).unwrap();
    assert_eq!(r, "aaaa1111");
    assert_eq!(f.store.get_todo(&r, None).unwrap().unwrap().id, todo.id);
}

#[test]
fn empty_legacy_key_falls_back_to_raw_id() {
    let f = fx();
    f.plant_legacy_board("b1", "");
    let todo = f.store.get_todo("aaaa1111", None).unwrap().unwrap();
    let r = ref_of(&f.store, Some(&todo.board_id), todo.number, &todo.id).unwrap();
    assert_eq!(r, "aaaa1111");
}

#[test]
fn missing_board_fails_explicitly_instead_of_forging_ref() {
    let f = fx();
    let result = ref_of(&f.store, Some("no-such-board-id"), 12, "aaaa1111");
    let msg = result.expect_err("expected error").to_string();
    assert!(msg.contains("cannot build ref"), "{msg}");
}

#[test]
fn normal_board_is_unaffected() {
    let f = fx();
    let todo = f
        .store
        .create_todo(
            &CreateTodoInput {
                board: "rocky".into(),
                title: "정상".into(),
                ..Default::default()
            },
            "tester",
        )
        .unwrap();
    let r = ref_of(&f.store, Some(&todo.board_id), todo.number, &todo.id).unwrap();
    assert_eq!(r, "rocky-1");
    assert_eq!(f.store.get_todo(&r, None).unwrap().unwrap().id, todo.id);
}

#[test]
fn global_note_gets_note_prefix() {
    let f = fx();
    let note = f
        .store
        .create_note(
            &CreateNoteInput {
                title: "글로벌".into(),
                ..Default::default()
            },
            "tester",
        )
        .unwrap();
    let r = ref_of(&f.store, None, note.number, &note.id).unwrap();
    assert_eq!(r, format!("note-{}", note.number));
    assert_eq!(f.store.get_note(&r, None).unwrap().unwrap().id, note.id);
}

#[test]
fn note_board_key_falls_back_to_raw_id_avoiding_global_collision() {
    let f = fx();
    // `note` 보드 생성은 막지 않는다 — 하지만 그 항목의 ref 는 raw id 로 폴백해야
    // 전역 note-N 과 충돌하지 않는다.
    let todo = f
        .store
        .create_todo(
            &CreateTodoInput {
                board: "note".into(),
                title: "note 보드".into(),
                ..Default::default()
            },
            "tester",
        )
        .unwrap();
    let r = ref_of(&f.store, Some(&todo.board_id), todo.number, &todo.id).unwrap();
    assert_eq!(r, todo.id);
    assert_eq!(f.store.get_todo(&r, None).unwrap().unwrap().id, todo.id);
}

#[test]
fn todo_view_carries_comment_count_and_last_comment_time() {
    let f = fx();
    let todo = f
        .store
        .create_todo(
            &CreateTodoInput {
                board: "rocky".into(),
                title: "작업".into(),
                ..Default::default()
            },
            "logan",
        )
        .unwrap();
    f.store
        .add_comment(&todo.id, "첫째", "logan", None)
        .unwrap();
    let second = f
        .store
        .add_comment(&todo.id, "둘째", "claude-code", None)
        .unwrap();

    let view = with_ref_todo(&f.store, todo).unwrap();
    assert_eq!(view.comment_count, 2);
    assert_eq!(
        view.last_comment_at.as_deref(),
        Some(second.created_at.as_str())
    );
    assert_eq!(view.r#ref, "rocky-1");

    // 직렬화 계약 — flatten 된 todo 필드와 view 필드가 한 객체에 camelCase 로 실린다.
    let json = serde_json::to_value(&view).unwrap();
    assert_eq!(json["ref"], "rocky-1");
    assert_eq!(json["commentCount"], 2);
    assert!(json.get("doingState").is_none()); // 부재 = 판정 안 함
}
