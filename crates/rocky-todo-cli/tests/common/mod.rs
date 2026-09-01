//! CLI 테스트 픽스처 — TS `src/cli.test.ts` 의 `base`/`comment()`/`history()` 대응.

use rocky_todo_core::refs::TodoView;
use rocky_todo_core::types::{
    Board, Comment, Handoff, HandoffStatus, HistoryEntity, HistoryEntry, Todo, TodoPriority,
    TodoStatus,
};

/// 기본 todo — 제목만 있고 메타는 비어 있다.
pub fn todo_fixture() -> TodoView {
    TodoView {
        todo: Todo {
            id: "a1b2c3d4".into(),
            number: 1,
            board_id: "b".into(),
            section_id: None,
            parent_id: None,
            title: "작업 제목".into(),
            description: String::new(),
            status: TodoStatus::Todo,
            priority: TodoPriority::P4,
            labels: vec![],
            links: vec![],
            due: None,
            position: 1,
            doing_by: None,
            doing_since: None,
            doing_session_id: None,
            completed_at: None,
            archived_at: None,
            created_at: "2026-07-23T00:00:00.000Z".into(),
            updated_at: "2026-07-23T00:00:00.000Z".into(),
        },
        r#ref: "rocky-1".into(),
        comment_count: 0,
        last_comment_at: None,
        doing_state: None,
    }
}

/// 기본 댓글.
pub fn comment_fixture(id: &str, actor: &str, body: &str, created_at: &str) -> Comment {
    Comment {
        id: id.into(),
        todo_id: "a1b2c3d4".into(),
        actor: actor.into(),
        body: body.into(),
        archived_at: None,
        created_at: created_at.into(),
        updated_at: created_at.into(),
    }
}

/// 기본 히스토리 항목.
pub fn history_fixture(id: i64, action: &str) -> HistoryEntry {
    HistoryEntry {
        id,
        entity: HistoryEntity::Todo,
        entity_id: "a1b2c3d4".into(),
        actor: "claude-code".into(),
        action: action.into(),
        changes: None,
        at: "2026-07-23T00:00:00.000Z".into(),
    }
}

/// 기본 보드 — key/title 만.
pub fn board_fixture() -> Board {
    Board {
        id: "b1".into(),
        key: "tally".into(),
        title: "Tally".into(),
        description: None,
        repo: None,
        path: None,
        previous_keys: None,
        created_at: "2026-08-01T00:00:00.000Z".into(),
        archived_at: None,
    }
}

/// 기본 handoff.
pub fn handoff_fixture() -> Handoff {
    Handoff {
        id: "h1".into(),
        todo_id: "t1".into(),
        session_id: "sess-1".into(),
        session_name: Some("rocky-todo-1e".into()),
        note: String::new(),
        actor: "minjun".into(),
        session_cwd: None,
        status: HandoffStatus::Pending,
        created_at: "2026-07-27T00:00:00.000Z".into(),
        delivered_at: None,
        delivered_via: None,
        accepted_at: None,
        completed_at: None,
    }
}
