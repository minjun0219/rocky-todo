//! TS 원본 `src/next.test.ts` 포팅.

use rocky_todo_core::next::{
    format_next_candidates, rank_next, to_json_candidates, NextCandidate, RankNextOptions,
    NEXT_DEFAULT_LIMIT,
};
use rocky_todo_core::refs::TodoView;
use rocky_todo_core::types::*;
use std::sync::atomic::{AtomicI64, Ordering};

/// 기준 시각 — 2026-07-30 09:00 로컬.
fn now_ms() -> i64 {
    use chrono::TimeZone;
    chrono::Local
        .with_ymd_and_hms(2026, 7, 30, 9, 0, 0)
        .single()
        .unwrap()
        .timestamp_millis()
}

static SEQ: AtomicI64 = AtomicI64::new(0);

fn todo() -> TodoView {
    let seq = SEQ.fetch_add(1, Ordering::Relaxed) + 1;
    TodoView {
        todo: Todo {
            id: format!("t{seq}"),
            number: seq,
            board_id: "b1".into(),
            section_id: None,
            parent_id: None,
            title: format!("할 일 {seq}"),
            description: String::new(),
            status: TodoStatus::Todo,
            priority: TodoPriority::P4,
            due: None,
            labels: vec![],
            links: vec![],
            doing_by: None,
            doing_since: None,
            doing_session_id: None,
            position: seq,
            created_at: "2026-07-01T00:00:00.000Z".into(),
            updated_at: "2026-07-01T00:00:00.000Z".into(),
            completed_at: None,
            archived_at: None,
        },
        r#ref: format!("rocky-{seq}"),
        comment_count: 0,
        last_comment_at: None,
        doing_state: None,
    }
}

fn rank(todos: &[TodoView], limit: Option<usize>) -> Vec<NextCandidate> {
    rank_next(
        todos,
        &RankNextOptions {
            now: now_ms(),
            limit,
        },
    )
}

fn refs(candidates: &[NextCandidate]) -> Vec<String> {
    candidates.iter().map(|c| c.todo.r#ref.clone()).collect()
}

fn with_due(mut t: TodoView, due: &str) -> TodoView {
    t.todo.due = Some(due.into());
    t
}

fn reason_of(t: TodoView) -> String {
    rank(&[t], None)[0].reason.clone()
}

use rocky_todo_core::doing::DoingState;

#[test]
fn done_and_archived_are_excluded() {
    let open = todo();
    let mut done = todo();
    done.todo.status = TodoStatus::Done;
    let mut archived = todo();
    archived.todo.archived_at = Some("2026-07-20T00:00:00.000Z".into());
    assert_eq!(
        refs(&rank(&[open.clone(), done, archived], None)),
        vec![open.r#ref]
    );
}

#[test]
fn live_doing_is_excluded() {
    let open = todo();
    let mut held = todo();
    held.todo.status = TodoStatus::Doing;
    held.todo.doing_by = Some("claude-code".into());
    held.doing_state = Some(DoingState::Live);
    assert_eq!(refs(&rank(&[open.clone(), held], None)), vec![open.r#ref]);
}

#[test]
fn umbrella_parent_with_open_child_is_excluded() {
    let mut parent = todo();
    parent.todo.priority = TodoPriority::P1;
    let mut child = todo();
    child.todo.parent_id = Some(parent.todo.id.clone());
    assert_eq!(
        refs(&rank(&[parent, child.clone()], None)),
        vec![child.r#ref]
    );
}

#[test]
fn parent_with_all_done_children_stays() {
    let parent = todo();
    let mut child = todo();
    child.todo.parent_id = Some(parent.todo.id.clone());
    child.todo.status = TodoStatus::Done;
    assert_eq!(
        refs(&rank(&[parent.clone(), child], None)),
        vec![parent.r#ref]
    );
}

#[test]
fn orphan_doing_beats_p1() {
    let mut urgent = todo();
    urgent.todo.priority = TodoPriority::P1;
    let mut orphan = todo();
    orphan.todo.status = TodoStatus::Doing;
    orphan.todo.doing_by = Some("claude-code".into());
    orphan.doing_state = Some(DoingState::Gone);
    assert_eq!(
        refs(&rank(&[urgent.clone(), orphan.clone()], None)),
        vec![orphan.r#ref, urgent.r#ref]
    );
}

#[test]
fn gone_beats_idle() {
    let mut idle = todo();
    idle.todo.status = TodoStatus::Doing;
    idle.todo.doing_by = Some("claude-code".into());
    idle.doing_state = Some(DoingState::Idle);
    let mut gone = todo();
    gone.todo.status = TodoStatus::Doing;
    gone.todo.doing_by = Some("claude-code".into());
    gone.doing_state = Some(DoingState::Gone);
    assert_eq!(
        refs(&rank(&[idle.clone(), gone.clone()], None)),
        vec![gone.r#ref, idle.r#ref]
    );
}

#[test]
fn orphan_is_not_overtaken_by_stacked_lower_bands() {
    // 리뷰 반례: 합산 점수였을 때 gone p4 가 마감 지난 p1 + 최근 댓글에 밀렸다.
    let mut orphan = todo();
    orphan.todo.status = TodoStatus::Doing;
    orphan.doing_state = Some(DoingState::Gone);
    let mut loaded = todo();
    loaded.todo.priority = TodoPriority::P1;
    loaded.todo.due = Some("2026-07-20".into());
    loaded.last_comment_at = Some("2026-07-30T08:00:00.000Z".into());
    assert_eq!(
        refs(&rank(&[loaded.clone(), orphan.clone()], None)),
        vec![orphan.r#ref, loaded.r#ref]
    );
}

#[test]
fn due_beats_stacked_priority_and_comments() {
    let due = with_due(todo(), "2026-08-05");
    let mut loaded = todo();
    loaded.todo.priority = TodoPriority::P1;
    loaded.last_comment_at = Some("2026-07-30T08:00:00.000Z".into());
    assert_eq!(
        refs(&rank(&[loaded.clone(), due.clone()], None)),
        vec![due.r#ref, loaded.r#ref]
    );
}

#[test]
fn unjudged_doing_below_due_above_priority() {
    let due = with_due(todo(), "2026-08-05");
    let mut in_progress = todo();
    in_progress.todo.status = TodoStatus::Doing;
    in_progress.todo.doing_by = Some("logan".into());
    let mut urgent = todo();
    urgent.todo.priority = TodoPriority::P1;
    assert_eq!(
        refs(&rank(
            &[urgent.clone(), in_progress.clone(), due.clone()],
            None
        )),
        vec![due.r#ref, in_progress.r#ref, urgent.r#ref]
    );
}

#[test]
fn overdue_beats_p1() {
    let mut urgent = todo();
    urgent.todo.priority = TodoPriority::P1;
    let overdue = with_due(todo(), "2026-07-28");
    assert_eq!(
        refs(&rank(&[urgent.clone(), overdue.clone()], None)),
        vec![overdue.r#ref, urgent.r#ref]
    );
}

#[test]
fn priority_descending() {
    let mut p4 = todo();
    p4.todo.priority = TodoPriority::P4;
    let mut p2 = todo();
    p2.todo.priority = TodoPriority::P2;
    let mut p1 = todo();
    p1.todo.priority = TodoPriority::P1;
    let mut p3 = todo();
    p3.todo.priority = TodoPriority::P3;
    assert_eq!(
        refs(&rank(
            &[p4.clone(), p2.clone(), p1.clone(), p3.clone()],
            None
        )),
        vec![p1.r#ref, p2.r#ref, p3.r#ref, p4.r#ref]
    );
}

#[test]
fn ties_break_by_position_then_number() {
    let mut later = todo();
    later.todo.position = 9;
    let mut earlier = todo();
    earlier.todo.position = 2;
    assert_eq!(
        refs(&rank(&[later.clone(), earlier.clone()], None)),
        vec![earlier.r#ref, later.r#ref]
    );
}

#[test]
fn limit_keeps_top_n() {
    let mut a = todo();
    a.todo.priority = TodoPriority::P1;
    let mut b = todo();
    b.todo.priority = TodoPriority::P2;
    let mut c = todo();
    c.todo.priority = TodoPriority::P3;
    let items = vec![a, b, c];
    assert_eq!(rank(&items, Some(2)).len(), 2);
    assert_eq!(rank(&items, None).len(), 3);
}

#[test]
fn due_labels_read_as_dday() {
    assert_eq!(reason_of(with_due(todo(), "2026-07-30")), "마감 D-day");
    assert_eq!(reason_of(with_due(todo(), "2026-08-02")), "마감 D-3");
    assert_eq!(reason_of(with_due(todo(), "2026-07-27")), "마감 D+3");
}

#[test]
fn far_due_gets_no_label() {
    assert_eq!(reason_of(with_due(todo(), "2026-12-25")), "대기 중");
}

#[test]
fn p3_p4_get_no_priority_label() {
    let mut p2 = todo();
    p2.todo.priority = TodoPriority::P2;
    assert_eq!(reason_of(p2), "p2");
    let mut p3 = todo();
    p3.todo.priority = TodoPriority::P3;
    assert_eq!(reason_of(p3), "대기 중");
}

#[test]
fn reasons_join_strongest_first() {
    let mut item = todo();
    item.todo.status = TodoStatus::Doing;
    item.todo.doing_by = Some("claude-code".into());
    item.doing_state = Some(DoingState::Idle);
    item.todo.priority = TodoPriority::P2;
    item.todo.due = Some("2026-07-31".into());
    item.last_comment_at = Some("2026-07-30T08:00:00.000Z".into());
    assert_eq!(
        reason_of(item),
        "이어받기(멈춤) · 마감 D-1 · p2 · 최근 댓글"
    );
}

#[test]
fn stale_comment_is_no_reason() {
    let mut stale = todo();
    stale.last_comment_at = Some("2026-07-01T00:00:00.000Z".into());
    assert_eq!(reason_of(stale), "대기 중");
}

#[test]
fn unjudged_doing_is_not_called_takeover() {
    let mut human = todo();
    human.todo.status = TodoStatus::Doing;
    human.todo.doing_by = Some("logan".into());
    human.doing_state = Some(DoingState::Unknown);
    assert_eq!(reason_of(human), "진행중(logan)");
}

#[test]
fn broken_due_flows_as_zero_without_panicking() {
    let ranked = rank(&[with_due(todo(), "2026-6")], None);
    assert_eq!(ranked.len(), 1);
    assert_eq!(ranked[0].reason, "대기 중");
}

#[test]
fn nonexistent_calendar_dates_are_not_due() {
    assert_eq!(reason_of(with_due(todo(), "2026-02-31")), "대기 중");
    assert_eq!(reason_of(with_due(todo(), "2026-13-01")), "대기 중");
    assert_eq!(reason_of(with_due(todo(), "2026-00-10")), "대기 중");
    // 경계: 실재 날짜(윤년 포함)는 마감으로 세어진다.
    assert!(reason_of(with_due(todo(), "2026-02-28")).contains("마감 D+"));
    assert!(reason_of(with_due(todo(), "2024-02-29")).contains("마감 D+"));
}

#[test]
fn overdue_only_from_real_dates() {
    assert_eq!(reason_of(with_due(todo(), "2026-07-31")), "마감 D-1");
    assert_eq!(reason_of(with_due(todo(), "2026-07-32")), "대기 중");
}

#[test]
fn empty_board_is_empty() {
    assert!(rank(&[], None).is_empty());
}

// ── toJsonCandidates ──

fn key_of(id: &str) -> Option<String> {
    if id == "b1" {
        Some("rocky-todo".to_string())
    } else {
        None
    }
}

#[test]
fn json_carries_only_selection_fields() {
    let mut item = todo();
    item.todo.title = "오리진 검사".into();
    item.todo.priority = TodoPriority::P2;
    item.todo.description = "본문".into();
    let expected_ref = item.r#ref.clone();
    let expected_number = item.todo.number;
    let rows = to_json_candidates(&rank(&[item], None), key_of);
    let json = serde_json::to_value(&rows[0]).unwrap();
    assert_eq!(
        json,
        serde_json::json!({
            "ref": expected_ref,
            "number": expected_number,
            "board": "rocky-todo",
            "title": "오리진 검사",
            "reason": "p2",
            "priority": "p2",
            "status": "todo",
            "labels": [],
            "commentCount": 0,
            "summary": "본문",
        })
    );
    assert!(json.get("description").is_none());
    assert!(json.get("links").is_none());
    assert!(json.get("doingSessionId").is_none());
}

#[test]
fn summary_flattens_and_truncates_to_160() {
    let mut long = todo();
    long.todo.description = format!("첫 줄\n\n{}", "가".repeat(300));
    let rows = to_json_candidates(&rank(&[long], None), key_of);
    let summary = rows[0].summary.as_ref().unwrap();
    assert!(summary.starts_with("첫 줄 가가가"));
    assert!(summary.ends_with('…'));
    assert_eq!(summary.chars().count(), 161); // 160자 + 말줄임표
}

#[test]
fn empty_description_omits_summary() {
    let rows = to_json_candidates(&rank(&[todo()], None), key_of);
    assert!(rows[0].summary.is_none());
    let json = serde_json::to_value(&rows[0]).unwrap();
    assert!(json.get("summary").is_none());
}

#[test]
fn missing_board_key_falls_back_to_empty_string() {
    let mut orphan_board = todo();
    orphan_board.todo.board_id = "unknown".into();
    let rows = to_json_candidates(&rank(&[orphan_board], None), key_of);
    assert_eq!(rows[0].board, "");
}

// ── formatNextCandidates ──

#[test]
fn one_line_per_candidate() {
    let mut item = todo();
    item.todo.title = "오리진 검사".into();
    item.todo.priority = TodoPriority::P2;
    let ranked = rank(&[item], None);
    assert_eq!(
        format_next_candidates(&ranked),
        format!("1. {}  오리진 검사  — p2", ranked[0].todo.r#ref)
    );
}

#[test]
fn newlines_in_title_are_flattened() {
    let mut nasty = todo();
    nasty.todo.title = "앞줄\n2. 가짜 후보\t뒤줄".into();
    let out = format_next_candidates(&rank(&[nasty], None));
    assert_eq!(out.split('\n').count(), 1);
    assert!(out.contains("앞줄 2. 가짜 후보 뒤줄"));
}

#[test]
fn empty_candidates_explain_why() {
    assert!(format_next_candidates(&[]).contains("후보가 없다"));
}

#[test]
fn default_limit_fits_one_screen() {
    assert_eq!(NEXT_DEFAULT_LIMIT, 8);
}
