//! actor 분류 — "이 변경을 사람이 했나 에이전트가 했나". TS 원본 `src/actors.ts`.
//!
//! 사람이 누른 `start` 는 핸드오프에 귀속하지 않는 판정(`store`) 등이 이 한 벌을 쓴다.
//! 목록이 갈라지면 같은 actor 가 표면마다 다르게 분류되므로 단일 출처로 둔다.

/// 에이전트로 간주하는 actor 이름.
pub const AGENT_ACTORS: [&str; 5] = ["claude-code", "codex", "opencode", "agent", "rocky"];

/// 이 actor 가 에이전트인가. 모르는 이름은 사람으로 본다.
pub fn is_agent_actor(actor: &str) -> bool {
    AGENT_ACTORS.contains(&actor)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_agents() {
        assert!(is_agent_actor("claude-code"));
        assert!(is_agent_actor("rocky"));
    }

    #[test]
    fn humans_by_default() {
        assert!(!is_agent_actor("logan"));
        assert!(!is_agent_actor(""));
    }
}
