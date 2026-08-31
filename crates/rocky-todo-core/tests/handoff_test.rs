//! TS 원본 `src/handoff.test.ts` 포팅.

use rocky_todo_core::handoff::{
    build_handoff_poke, build_handoff_prompt, build_handoff_prompt_from, HandoffPokeInput,
    HandoffPromptInput,
};
use rocky_todo_core::types::*;

fn base() -> ClaimedHandoff {
    ClaimedHandoff {
        handoff: Handoff {
            id: "h1".into(),
            todo_id: "t1".into(),
            session_id: "sess-1".into(),
            session_name: Some("eelpout-a3".into()),
            session_cwd: None,
            note: String::new(),
            actor: "logan".into(),
            status: HandoffStatus::Delivered,
            created_at: "2026-07-26T12:00:00.000Z".into(),
            delivered_at: None,
            delivered_via: None,
            accepted_at: None,
            completed_at: None,
        },
        todo_ref: "rocky-todo#11".into(),
        todo_title: "todo - 에이전트 작업 요청".into(),
        remaining: 0,
    }
}

#[test]
fn prompt_carries_actor_ref_title() {
    let prompt = build_handoff_prompt(&base());
    assert!(prompt.contains("logan → rocky-todo#11"));
    assert!(prompt.contains("todo - 에이전트 작업 요청"));
    assert!(prompt.contains("todo_status"));
}

#[test]
fn prompt_carries_note_when_present() {
    let mut claimed = base();
    claimed.handoff.note = "테스트부터 짜줘".into();
    assert!(build_handoff_prompt(&claimed).contains("메모: 테스트부터 짜줘"));
}

#[test]
fn prompt_has_no_note_line_when_empty() {
    assert!(!build_handoff_prompt(&base()).contains("메모:"));
}

#[test]
fn prompt_mentions_remaining_count() {
    let mut claimed = base();
    claimed.remaining = 2;
    assert!(build_handoff_prompt(&claimed).contains("2건"));
}

#[test]
fn prompt_has_no_remaining_line_when_zero() {
    assert!(!build_handoff_prompt(&base()).contains("대기 중인 요청이"));
}

#[test]
fn prompt_from_builds_same_without_claim() {
    let prompt = build_handoff_prompt_from(&HandoffPromptInput {
        actor: "logan",
        note: "테스트부터",
        todo_ref: "rocky-todo#16",
        todo_title: "세션 띄우기",
        remaining: 0,
    });
    assert!(prompt.contains("logan → rocky-todo#16 \"세션 띄우기\""));
    assert!(prompt.contains("메모: 테스트부터"));
    assert!(!prompt.contains("대기 중인 요청이"));
}

#[test]
fn poke_shape() {
    let poke = build_handoff_poke(&HandoffPokeInput {
        session_name: "eelpout-a3",
        todo_ref: "rocky-todo-11",
        todo_title: "세션 띄우기",
    });
    // to 는 세션 이름
    assert_eq!(poke.to, "eelpout-a3");
    // 참조와 제목으로 어느 건인지 알아볼 수 있다
    assert!(poke.message.contains("rocky-todo-11"));
    assert!(poke.message.contains("세션 띄우기"));
    // 훅 주입이 없어도 착수할 수 있는 폴백
    assert!(poke.message.contains("todo_list { id: \"rocky-todo-11\" }"));
    // 본문(메모·착수 지시)은 싣지 않는다 — 같은 턴의 훅 주입과 겹친다
    assert!(!poke.message.contains("todo_status"));
    assert!(!poke.message.contains("메모:"));
}
