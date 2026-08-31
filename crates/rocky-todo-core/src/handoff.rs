//! 핸드오프 주입문/poke 생성 — 순수 함수. TS 원본 `src/handoff.ts`.

use crate::types::ClaimedHandoff;

/// 주입문 재료 — claim 결과에서도, spawn 직전에도 같은 모양으로 만든다.
pub struct HandoffPromptInput<'a> {
    pub actor: &'a str,
    pub note: &'a str,
    pub todo_ref: &'a str,
    pub todo_title: &'a str,
    /// 이 세션 앞에 아직 남은 pending 건수. spawn 은 항상 0 이다.
    pub remaining: i64,
}

/// 세션에 주입할 지시문. todo 본문은 싣지 않는다 — 세션이 `todo_list` 로 직접 읽으면
/// 댓글·히스토리까지 최신으로 본다.
pub fn build_handoff_prompt_from(input: &HandoffPromptInput) -> String {
    let mut lines = vec![
        "# rocky-todo: 보드에서 도착한 작업 요청".to_string(),
        String::new(),
        format!(
            "{} → {} \"{}\"",
            input.actor, input.todo_ref, input.todo_title
        ),
    ];
    if !input.note.is_empty() {
        lines.push(format!("메모: {}", input.note));
    }
    lines.push(String::new());
    lines.push(format!(
        "이 항목을 지금 착수해라. 상세는 todo_list {{ id: \"{}\" }} 로 읽고,",
        input.todo_ref
    ));
    lines.push(format!(
        "착수할 때 todo_status {{ id: \"{}\", action: \"start\" }} 로 표시한다.",
        input.todo_ref
    ));
    if input.remaining > 0 {
        lines.push(format!(
            "(대기 중인 요청이 {}건 더 있다 — 이 건을 마치면 이어서 도착한다.)",
            input.remaining
        ));
    }
    lines.join("\n")
}

/// 대상 세션의 **턴을 여는** 짧은 신호 — `SendMessage` 로 보낸다.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct HandoffPoke {
    /// `SendMessage` 의 `to` — 세션 이름.
    pub to: String,
    /// `SendMessage` 의 `message`.
    pub message: String,
}

pub struct HandoffPokeInput<'a> {
    pub session_name: &'a str,
    pub todo_ref: &'a str,
    pub todo_title: &'a str,
}

/// poke 문구 — 짧게 둔다(같은 턴의 훅 주입과 중복 방지). 다만 주입이 실패해도 굴러가야
/// 하니 이것만 읽고도 착수할 수 있을 만큼은 남긴다.
pub fn build_handoff_poke(input: &HandoffPokeInput) -> HandoffPoke {
    HandoffPoke {
        to: input.session_name.to_string(),
        message: [
            format!(
                "# rocky-todo: 보드에서 작업 요청이 도착했다 — {} \"{}\"",
                input.todo_ref, input.todo_title
            ),
            String::new(),
            "이 메시지는 턴을 여는 신호다. 상세 지시는 같은 턴의 훅 주입으로 함께 도착한다 —"
                .to_string(),
            format!(
                "주입이 보이지 않으면 todo_list {{ id: \"{}\" }} 로 직접 읽고 착수해라.",
                input.todo_ref
            ),
        ]
        .join("\n"),
    }
}

/// claim 결과로 주입문을 만든다 — 훅(Stop / UserPromptSubmit)이 쓰는 입구.
pub fn build_handoff_prompt(claimed: &ClaimedHandoff) -> String {
    build_handoff_prompt_from(&HandoffPromptInput {
        actor: &claimed.handoff.actor,
        note: &claimed.handoff.note,
        todo_ref: &claimed.todo_ref,
        todo_title: &claimed.todo_title,
        remaining: claimed.remaining,
    })
}
