//! 활성 Claude Code 세션 목록 — TS 원본 `src/sessions.ts` 의 **순수 부분**.
//!
//! 실제 `claude agents --json` 실행(RunCommand)과 TTL 캐시는 데몬(rocky-todod) 몫이다 —
//! 여기는 출력 파싱과 보드 매칭만 둔다(테스트가 프로세스 없이 계약을 검증한다).

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSession {
    pub pid: i64,
    pub cwd: String,
    /// 'interactive' | 'background' — CLI 가 주는 값을 그대로 둔다.
    pub kind: String,
    /// 짧은 id(8자) — `claude attach/logs/stop/rm` 이 받는 값. background 세션에만 붙는다.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub session_id: String,
    /// 사람이 읽는 세션 이름 (예: `eelpout-a3`).
    pub name: String,
    /// 'idle' | 'busy' — CLI 가 주는 값을 그대로 둔다.
    pub status: String,
    /// background 세션의 수명 상태 — 'working' | 'done'. 없음은 "죽지 않았다".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    pub started_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SessionsResult {
    /// 세션 목록을 얻을 수 있었는가. false 면 이 기능 전체가 비활성이다.
    pub available: bool,
    pub sessions: Vec<AgentSession>,
    /// available 이 false 인 이유 — 사용자에게 그대로 보여준다.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl SessionsResult {
    pub fn unavailable(reason: impl Into<String>) -> Self {
        SessionsResult {
            available: false,
            sessions: Vec::new(),
            reason: Some(reason.into()),
        }
    }
}

fn to_session(value: &serde_json::Value) -> Option<AgentSession> {
    let row = value.as_object()?;
    let pid = row.get("pid")?.as_i64()?;
    let cwd = row.get("cwd")?.as_str()?;
    let session_id = row.get("sessionId")?.as_str()?;
    let name = row.get("name")?.as_str()?;
    Some(AgentSession {
        pid,
        cwd: cwd.to_string(),
        kind: row
            .get("kind")
            .and_then(|v| v.as_str())
            .unwrap_or("interactive")
            .to_string(),
        id: row.get("id").and_then(|v| v.as_str()).map(str::to_string),
        session_id: session_id.to_string(),
        name: name.to_string(),
        status: row
            .get("status")
            .and_then(|v| v.as_str())
            .unwrap_or("idle")
            .to_string(),
        state: row
            .get("state")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        started_at: row.get("startedAt").and_then(|v| v.as_i64()).unwrap_or(0),
    })
}

/// `claude agents --json` 의 stdout 을 세션 목록으로 파싱한다 — TS `listSessions` 의
/// 파싱 절반. 실행 실패는 호출자가 `SessionsResult::unavailable` 로 만든다.
pub fn parse_sessions(stdout: &str) -> SessionsResult {
    let parsed: serde_json::Value = match serde_json::from_str(stdout) {
        Ok(v) => v,
        Err(_) => return SessionsResult::unavailable("claude agents --json 출력을 읽을 수 없다"),
    };
    let Some(items) = parsed.as_array() else {
        return SessionsResult::unavailable("claude agents --json 출력이 배열이 아니다");
    };
    let sessions = items.iter().filter_map(to_session).collect();
    SessionsResult {
        available: true,
        sessions,
        reason: None,
    }
}

/// 보드 key 로 후보 세션을 고른다 — **cwd 의 경로 세그먼트 중 하나가 key 와 정확히
/// 일치**하면 후보다. basename 만 보면 워크트리를 놓친다.
pub fn match_board<'a>(sessions: &'a [AgentSession], board_key: &str) -> Vec<&'a AgentSession> {
    if board_key.is_empty() {
        return Vec::new();
    }
    sessions
        .iter()
        .filter(|s| s.cwd.split('/').any(|seg| seg == board_key))
        .collect()
}
