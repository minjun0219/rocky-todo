//! TS `src/cli.test.ts` 의 포맷/경로 블록 포팅.

mod common;

use common::*;
use rocky_todo_cli::format::*;
use rocky_todo_core::types::{TodoLink, TodoPriority, TodoStatus};

/// 테스트 기준 시각 — doing 경과 분이 0 이 되도록 doing_since 와 맞춘다.
const NOW: i64 = 1_753_000_000_000;

// ── withBoard / ref 경로 ─────────────────────────────────────────────────────

#[test]
fn with_board_appends_query_marker() {
    assert_eq!(
        with_board("/api/todos/3", "rocky"),
        "/api/todos/3?board=rocky"
    );
    assert_eq!(
        with_board("/api/todos?includeArchived=true", "rocky"),
        "/api/todos?includeArchived=true&board=rocky"
    );
}

/// ref 는 `#` 을 담을 수 있다(옛 표기). 인코딩하지 않으면 뒤에 붙는 `?board=` 까지
/// fragment 로 잘려 서버에 닿지 않는다.
#[test]
fn todo_ref_path_encodes_the_hash() {
    let path = todo_ref_path("#12", "", "rocky");
    assert!(!path.contains('#'), "{path}");
    assert!(path.contains("%2312"), "{path}");
    assert!(path.ends_with("?board=rocky"), "{path}");
}

#[test]
fn todo_ref_path_keeps_the_suffix_literal() {
    let path = todo_ref_path("rocky-12", "/status", "rocky");
    assert_eq!(path, "/api/todos/rocky-12/status?board=rocky");
}

/// `--global` 이면 board 컨텍스트를 아예 보내지 않아 맨 번호가 전역 메모로 풀린다.
#[test]
fn note_ref_path_drops_board_when_global() {
    assert_eq!(note_ref_path("3", "", "rocky", true), "/api/notes/3");
    assert_eq!(
        note_ref_path("3", "", "rocky", false),
        "/api/notes/3?board=rocky"
    );
}

#[test]
fn board_detail_path_encodes_the_key() {
    assert_eq!(board_detail_path("a.b"), "/api/boards/a.b");
    assert_eq!(board_detail_path("a/b"), "/api/boards/a%2Fb");
}

/// `encodeURIComponent` 와 보존 집합이 같아야 한다 — `!'()*-._~` 는 그대로 남는다.
#[test]
fn encode_uri_component_matches_js_reserved_set() {
    assert_eq!(encode_uri_component("-_.!~*'()"), "-_.!~*'()");
    assert_eq!(encode_uri_component("a b"), "a%20b");
    assert_eq!(encode_uri_component("#12"), "%2312");
    assert_eq!(encode_uri_component("한"), "%ED%95%9C");
}

// ── linkLabel ───────────────────────────────────────────────────────────────

#[test]
fn link_label_shortens_github_issue_and_pull() {
    assert_eq!(link_label("https://github.com/o/r/issues/3"), "r#3");
    assert_eq!(link_label("https://github.com/o/r/pull/9"), "r#9");
}

#[test]
fn link_label_falls_back_to_owner_repo_then_hostname() {
    assert_eq!(link_label("https://github.com/o/r"), "o/r");
    assert_eq!(link_label("https://github.com/o"), "o");
    assert_eq!(link_label("https://app.todoist.com/app/task/1"), "todoist");
    assert_eq!(link_label("https://www.example.com/x"), "example.com");
}

#[test]
fn link_label_returns_the_input_when_unparsable() {
    assert_eq!(link_label("not a url"), "not a url");
}

// ── formatTodoLine ──────────────────────────────────────────────────────────

#[test]
fn todo_status_glyph_and_number_prefix() {
    let line = format_todo_line(&todo_fixture(), 0, NOW);
    assert!(line.contains("○ 1 "), "{line}");
    assert!(line.contains("작업 제목"), "{line}");
}

/// 번호는 접두사 없이 제목 **앞**에 온다.
#[test]
fn number_comes_before_the_title_without_a_prefix() {
    let mut todo = todo_fixture();
    todo.todo.number = 12;
    todo.todo.title = "보드·섹션 생성".into();
    todo.todo.priority = TodoPriority::P2;
    let line = format_todo_line(&todo, 0, NOW);
    assert!(line.contains("12"), "{line}");
    assert!(
        line.find("12").unwrap() < line.find("보드·섹션 생성").unwrap(),
        "{line}"
    );
}

#[test]
fn doing_shows_actor_and_done_shows_check() {
    let mut doing = todo_fixture();
    doing.todo.status = TodoStatus::Doing;
    doing.todo.doing_by = Some("claude-code".into());
    doing.todo.doing_since = Some("2026-07-23T00:00:00.000Z".into());
    let out = format_todo_line(&doing, 0, NOW);
    assert!(out.contains('▶'), "{out}");
    assert!(out.contains("claude-code"), "{out}");

    let mut done = todo_fixture();
    done.todo.status = TodoStatus::Done;
    assert!(format_todo_line(&done, 0, NOW).contains('✓'));
}

#[test]
fn metadata_chips_priority_labels_due_links_and_depth_indent() {
    let mut todo = todo_fixture();
    todo.todo.priority = TodoPriority::P1;
    todo.todo.labels = vec!["bug".into()];
    todo.todo.due = Some("2026-08-01".into());
    todo.todo.links = vec![TodoLink {
        url: "https://github.com/o/r/issues/3".into(),
        title: None,
    }];
    let line = format_todo_line(&todo, 2, NOW);
    assert!(line.contains("p1"), "{line}");
    assert!(line.contains("[bug]"), "{line}");
    assert!(line.contains("~2026-08-01"), "{line}");
    assert!(line.contains("↗r#3"), "{line}");
    assert!(line.starts_with("    "), "{line}");
}

/// p4 는 기본값이라 칩을 만들지 않는다 — 모든 줄에 붙으면 신호가 아니다.
#[test]
fn p4_makes_no_chip() {
    assert!(!format_todo_line(&todo_fixture(), 0, NOW).contains("p4"));
}

#[test]
fn archived_todo_is_marked() {
    let mut todo = todo_fixture();
    todo.todo.archived_at = Some("2026-07-24T00:00:00.000Z".into());
    assert!(format_todo_line(&todo, 0, NOW).contains("(보관됨)"));
}

// ── formatTodoShow ──────────────────────────────────────────────────────────

#[test]
fn show_omits_the_comment_section_when_there_are_none() {
    let out = format_todo_show(&todo_fixture(), &[], &[], NOW);
    assert!(!out.contains("댓글:"), "{out}");
}

/// 각 줄은 `작성시각 actor: 본문` — ISO 의 `T` 는 공백으로 바뀐다.
#[test]
fn comment_lines_carry_stamp_actor_body_with_t_replaced() {
    let comments = vec![comment_fixture(
        "c1",
        "minjun",
        "메모",
        "2026-07-24T09:05:12.000Z",
    )];
    let out = format_todo_show(&todo_fixture(), &[], &comments, NOW);
    assert!(out.contains("댓글:"), "{out}");
    assert!(out.contains("2026-07-24 09:05 minjun: 메모"), "{out}");
    assert!(!out.contains("2026-07-24T09:05"), "{out}");
}

#[test]
fn multiline_comment_body_is_folded_to_one_line() {
    let comments = vec![comment_fixture(
        "c1",
        "claude-code",
        "첫째 줄\n둘째 줄\n\n넷째 줄",
        "2026-07-24T09:05:12.000Z",
    )];
    let out = format_todo_show(&todo_fixture(), &[], &comments, NOW);
    assert!(!out.contains("\n둘째"), "{out}");
    assert!(out.contains("첫째 줄 둘째 줄 넷째 줄"), "{out}");
}

/// comment/comment-edit 만 걸러진다 — archive/unarchive 는 카드가 사라진 뒤라 남아야 한다.
#[test]
fn only_comment_and_comment_edit_are_filtered_from_history() {
    let rows = vec![
        history_fixture(1, "create"),
        history_fixture(2, "comment"),
        history_fixture(3, "comment-edit"),
        history_fixture(4, "comment-archive"),
        history_fixture(5, "comment-unarchive"),
        history_fixture(6, "done"),
    ];
    let out = format_todo_show(&todo_fixture(), &rows, &[], NOW);
    for kept in ["create", "done", "comment-archive", "comment-unarchive"] {
        assert!(out.contains(kept), "{kept} 이 없다:\n{out}");
    }
    let ends_with = |suffix: &str| {
        out.lines()
            .filter(|line| line.trim().ends_with(suffix))
            .count()
    };
    assert_eq!(ends_with(" comment"), 0, "{out}");
    assert_eq!(ends_with(" comment-edit"), 0, "{out}");
}

#[test]
fn comments_are_tailed_to_eight_with_an_omitted_marker() {
    let comments: Vec<_> = (0..12)
        .map(|i| {
            comment_fixture(
                &format!("c{i}"),
                "claude-code",
                &format!("댓글 {i:02}"),
                &format!("2026-07-24T09:{i:02}:00.000Z"),
            )
        })
        .collect();
    let out = format_todo_show(&todo_fixture(), &[], &comments, NOW);
    assert!(out.contains("…외 4개"), "{out}");
    for i in 4..12 {
        assert!(out.contains(&format!("댓글 {i:02}")), "{i} 이 없다");
    }
    for i in 0..4 {
        assert!(!out.contains(&format!("댓글 {i:02}")), "{i} 이 남았다");
    }
}

#[test]
fn history_is_truncated_to_eight_rows() {
    let rows: Vec<_> = (0..12)
        .map(|i| history_fixture(i + 1, &format!("action-{i}")))
        .collect();
    let out = format_todo_show(&todo_fixture(), &rows, &[], NOW);
    for i in 0..8 {
        assert!(out.contains(&format!("action-{i}")), "action-{i} 이 없다");
    }
    for i in 8..12 {
        assert!(
            !out.contains(&format!("action-{i}")),
            "action-{i} 이 남았다"
        );
    }
}

// ── renderBoard ─────────────────────────────────────────────────────────────

#[test]
fn unset_board_fields_make_no_lines() {
    assert_eq!(render_board(&board_fixture()), "tally  Tally");
}

#[test]
fn board_shows_description_repo_path_and_previous_keys() {
    let mut board = board_fixture();
    board.description = Some("가계부 앱".into());
    board.repo = Some("minjun0219/tally".into());
    board.path = Some("/dev/tally".into());
    board.previous_keys = Some(vec!["gotgan".into()]);
    let out = render_board(&board);
    assert!(out.contains("가계부 앱"), "{out}");
    assert!(out.contains("https://github.com/minjun0219/tally"), "{out}");
    assert!(out.contains("/dev/tally"), "{out}");
    assert!(out.contains("gotgan"), "{out}");
}

// ── formatSessions ──────────────────────────────────────────────────────────

fn sessions_view(available: bool, sessions: Vec<MatchedSession>) -> SessionsView {
    SessionsView {
        available,
        reason: if available {
            None
        } else {
            Some("claude CLI 가 없다".into())
        },
        sessions,
    }
}

fn session(name: &str, cwd: &str, matched: bool) -> MatchedSession {
    MatchedSession {
        name: name.into(),
        session_id: format!("sess-{name}"),
        status: "idle".into(),
        cwd: cwd.into(),
        matched,
    }
}

#[test]
fn unavailable_sessions_report_the_reason() {
    let out = format_sessions(&sessions_view(false, vec![]));
    assert!(out.contains("claude CLI 가 없다"), "{out}");
}

#[test]
fn empty_session_list_says_so() {
    assert_eq!(
        format_sessions(&sessions_view(true, vec![])),
        "실행 중인 Claude Code 세션이 없다"
    );
}

/// `*` 는 현재 보드와 일치하는 세션.
#[test]
fn matched_sessions_are_starred() {
    let out = format_sessions(&sessions_view(
        true,
        vec![
            session("rocky-todo-1e", "/w/rocky-todo", true),
            session("tally-9a", "/w/tally", false),
        ],
    ));
    let lines: Vec<&str> = out.lines().collect();
    assert!(lines[0].starts_with("* rocky-todo-1e"), "{out}");
    assert!(lines[1].starts_with("  tally-9a"), "{out}");
}

// ── formatSpawnResult / renderHandoffCreated ────────────────────────────────

#[test]
fn spawn_shows_short_id_and_attach_command_when_new() {
    let out = format_spawn_result(
        "rocky-12",
        &SpawnResult {
            handoff: handoff_fixture(),
            reused: false,
            worktree_path: "/w/rocky-todo/.claude/worktrees/todo-12".into(),
            session_short_id: Some("1e2f3a4b".into()),
        },
    );
    assert!(out.contains("1e2f3a4b"), "{out}");
    assert!(out.contains("claude attach 1e2f3a4b"), "{out}");
}

/// 재사용이면 새 세션을 띄우지 않았으므로 attach 명령을 주지 않는다.
#[test]
fn spawn_reuse_queues_into_the_running_session() {
    let out = format_spawn_result(
        "rocky-12",
        &SpawnResult {
            handoff: handoff_fixture(),
            reused: true,
            worktree_path: "/w/rocky-todo".into(),
            session_short_id: None,
        },
    );
    assert!(out.contains("이미 도는 세션"), "{out}");
    assert!(out.contains("rocky-todo-1e"), "{out}");
    assert!(!out.contains("claude attach"), "{out}");
}

/// "보냄"은 거짓말이었다 — 이 시점에 배달된 것은 아무것도 없다.
#[test]
fn handoff_says_plainly_that_delivery_has_not_happened() {
    let created = HandoffCreated {
        handoff: handoff_fixture(),
        poke: Some(HandoffPokeView {
            to: "rocky-todo-1e".into(),
            message: "# rocky-todo: ...".into(),
        }),
    };
    let out = render_handoff_created("rocky-12", &created);
    assert!(out.contains("큐에 넣음"), "{out}");
    assert!(out.contains("아직 배달 전"), "{out}");
    assert!(out.contains("SendMessage"), "{out}");
    assert!(out.contains("rocky-todo-1e"), "{out}");
}

/// poke 를 모르는 구버전 데몬이면 지어내지 않고 무엇이 어긋났는지를 말한다.
#[test]
fn handoff_without_poke_explains_the_version_gap() {
    let created = HandoffCreated {
        handoff: handoff_fixture(),
        poke: None,
    };
    let out = render_handoff_created("rocky-12", &created);
    assert!(out.contains("poke 를 주지 않는다"), "{out}");
    assert!(out.contains("daemon stop"), "{out}");
    assert!(!out.contains("SendMessage"), "{out}");
}

// ── TS 오라클 대조 ──────────────────────────────────────────────────────────
//
// 아래 기대값은 실제 TS(`src/ui/lib.ts` 의 `linkLabel`, JS `encodeURIComponent`)를
// 돌려 받아 적은 것이다. 포팅이 자기모순 없이 도는 것과 원본과 **같은 값**을 내는 것은
// 다르므로, 눈으로 맞춘 게 아니라 원본 출력을 고정한다.

#[test]
fn link_label_matches_the_ts_oracle() {
    let cases = [
        ("https://github.com/o/r/issues/3", "r#3"),
        ("https://github.com/o/r/pull/9", "r#9"),
        ("https://github.com/o/r", "o/r"),
        ("https://github.com/o", "o"),
        ("https://app.todoist.com/app/task/1", "todoist"),
        ("https://www.example.com/x", "example.com"),
        ("not a url", "not a url"),
        // issues/pull 이 아닌 경로는 owner/repo 로 떨어진다.
        ("https://github.com/o/r/commit/abc", "o/r"),
        // 호스트는 소문자로, 포트는 버린다.
        ("http://EXAMPLE.com:8080/p", "example.com"),
    ];
    for (url, expected) in cases {
        assert_eq!(link_label(url), expected, "{url}");
    }
}

#[test]
fn encode_uri_component_matches_the_ts_oracle() {
    let cases = [
        ("-_.!~*'()", "-_.!~*'()"),
        ("a b", "a%20b"),
        ("#12", "%2312"),
        ("한", "%ED%95%9C"),
        ("a/b", "a%2Fb"),
        ("p+q&r=s", "p%2Bq%26r%3Ds"),
    ];
    for (input, expected) in cases {
        assert_eq!(encode_uri_component(input), expected, "{input}");
    }
}

// ── groupAndRender ──────────────────────────────────────────────────────────
//
// TS 에는 이 함수의 테스트가 없었다. 계층·섹션 묶음은 `ls` 의 전부라 포팅하면서 붙인다.

use rocky_todo_core::refs::TodoView;
use rocky_todo_core::types::Section;

fn child_of(parent: &str, id: &str, number: i64, title: &str) -> TodoView {
    let mut todo = todo_fixture();
    todo.todo.id = id.into();
    todo.todo.number = number;
    todo.todo.title = title.into();
    todo.todo.parent_id = Some(parent.into());
    todo
}

fn section(id: &str, title: &str) -> Section {
    Section {
        id: id.into(),
        board_id: "b".into(),
        title: title.into(),
        position: 1,
        archived_at: None,
    }
}

#[test]
fn empty_list_says_so() {
    assert_eq!(group_and_render(&[], &[], &[], false, NOW), "(비어 있음)");
}

#[test]
fn children_are_indented_under_their_parent() {
    let parent = todo_fixture();
    let child = child_of("a1b2c3d4", "kid", 2, "자식");
    let out = group_and_render(&[parent, child], &[], &[], false, NOW);
    let lines: Vec<&str> = out.lines().collect();
    assert!(lines[0].starts_with('○'), "{out}");
    assert!(
        lines[1].starts_with("  "),
        "자식이 들여쓰이지 않았다:\n{out}"
    );
    assert!(lines[1].contains("자식"), "{out}");
}

/// **부모가 목록에 없으면** 자식은 사라지지 않고 루트로 올라온다 — 필터(보관/보드)로
/// 부모가 빠졌을 때 자식이 통째로 안 보이는 사고를 막는다.
#[test]
fn orphaned_child_is_promoted_to_root() {
    let orphan = child_of("없는-부모", "kid", 2, "자식");
    let out = group_and_render(&[orphan], &[], &[], false, NOW);
    assert!(out.contains("자식"), "{out}");
    assert!(!out.starts_with("  "), "루트로 올라와야 한다:\n{out}");
}

#[test]
fn sections_become_headings_and_empty_ones_are_skipped() {
    let mut in_section = todo_fixture();
    in_section.todo.section_id = Some("s1".into());
    in_section.todo.title = "섹션 안".into();
    let loose = {
        let mut t = todo_fixture();
        t.todo.id = "loose".into();
        t.todo.title = "섹션 밖".into();
        t
    };
    let out = group_and_render(
        &[loose, in_section],
        &[section("s1", "진행중"), section("s2", "빈 섹션")],
        &[],
        false,
        NOW,
    );
    assert!(out.contains("# 진행중"), "{out}");
    assert!(
        !out.contains("# 빈 섹션"),
        "빈 섹션은 제목을 만들지 않는다:\n{out}"
    );
    // 섹션 없는 항목이 먼저, 그다음 섹션 제목.
    assert!(
        out.find("섹션 밖").unwrap() < out.find("# 진행중").unwrap(),
        "{out}"
    );
}

/// `--all` 이면 섹션 대신 보드로 묶는다.
#[test]
fn all_view_groups_by_board() {
    let mut a = todo_fixture();
    a.todo.board_id = "b1".into();
    a.todo.title = "A 보드 항목".into();
    let mut b = todo_fixture();
    b.todo.id = "second".into();
    b.todo.board_id = "b2".into();
    b.todo.title = "B 보드 항목".into();

    let mut board_a = board_fixture();
    board_a.id = "b1".into();
    board_a.key = "alpha".into();
    let mut board_b = board_fixture();
    board_b.id = "b2".into();
    board_b.key = "beta".into();
    let mut board_empty = board_fixture();
    board_empty.id = "b3".into();
    board_empty.key = "gamma".into();

    let out = group_and_render(&[a, b], &[], &[board_a, board_b, board_empty], true, NOW);
    assert!(out.contains("# alpha"), "{out}");
    assert!(out.contains("# beta"), "{out}");
    assert!(
        !out.contains("# gamma"),
        "빈 보드는 제목을 만들지 않는다:\n{out}"
    );
}
