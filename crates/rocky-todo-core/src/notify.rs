//! UserPromptSubmit 훅의 순수 로직 — TS 원본 `src/notify.ts`.
//!
//! "마지막 확인 이후 호출자(사람)가 보드에서 무엇을 바꿨나"를 컴팩트한 한국어
//! 컨텍스트로 만든다. 훅 엔트리(CLI 의 `hook notify-todo`)는 데몬 HTTP 호출 +
//! stdin/stdout 배선만 담당한다.
//!
//! 커서는 세션별 — `<dir>/hook-cursors.json` 에 `{ sessionId: { lastId, at } }` 로
//! 저장하고 최근 100 세션만 유지한다 (무한 성장 방지).

use std::collections::HashSet;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::actors::is_agent_actor;
use crate::types::{ChangeFeedEntry, HistoryEntity};

/// 사람이 낸 변경만 남긴다 (에이전트 자신의 변경을 주입하는 자기 반향 방지).
///
/// handoff 계열 액션은 여기까지 오지 않는다 — `list_changes_since` 가 쿼리에서 이미
/// 뺀다. `handoff-delivered` 의 actor 는 **대상 세션 이름**(`eelpout-a3`)이라 이름만
/// 보면 사람으로 분류될 값인데, 그 필터 덕에 여기서 한 번 더 막을 필요가 없다.
pub fn filter_human_changes(entries: Vec<ChangeFeedEntry>) -> Vec<ChangeFeedEntry> {
    entries
        .into_iter()
        .filter(|e| !is_agent_actor(&e.history.actor))
        .collect()
}

fn action_label(action: &str) -> &str {
    match action {
        "create" => "생성",
        "update" => "수정",
        "start" => "시작",
        "stop" => "중단",
        "done" => "완료",
        "reopen" => "다시 열기",
        "archive" => "보관",
        "unarchive" => "보관 해제",
        "comment-archive" => "댓글 보관",
        "comment-unarchive" => "댓글 보관 해제",
        other => other,
    }
}

/// 본문을 실어 보여주는 액션 — 나머지는 `field: old → new` 렌더를 탄다.
///
/// `DETAIL_HISTORY_EXCLUDED` 와 값이 우연히 같지만 여기는 별개의 결정("본문을 한 줄로
/// 인라인 렌더할까")을 인코딩한다 — 저쪽은 "상세 화면에서 뺄까"다. 커플링하지 않는다.
fn is_comment_action(action: &str) -> bool {
    action == "comment" || action == "comment-edit"
}

/// 주입 컨텍스트가 길어지지 않게 본문 길이를 제한한다.
const COMMENT_MAX_CHARS: usize = 200;

/// 댓글 본문을 한 줄로 접고 길면 자른다.
fn condense_body(body: &str) -> String {
    let one_line = body.split_whitespace().collect::<Vec<_>>().join(" ");
    let chars: Vec<char> = one_line.chars().collect();
    if chars.len() > COMMENT_MAX_CHARS {
        let head: String = chars[..COMMENT_MAX_CHARS].iter().collect();
        format!("{head}…")
    } else {
        one_line
    }
}

/// JS `String(value)` 대응 — 문자열은 따옴표 없이, 나머지는 JSON 표기로.
fn js_string(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Null => "null".to_string(),
        other => other.to_string(),
    }
}

fn format_line(entry: &ChangeFeedEntry) -> String {
    let board = entry
        .board_key
        .as_deref()
        .map(|k| format!("[{k}] "))
        .unwrap_or_default();
    let short_id: String = entry.history.entity_id.chars().take(6).collect();

    if is_comment_action(&entry.history.action) {
        // 댓글은 문장이라 `field: old → new` 렌더가 맞지 않는다 — 본문을 그대로 보여준다.
        let body = entry
            .history
            .changes
            .as_ref()
            .and_then(|c| c.get("comment"))
            .and_then(|pair| pair.get(1))
            .and_then(|v| v.as_str())
            .map(condense_body)
            .unwrap_or_default();
        let label = if entry.history.action == "comment" {
            "댓글"
        } else {
            "댓글 수정"
        };
        return format!(
            "- {}: {board}\"{}\" {label} · \"{body}\" · {short_id}",
            entry.history.actor, entry.title
        );
    }

    let kind = match entry.history.entity {
        HistoryEntity::Note => "메모 ",
        HistoryEntity::Todo => "",
        HistoryEntity::Board => "board ",
        HistoryEntity::Section => "section ",
    };
    let action = action_label(&entry.history.action);
    let (diff, has_content) = match entry.history.changes.as_ref() {
        Some(changes) => {
            let rendered = changes
                .iter()
                .filter(|(field, _)| field.as_str() != "content") // 메모 본문 diff 는 장황 — 필드명만
                .map(|(field, pair)| {
                    let old = pair.get(0).map(js_string).unwrap_or_default();
                    let new = pair.get(1).map(js_string).unwrap_or_default();
                    format!("{field}: {old} → {new}")
                })
                .take(3)
                .collect::<Vec<_>>()
                .join(", ");
            (rendered, changes.contains_key("content"))
        }
        None => (String::new(), false),
    };
    let diff_part = if !diff.is_empty() {
        format!(" ({diff})")
    } else if has_content {
        " (내용 편집)".to_string()
    } else {
        String::new()
    };
    format!(
        "- {}: {board}{kind}\"{}\" {action}{diff_part} · {short_id}",
        entry.history.actor, entry.title
    )
}

/// 주입할 컨텍스트 본문. 항목이 없으면 `None` (아무 것도 주입하지 않음).
/// 에이전트가 후속 조치를 스스로 판단하도록 안내 한 줄을 붙인다.
pub fn build_notify_context(entries: &[ChangeFeedEntry]) -> Option<String> {
    if entries.is_empty() {
        return None;
    }
    let mut lines = vec![
        "# rocky-todo: 마지막 확인 이후 호출자의 보드 변경".to_string(),
        String::new(),
    ];
    lines.extend(entries.iter().map(format_line));
    lines.push(String::new());
    lines.push(
        "(자동 주입 — 필요하면 todo_list / note_list 로 상세를 확인하고, 지시로 해석되는 항목은 사용자에게 확인 후 진행)"
            .to_string(),
    );
    Some(lines.join("\n"))
}

/// 여러 주입 블록을 하나의 additionalContext 로 합친다 — 사람의 보드 변경과 핸드오프
/// 요청이 같은 프롬프트에 함께 도착할 수 있다. 실을 내용이 없으면 `None`.
pub fn merge_context(parts: &[Option<String>]) -> Option<String> {
    let kept: Vec<&str> = parts
        .iter()
        .filter_map(|p| p.as_deref())
        .filter(|p| !p.is_empty())
        .collect();
    if kept.is_empty() {
        None
    } else {
        Some(kept.join("\n\n"))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CursorEntry {
    last_id: i64,
    at: String,
}

const MAX_CURSOR_SESSIONS: usize = 100;

/// 커서 파일을 읽는다 — 깨졌거나 없으면 빈 목록. **키 순서(삽입 순서)를 보존**해야
/// 하므로 map 이 아니라 vec 으로 다룬다(`write_cursor` 의 동률 처리 전제).
fn read_cursor_file(file: &Path) -> Vec<(String, CursorEntry)> {
    let Ok(raw) = std::fs::read_to_string(file) else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return Vec::new();
    };
    let Some(object) = value.as_object() else {
        return Vec::new();
    };
    object
        .iter()
        .filter_map(|(key, entry)| {
            let last_id = entry.get("lastId")?.as_i64()?;
            let at = entry.get("at")?.as_str()?.to_string();
            Some((key.clone(), CursorEntry { last_id, at }))
        })
        .collect()
}

/// 세션의 마지막 확인 지점. 기록이 없으면 `None` (첫 프롬프트).
pub fn read_cursor(file: &Path, session_id: &str) -> Option<i64> {
    read_cursor_file(file)
        .into_iter()
        .find(|(key, _)| key == session_id)
        .map(|(_, entry)| entry.last_id)
}

/// 세션 커서를 기록하고 최근 100 세션만 남긴다.
///
/// `at` 은 밀리초라 여러 세션이 같은 값을 갖기 쉬워 동률을 **삽입 순서**로 깬다 —
/// reverse 로 최신 삽입을 앞에 두고 stable sort(동률 유지)로 최신이 살아남게 한다.
/// 자르고 나서 다시 reverse 해 "파일의 키 순서 = 삽입 순서(오래된 것 먼저)" 전제를
/// 되돌려 저장한다. 정렬된 순서를 그대로 쓰면 다음 호출의 reverse 가 전제를 잃고
/// 동률 그룹이 매 호출 뒤집혀 slice 가 임의 구간을 잘라낸다.
pub fn write_cursor(file: &Path, session_id: &str, last_id: i64) {
    let mut all = read_cursor_file(file);
    all.retain(|(key, _)| key != session_id);
    all.push((
        session_id.to_string(),
        CursorEntry {
            last_id,
            at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        },
    ));

    all.reverse();
    all.sort_by(|(_, a), (_, b)| b.at.cmp(&a.at)); // 최신 먼저, 동률은 삽입 역순(=최신 삽입 먼저) 유지
    all.truncate(MAX_CURSOR_SESSIONS);
    all.reverse();

    // 삽입 순서를 유지한 채 JSON 오브젝트로 — preserve_order 라 Map 이 순서를 지킨다.
    let mut object = serde_json::Map::new();
    let mut seen: HashSet<&str> = HashSet::new();
    for (key, entry) in &all {
        if seen.insert(key.as_str()) {
            object.insert(
                key.clone(),
                serde_json::json!({ "lastId": entry.last_id, "at": entry.at }),
            );
        }
    }
    if let Some(parent) = file.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(
        file,
        serde_json::to_string(&serde_json::Value::Object(object)).unwrap_or_default(),
    );
}
