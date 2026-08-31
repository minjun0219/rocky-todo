//! TS 원본 `src/sessions.test.ts` 의 파싱·매칭 구간 포팅.
//! (RunCommand 실행·TTL 캐시는 데몬 쪽이라 Phase 2 에서 포팅한다.)

use rocky_todo_core::sessions::{match_board, parse_sessions, SessionsResult};

const SAMPLE: &str = r#"[
  {"pid":19921,"cwd":"/Users/minjun/dev/workspaces/rocky-todo","kind":"interactive","startedAt":1784964736538,"sessionId":"bc29bdd3-ba90-4547-96eb-9db0af935e6c","name":"rocky-todo-1e","status":"idle"},
  {"pid":32551,"cwd":"/Users/minjun/orca/workspaces/rocky-todo/eelpout","kind":"interactive","startedAt":1785067158470,"sessionId":"5591d3d2-9ac5-49c4-96b2-2b3e7bdcfce6","name":"eelpout-a3","status":"busy"}
]"#;

const SAMPLE_BACKGROUND: &str = r#"[
  {"pid":24075,"id":"5acaaaeb","cwd":"/repo/.claude/worktrees/todo-16","kind":"background","startedAt":1785151478042,"sessionId":"5acaaaeb-1275-48d1-8f4c-3970c33ff6dc","name":"rocky-todo-16","status":"idle","state":"done"}
]"#;

#[test]
fn parses_agents_json() {
    let result = parse_sessions(SAMPLE);
    assert!(result.available);
    assert_eq!(result.sessions.len(), 2);
    assert_eq!(result.sessions[0].name, "rocky-todo-1e");
    assert_eq!(result.sessions[1].status, "busy");
}

#[test]
fn empty_array_is_available_with_no_sessions() {
    let result = parse_sessions("[]");
    assert!(result.available);
    assert!(result.sessions.is_empty());
}

#[test]
fn run_failure_maps_to_unavailable_with_reason() {
    // 실행 실패 → 호출자(데몬)가 이 헬퍼로 만든다.
    let result = SessionsResult::unavailable("command not found");
    assert!(!result.available);
    assert!(result
        .reason
        .as_deref()
        .unwrap()
        .contains("command not found"));
    assert!(result.sessions.is_empty());
}

#[test]
fn broken_json_is_unavailable() {
    let result = parse_sessions("not json");
    assert!(!result.available);
    assert!(result.sessions.is_empty());
}

#[test]
fn rows_missing_required_fields_are_skipped() {
    let mixed = r#"[{"pid":1},{"pid":19921,"cwd":"/x","kind":"interactive","startedAt":0,"sessionId":"s","name":"rocky-todo-1e","status":"idle"}]"#;
    let result = parse_sessions(mixed);
    assert_eq!(result.sessions.len(), 1);
    assert_eq!(result.sessions[0].name, "rocky-todo-1e");
}

#[test]
fn match_board_by_path_segment_including_worktrees() {
    let sessions = parse_sessions(SAMPLE).sessions;
    let matched: Vec<_> = match_board(&sessions, "rocky-todo")
        .iter()
        .map(|s| s.name.clone())
        .collect();
    assert_eq!(matched, vec!["rocky-todo-1e", "eelpout-a3"]);
}

#[test]
fn match_board_counts_middle_segments() {
    let sessions = parse_sessions(SAMPLE).sessions;
    let matched: Vec<_> = match_board(&sessions, "eelpout")
        .iter()
        .map(|s| s.name.clone())
        .collect();
    assert_eq!(matched, vec!["eelpout-a3"]);
}

#[test]
fn match_board_no_match_is_empty() {
    let sessions = parse_sessions(SAMPLE).sessions;
    assert!(match_board(&sessions, "forses").is_empty());
}

#[test]
fn match_board_rejects_substring_matches() {
    let sessions = parse_sessions(SAMPLE).sessions;
    assert!(match_board(&sessions, "rocky").is_empty());
}

#[test]
fn background_fields_are_carried() {
    let result = parse_sessions(SAMPLE_BACKGROUND);
    assert_eq!(result.sessions[0].id.as_deref(), Some("5acaaaeb"));
    assert_eq!(result.sessions[0].state.as_deref(), Some("done"));
}

#[test]
fn interactive_sessions_have_no_id_or_state() {
    let result = parse_sessions(SAMPLE);
    assert!(result.sessions[0].id.is_none());
    assert!(result.sessions[0].state.is_none());
}
