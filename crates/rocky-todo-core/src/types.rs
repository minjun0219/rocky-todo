//! 도메인 타입 — TS 원본 `src/store.ts` 상단 선언부.
//!
//! 직렬화 계약: JSON 은 camelCase 이고, TS 의 `undefined` 필드 생략과 같아지도록
//! `Option` 필드는 `skip_serializing_if` 로 아예 내보내지 않는다 (예: `previousKeys` 는
//! 별칭이 있을 때만 실린다 — 늘 `[]` 가 붙으면 "이름을 바꾼 적 있다"는 신호가 흐려진다).

use serde::{Deserialize, Serialize};

/// history 의 `changes` — `{ field: [before, after] }`.
pub type Changes = serde_json::Map<String, serde_json::Value>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
#[schemars(rename_all = "lowercase")]
pub enum TodoStatus {
    Todo,
    Doing,
    Done,
}

impl TodoStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            TodoStatus::Todo => "todo",
            TodoStatus::Doing => "doing",
            TodoStatus::Done => "done",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "todo" => Some(TodoStatus::Todo),
            "doing" => Some(TodoStatus::Doing),
            "done" => Some(TodoStatus::Done),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
#[schemars(rename_all = "lowercase")]
pub enum TodoPriority {
    P1,
    P2,
    P3,
    P4,
}

impl TodoPriority {
    pub fn as_str(self) -> &'static str {
        match self {
            TodoPriority::P1 => "p1",
            TodoPriority::P2 => "p2",
            TodoPriority::P3 => "p3",
            TodoPriority::P4 => "p4",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "p1" => Some(TodoPriority::P1),
            "p2" => Some(TodoPriority::P2),
            "p3" => Some(TodoPriority::P3),
            "p4" => Some(TodoPriority::P4),
            _ => None,
        }
    }
}

/// `todo_status` / `POST /api/todos/:ref/status` 의 action.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
#[schemars(rename_all = "lowercase")]
pub enum StatusAction {
    Start,
    Stop,
    Done,
    Reopen,
    Archive,
    Unarchive,
}

impl StatusAction {
    pub fn as_str(self) -> &'static str {
        match self {
            StatusAction::Start => "start",
            StatusAction::Stop => "stop",
            StatusAction::Done => "done",
            StatusAction::Reopen => "reopen",
            StatusAction::Archive => "archive",
            StatusAction::Unarchive => "unarchive",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "start" => Some(StatusAction::Start),
            "stop" => Some(StatusAction::Stop),
            "done" => Some(StatusAction::Done),
            "reopen" => Some(StatusAction::Reopen),
            "archive" => Some(StatusAction::Archive),
            "unarchive" => Some(StatusAction::Unarchive),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HistoryEntity {
    Board,
    Section,
    Todo,
    Note,
}

impl HistoryEntity {
    pub fn as_str(self) -> &'static str {
        match self {
            HistoryEntity::Board => "board",
            HistoryEntity::Section => "section",
            HistoryEntity::Todo => "todo",
            HistoryEntity::Note => "note",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "board" => Some(HistoryEntity::Board),
            "section" => Some(HistoryEntity::Section),
            "todo" => Some(HistoryEntity::Todo),
            "note" => Some(HistoryEntity::Note),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HandoffStatus {
    Pending,
    Delivered,
    Cancelled,
}

impl HandoffStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            HandoffStatus::Pending => "pending",
            HandoffStatus::Delivered => "delivered",
            HandoffStatus::Cancelled => "cancelled",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "pending" => Some(HandoffStatus::Pending),
            "delivered" => Some(HandoffStatus::Delivered),
            "cancelled" => Some(HandoffStatus::Cancelled),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HandoffVia {
    Stop,
    Prompt,
    Spawn,
}

impl HandoffVia {
    pub fn as_str(self) -> &'static str {
        match self {
            HandoffVia::Stop => "stop",
            HandoffVia::Prompt => "prompt",
            HandoffVia::Spawn => "spawn",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "stop" => Some(HandoffVia::Stop),
            "prompt" => Some(HandoffVia::Prompt),
            "spawn" => Some(HandoffVia::Spawn),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TodoLink {
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Board {
    pub id: String,
    pub key: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// `owner/name` — GitHub 이슈 생성 대상. 설정 전에는 None.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
    /// 메인 레포의 절대경로 — 백그라운드 세션을 띄우는 자리. 설정 전에는 None.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// 옛 key 목록 — 별칭이 있을 때만 실린다(빈 배열을 내보내지 않는다).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_keys: Option<Vec<String>>,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub archived_at: Option<String>,
}

/// `updateBoard` 의 patch — 바깥 `Option` 은 "이 필드를 고치려 했는가"(키 존재 여부),
/// 안쪽 `Option` 은 "지운다"(None = NULL). TS 의 `undefined`/`null` 구분을 그대로 옮겼다.
#[derive(Debug, Clone, Default)]
pub struct BoardPatch {
    pub key: Option<String>,
    pub title: Option<String>,
    pub description: Option<Option<String>>,
    pub repo: Option<Option<String>>,
    pub path: Option<Option<String>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Section {
    pub id: String,
    pub board_id: String,
    pub title: String,
    pub position: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub archived_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Todo {
    pub id: String,
    /// 보드별 순번 — 사람이 읽고 부르는 참조(rocky-12). id 와 달리 보드 안에서만 유일하다.
    pub number: i64,
    pub board_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub section_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    pub title: String,
    pub description: String,
    pub status: TodoStatus,
    pub priority: TodoPriority,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub due: Option<String>,
    pub labels: Vec<String>,
    pub links: Vec<TodoLink>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub doing_by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub doing_since: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub doing_session_id: Option<String>,
    pub position: i64,
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub archived_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: String,
    /// 보드별 순번. 글로벌 메모(board 미소속)는 전역 번호 공간을 따로 갖는다.
    pub number: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub board_id: Option<String>,
    pub title: String,
    pub content: String,
    pub position: i64,
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub archived_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Comment {
    pub id: String,
    pub todo_id: String,
    pub actor: String,
    pub body: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub archived_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Handoff {
    pub id: String,
    pub todo_id: String,
    pub session_id: String,
    /// 표시용 스냅샷 — 세션이 사라지면 sessionId 만으로는 어디로 보냈는지 읽을 수 없다.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_cwd: Option<String>,
    pub note: String,
    pub actor: String,
    pub status: HandoffStatus,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivered_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivered_via: Option<HandoffVia>,
    /// 그 세션이 실제로 착수한 시각 — `start` 귀속이 찍는다.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accepted_at: Option<String>,
    /// 그 todo 가 `done` 된 시각.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
}

#[derive(Debug, Clone)]
pub struct CreateHandoffInput {
    /// todo 참조 문법 (`rocky-12` / 레거시 입력 `#12`·`rocky#12` / id / id prefix).
    pub todo_ref: String,
    pub session_id: String,
    pub session_name: Option<String>,
    pub session_cwd: Option<String>,
    pub note: Option<String>,
    pub actor: String,
    pub current_board_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct CreateSpawnedHandoffInput {
    pub todo_ref: String,
    /// 짧은 id(8자) — 사용자가 `claude attach/logs/stop/rm` 에 그대로 넣는 값이다.
    pub session_id: String,
    pub session_name: String,
    /// 워크트리 경로. `via='spawn'` 인 행에서는 표시용이 아니라 재사용 대상을 가리킨다.
    pub session_cwd: String,
    pub note: Option<String>,
    pub actor: String,
    pub current_board_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimedHandoff {
    pub handoff: Handoff,
    /// `rocky-todo-11` 형태의 사람이 읽는 참조 (`ref_of` 가 만든다).
    pub todo_ref: String,
    pub todo_title: String,
    /// 이 세션 앞에 아직 남은 pending 건수.
    pub remaining: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: i64,
    pub entity: HistoryEntity,
    pub entity_id: String,
    pub actor: String,
    pub action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub changes: Option<Changes>,
    pub at: String,
}

/// SSE 로 흘리는 변경 이벤트 — 구독자는 payload 를 보지 않고 refetch 만 한다.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeEvent {
    pub entity: HistoryEntity,
    pub entity_id: String,
    pub action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub board_id: Option<String>,
}

/// `/api/changes` 피드 항목 — 히스토리에 엔티티 제목/보드 키를 붙인 형태.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeFeedEntry {
    #[serde(flatten)]
    pub history: HistoryEntry,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub board_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangesSince {
    pub last_id: i64,
    pub entries: Vec<ChangeFeedEntry>,
}

#[derive(Debug, Clone, Default)]
pub struct CreateTodoInput {
    pub board: String,
    pub title: String,
    pub description: Option<String>,
    pub section: Option<String>,
    pub parent_id: Option<String>,
    pub priority: Option<TodoPriority>,
    pub due: Option<String>,
    pub labels: Option<Vec<String>>,
    pub links: Option<Vec<TodoLink>>,
}

/// `updateTodo` 의 patch — `BoardPatch` 와 같은 이중 `Option` 규약.
#[derive(Debug, Clone, Default)]
pub struct UpdateTodoPatch {
    pub title: Option<String>,
    pub description: Option<String>,
    pub priority: Option<TodoPriority>,
    pub due: Option<Option<String>>,
    pub labels: Option<Vec<String>>,
    pub links: Option<Vec<TodoLink>>,
    /// 이름으로 upsert. `None`(또는 공백뿐인 문자열)이면 섹션에서 뺀다 — parentId 와 같은 대칭.
    pub section: Option<Option<String>>,
    pub parent_id: Option<Option<String>>,
}

#[derive(Debug, Clone, Default)]
pub struct CreateNoteInput {
    pub board: Option<String>,
    pub title: String,
    pub content: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum NoteContentMode {
    #[default]
    Set,
    /// 기존 content 뒤에 개행으로 이어 붙인다.
    Append,
}

#[derive(Debug, Clone, Default)]
pub struct UpdateNotePatch {
    pub title: Option<String>,
    pub content: Option<String>,
    pub mode: NoteContentMode,
}

#[derive(Debug, Clone, Default)]
pub struct ListTodosFilter {
    pub board: Option<String>,
    pub status: Option<TodoStatus>,
    pub label: Option<String>,
    pub include_archived: bool,
}

#[derive(Debug, Clone, Default)]
pub struct ListNotesFilter {
    pub board: Option<String>,
    /// true 면 보드 미소속(글로벌) 메모만.
    pub global: bool,
    pub include_archived: bool,
}

#[derive(Debug, Clone, Default)]
pub struct ListHistoryFilter {
    pub entity_id: Option<String>,
    pub entity: Option<HistoryEntity>,
    pub exclude_actions: Vec<String>,
    pub limit: Option<i64>,
}

#[derive(Debug, Clone, Default)]
pub struct ListHandoffsFilter {
    pub board_id: Option<String>,
    pub todo_id: Option<String>,
    pub status: Option<HandoffStatus>,
    /// 아직 결말이 안 난 건 — 대기 중이거나, 배달됐는데 완료되지 않은 것.
    pub open: bool,
}

/// 상세 히스토리에서 빼는 action — 댓글 원문은 comments 로 따로 내려간다.
pub const DETAIL_HISTORY_EXCLUDED: [&str; 2] = ["comment", "comment-edit"];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn board_serializes_camel_case_and_omits_none() {
        let board = Board {
            id: "abc".into(),
            key: "rocky".into(),
            title: "rocky".into(),
            description: None,
            repo: None,
            path: None,
            previous_keys: None,
            created_at: "2026-01-01T00:00:00.000Z".into(),
            archived_at: None,
        };
        let json = serde_json::to_value(&board).unwrap();
        assert_eq!(json["createdAt"], "2026-01-01T00:00:00.000Z");
        // TS 의 undefined 생략과 같아야 한다 — null 로 실리면 계약 위반.
        assert!(json.get("previousKeys").is_none());
        assert!(json.get("repo").is_none());
    }

    #[test]
    fn enums_serialize_lowercase() {
        assert_eq!(
            serde_json::to_string(&TodoStatus::Doing).unwrap(),
            "\"doing\""
        );
        assert_eq!(serde_json::to_string(&TodoPriority::P2).unwrap(), "\"p2\"");
        assert_eq!(
            serde_json::to_string(&HandoffVia::Spawn).unwrap(),
            "\"spawn\""
        );
    }
}
