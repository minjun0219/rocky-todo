//! "이 doing 이 살아 있나" / "이 핸드오프가 어디까지 갔나" 판정 — 순수 함수.
//! TS 원본 `src/doing.ts`.

use serde::{Deserialize, Serialize};

use crate::actors::is_agent_actor;
use crate::sessions::{match_board, AgentSession, SessionsResult};
use crate::types::{Handoff, HandoffStatus, Todo, TodoStatus};

/// doing 하나의 생존 상태.
///
/// - `Live` — 그 세션이 살아 있고 지금 일하고 있다.
/// - `Idle` — 세션은 살아 있는데 턴이 끝났고 done 이 안 왔다. **방치**다.
/// - `Gone` — 그 세션이 사라졌다.
/// - `Unknown` — 판별할 수 없다. 모르는 것과 없는 것은 다르므로 경고하지 않는다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DoingState {
    Live,
    Idle,
    Gone,
    Unknown,
}

/// `sessionId` 와 짧은 8자 `id` 를 **둘 다** 본다 — spawn 세션은 짧은 id 로 저장된다.
fn find_session<'a>(sessions: &'a [AgentSession], identifier: &str) -> Option<&'a AgentSession> {
    sessions
        .iter()
        .find(|s| s.session_id == identifier || s.id.as_deref() == Some(identifier))
}

fn state_of_session(session: &AgentSession) -> DoingState {
    // background 세션은 끝나도 잠시 목록에 남는다 — 있지만 죽은 것이다.
    if session.state.as_deref() == Some("done") {
        return DoingState::Gone;
    }
    if session.status == "busy" {
        DoingState::Live
    } else {
        DoingState::Idle
    }
}

/// doing 인 todo 의 생존 상태를 판정한다. 세션 귀속이 있으면 그 세션 하나만, 없으면
/// (에이전트 actor 일 때만) 보드 근사 — 그 보드에 활성 세션이 0개일 때만 `Gone`.
pub fn resolve_doing_state(todo: &Todo, board_key: &str, sessions: &SessionsResult) -> DoingState {
    if todo.status != TodoStatus::Doing {
        return DoingState::Unknown;
    }
    // 세션 목록을 못 얻는 환경에서는 아무것도 단정할 수 없다.
    if !sessions.available {
        return DoingState::Unknown;
    }
    if let Some(session_id) = &todo.doing_session_id {
        return match find_session(&sessions.sessions, session_id) {
            Some(session) => state_of_session(session),
            None => DoingState::Gone,
        };
    }
    match &todo.doing_by {
        Some(actor) if is_agent_actor(actor) => {
            if match_board(&sessions.sessions, board_key).is_empty() {
                DoingState::Gone
            } else {
                DoingState::Unknown
            }
        }
        _ => DoingState::Unknown,
    }
}

/// 핸드오프가 어디까지 갔는지 — 타임스탬프에서 파생한다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum HandoffPhase {
    Pending,
    Delivered,
    Accepted,
    Completed,
    Cancelled,
}

/// 저장된 상태·타임스탬프를 한 단계로 접는다 — status enum 을 늘리지 않은 대가.
pub fn handoff_phase(handoff: &Handoff) -> HandoffPhase {
    match handoff.status {
        HandoffStatus::Cancelled => HandoffPhase::Cancelled,
        HandoffStatus::Pending => HandoffPhase::Pending,
        HandoffStatus::Delivered => {
            if handoff.completed_at.is_some() {
                HandoffPhase::Completed
            } else if handoff.accepted_at.is_some() {
                HandoffPhase::Accepted
            } else {
                HandoffPhase::Delivered
            }
        }
    }
}

/// "집어갔는데 아무 일도 안 일어났다" 인가. **시간 임계값을 쓰지 않는다** — 세션이
/// 사라졌거나 idle 인데 착수 기록이 없을 때만 경고다. 판별 불가면 false.
pub fn is_unstarted(handoff: &Handoff, sessions: &SessionsResult) -> bool {
    if handoff.status != HandoffStatus::Delivered || handoff.accepted_at.is_some() {
        return false;
    }
    if !sessions.available {
        return false;
    }
    match find_session(&sessions.sessions, &handoff.session_id) {
        None => true,
        Some(session) => state_of_session(session) != DoingState::Live,
    }
}
