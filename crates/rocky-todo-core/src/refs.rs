//! 번호 참조(ref) 직렬화/판별 — TS 원본 `src/refs.ts`.
//!
//! 해석(resolve)은 `store` 쪽에 있다(테이블 조회가 필요해서). 여기는 내보내기(`ref_of`)와
//! 순수 판별들, 그리고 REST·MCP 가 공유하는 응답 view(`TodoView`/`NoteView`)를 둔다.

use serde::{Deserialize, Serialize};

use crate::ids::ID_LENGTH;
use crate::store::{StoreResult, TodoStore};
use crate::types::{Note, Todo};

/// 보드에 속하지 않는 글로벌 메모의 참조 접두사 — `note-3`. **예약어**다:
/// `note-N` 은 board 컨텍스트와 무관하게 언제나 전역 메모를 가리킨다.
pub const GLOBAL_NOTE_PREFIX: &str = "note";

pub use crate::doing::DoingState;

/// 응답 전용 todo — 저장 모델에 사람이 쓰는 참조(ref)와 댓글 집계를 얹은 형태.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoView {
    #[serde(flatten)]
    pub todo: Todo,
    /// `rocky-12` — 보드 접두사를 포함한 완전 참조.
    pub r#ref: String,
    /// 보관되지 않은 댓글 수 — 목록의 배지용.
    pub comment_count: i64,
    /// 가장 최근 댓글 시각(ISO). 댓글이 없으면 생략.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_comment_at: Option<String>,
    /// **부재 = 판정하지 않았다** — unknown 과 같게 다룬다.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub doing_state: Option<DoingState>,
}

/// 응답 전용 note. 글로벌 메모는 보드 대신 예약 접두사가 붙어 `note-3` 이 된다.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteView {
    #[serde(flatten)]
    pub note: Note,
    pub r#ref: String,
}

/// board key 가 `<key>-<number>` 를 되읽을 수 있는 모양인지 — 빈 문자열·공백 포함·`#`
/// 포함·예약어 `note` 를 거른다. 걸리는 보드의 항목은 `ref_of` 가 raw id 로 폴백한다.
pub fn is_ref_safe_board_key(key: &str) -> bool {
    !key.is_empty()
        && !key.chars().any(|c| c == '#' || c.is_whitespace())
        && key != GLOBAL_NOTE_PREFIX
}

/// boardId + number 로 사람이 읽는 참조 문자열 — `rocky-12`, 글로벌 메모는 `note-3`.
///
/// board key 가 안전하지 않으면 raw id 로 폴백한다 — 못 읽거나 다른 행을 가리키는
/// 문자열을 내보내지 않기 위해서다.
///
/// boardId 는 있는데 보드가 없으면(FK 깨짐) 에러 — 조용히 `note-12` 같은 위조 참조를
/// 만들면 진짜 글로벌 엔티티와 구분이 안 된다.
pub fn ref_of(
    store: &TodoStore,
    board_id: Option<&str>,
    number: i64,
    id: &str,
) -> StoreResult<String> {
    let Some(board_id) = board_id else {
        return Ok(format!("{GLOBAL_NOTE_PREFIX}-{number}"));
    };
    let Some(key) = store.board_key_of(board_id)? else {
        return Err(crate::store::StoreError::new(format!(
            "cannot build ref: board not found for boardId {board_id}"
        )));
    };
    if !is_ref_safe_board_key(&key) {
        return Ok(id.to_string());
    }
    Ok(format!("{key}-{number}"))
}

/// ref 가 board 컨텍스트를 실제로 소비하는 "맨숫자" 꼴인지 — `resolveRef` 의 bare 분기
/// 조건(`^(#)?(\d+)$` 그리고 `#` 존재 또는 길이 < ID_LENGTH)과 반드시 같아야 한다.
pub fn ref_needs_board_context(r: &str) -> bool {
    let trimmed = r.trim();
    let (hash, digits) = match trimmed.strip_prefix('#') {
        Some(rest) => (true, rest),
        None => (false, trimmed),
    };
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    hash || digits.len() < ID_LENGTH
}

/// 응답용 직렬화 — 저장 모델에 ref 와 댓글 집계를 얹는다. TS `withRef`(todo 오버로드).
pub fn with_ref_todo(store: &TodoStore, todo: Todo) -> StoreResult<TodoView> {
    let r = ref_of(store, Some(&todo.board_id), todo.number, &todo.id)?;
    let stats = store.comment_stats_of(&todo.id)?;
    Ok(TodoView {
        todo,
        r#ref: r,
        comment_count: stats.count,
        last_comment_at: stats.last_at,
        doing_state: None,
    })
}

/// TS `withRef`(note 오버로드).
pub fn with_ref_note(store: &TodoStore, note: Note) -> StoreResult<NoteView> {
    let r = ref_of(store, note.board_id.as_deref(), note.number, &note.id)?;
    Ok(NoteView { note, r#ref: r })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ref_safe_board_key() {
        assert!(is_ref_safe_board_key("rocky-todo"));
        assert!(is_ref_safe_board_key("MyProject"));
        assert!(!is_ref_safe_board_key(""));
        assert!(!is_ref_safe_board_key("my repo"));
        assert!(!is_ref_safe_board_key("a#b"));
        assert!(!is_ref_safe_board_key("note"));
    }

    #[test]
    fn needs_board_context_matches_bare_branch() {
        assert!(ref_needs_board_context("12"));
        assert!(ref_needs_board_context("#12"));
        assert!(ref_needs_board_context("#12345678")); // # 가 있으면 길이 무관
        assert!(!ref_needs_board_context("12345678")); // ID_LENGTH 자 순수 숫자는 id 후보
        assert!(!ref_needs_board_context("rocky-12"));
        assert!(!ref_needs_board_context("rocky#12"));
        assert!(!ref_needs_board_context("921gvwnr"));
        assert!(!ref_needs_board_context(""));
    }
}
