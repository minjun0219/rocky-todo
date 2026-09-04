//! TS `src/cli.test.ts` 의 `parseFlags` 블록 포팅.

use rocky_todo_cli::flags::{parse_flags, FlagValue};

fn argv(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| (*s).to_string()).collect()
}

#[test]
fn separates_positionals_and_flags() {
    let parsed = parse_flags(&argv(&[
        "add",
        "제목 텍스트",
        "--board",
        "rocky",
        "--priority",
        "p1",
    ]))
    .unwrap();
    assert_eq!(parsed.positionals, vec!["add", "제목 텍스트"]);
    assert_eq!(parsed.str_flag("board"), Some("rocky"));
    assert_eq!(parsed.str_flag("priority"), Some("p1"));
}

#[test]
fn boolean_flags_need_no_value() {
    let parsed = parse_flags(&argv(&["ls", "--all", "--archived", "--json", "--global"])).unwrap();
    for name in ["all", "archived", "json", "global"] {
        assert_eq!(
            parsed.flags.get(name),
            Some(&FlagValue::Bool(true)),
            "{name}"
        );
    }
}

#[test]
fn label_is_comma_split_and_link_accumulates() {
    let parsed = parse_flags(&argv(&[
        "add",
        "x",
        "--label",
        "bug,urgent",
        "--link",
        "https://a.example",
        "--link",
        "https://b.example",
    ]))
    .unwrap();
    assert_eq!(parsed.list_flag("label"), ["bug", "urgent"]);
    assert_eq!(
        parsed.list_flag("link"),
        ["https://a.example", "https://b.example"]
    );
}

/// `link` 는 쪼개지 않는다 — 쿼리스트링의 쉼표가 URL 을 두 동강 내면 안 된다.
#[test]
fn link_is_not_comma_split() {
    let parsed = parse_flags(&argv(&[
        "add",
        "x",
        "--link",
        "https://a.example/?tags=a,b",
    ]))
    .unwrap();
    assert_eq!(parsed.list_flag("link"), ["https://a.example/?tags=a,b"]);
}

/// `label` 조각은 trim 되고 빈 것은 버려진다.
#[test]
fn label_pieces_are_trimmed_and_empties_dropped() {
    let parsed = parse_flags(&argv(&["add", "x", "--label", " bug , ,urgent "])).unwrap();
    assert_eq!(parsed.list_flag("label"), ["bug", "urgent"]);
}

#[test]
fn unknown_flag_errors() {
    let err = parse_flags(&argv(&["ls", "--explode"])).unwrap_err();
    assert!(err.contains("unknown flag"), "{err}");
}

#[test]
fn value_flag_without_value_errors() {
    let err = parse_flags(&argv(&["add", "x", "--board"])).unwrap_err();
    assert!(err.contains("requires a value"), "{err}");
}

#[test]
fn handoff_accepts_session_and_cancel() {
    let parsed = parse_flags(&argv(&[
        "handoff",
        "#1",
        "--session",
        "rocky-todo-1e",
        "--cancel",
    ]))
    .unwrap();
    assert_eq!(parsed.str_flag("session"), Some("rocky-todo-1e"));
    assert!(parsed.bool_flag("cancel"));
}

/// handoff 의 메모는 `--message`(값 플래그)라 history 의 `--note`(불리언)와 겹치지 않는다.
#[test]
fn handoff_message_is_a_value_flag() {
    let parsed = parse_flags(&argv(&["handoff", "#1", "--message", "진행 상황 공유"])).unwrap();
    assert_eq!(parsed.str_flag("message"), Some("진행 상황 공유"));
}

#[test]
fn history_note_is_pure_boolean() {
    let parsed = parse_flags(&argv(&["history", "#1", "--note"])).unwrap();
    assert!(parsed.bool_flag("note"));
}

/// 회귀 가드: `--note` 가 한때 "다음 토큰이 플래그가 아니면 값으로 소비" 하는
/// optional-value 플래그였다. 그때는 뒤따르는 REF 를 삼켜 positionals 에서 사라졌다.
#[test]
fn note_does_not_swallow_the_following_ref() {
    let parsed = parse_flags(&argv(&["history", "--note", "rocky#12"])).unwrap();
    assert!(parsed.bool_flag("note"));
    assert!(parsed.positionals.iter().any(|p| p == "rocky#12"));
}

#[test]
fn app_install_force_is_a_boolean_flag() {
    let parsed = parse_flags(&argv(&["app", "install", "--force"])).unwrap();
    assert!(parsed.bool_flag("force"));
    assert_eq!(parsed.positionals, vec!["app", "install"]);
}
