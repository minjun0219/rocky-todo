//! TS `src/cli.test.ts` 의 issue 관련 순수 판정 블록 포팅.

use rocky_todo_cli::commands::{board_key_from_missing_repo_error, is_missing_repo_error};

// 각 케이스는 예전의 느슨한 `/repo/` 판정이 오답을 내는 경우들이다 — 그래야 이 테스트가
// 실제로 판별력을 갖는다는 증거가 된다.

#[test]
fn matches_the_server_message_for_an_unset_board_repo() {
    assert!(is_missing_repo_error(
        "board has no GitHub repo: rocky — 먼저 설정한다 (rocky-todo board repo OWNER/NAME)"
    ));
}

#[test]
fn does_not_match_a_409_whose_issue_url_contains_repo() {
    assert!(!is_missing_repo_error(
        "todo already has a GitHub issue: https://github.com/org/my-repo/issues/12"
    ));
}

#[test]
fn does_not_match_a_gh_auth_failure_that_names_the_repo_scope() {
    assert!(!is_missing_repo_error(
        "error: your token has not been granted the 'repo' scope"
    ));
    assert!(!is_missing_repo_error("gh auth refresh -s repo"));
}

#[test]
fn does_not_match_unrelated_failures() {
    assert!(!is_missing_repo_error("todo not found: abc"));
    assert!(!is_missing_repo_error(""));
}

#[test]
fn extracts_the_board_key_from_the_server_message() {
    assert_eq!(
        board_key_from_missing_repo_error(
            "board has no GitHub repo: rocky-todo — 먼저 설정한다 (rocky-todo board repo OWNER/NAME)"
        )
        .as_deref(),
        Some("rocky-todo")
    );
}

#[test]
fn extracts_a_key_containing_a_hyphen_and_a_dot() {
    assert_eq!(
        board_key_from_missing_repo_error(
            "board has no GitHub repo: my-board.v2 — 먼저 설정한다 (rocky-todo board repo OWNER/NAME)"
        )
        .as_deref(),
        Some("my-board.v2")
    );
}

#[test]
fn returns_none_for_messages_that_are_not_that_error() {
    assert!(board_key_from_missing_repo_error("todo not found: abc").is_none());
    assert!(board_key_from_missing_repo_error("").is_none());
}

#[test]
fn returns_none_when_the_prefix_matches_but_the_separator_is_missing() {
    assert!(board_key_from_missing_repo_error("board has no GitHub repo: rocky").is_none());
}
