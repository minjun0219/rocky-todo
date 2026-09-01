//! "다음에 뭘 할까" 후보 랭킹 — 순수 함수. TS 원본 `src/next.ts`.
//!
//! 세션 대조는 하지 않는다 — `doing_state` 는 서버가 이미 목록 응답에 얹어 준다.
//! 이 모듈은 그 판정을 **소비**만 한다.

use serde::Serialize;

use crate::doing::DoingState;
use crate::refs::TodoView;
use crate::types::{TodoPriority, TodoStatus};

/// 후보 하나 — 랭킹 점수와 사람이 읽는 근거를 얹는다.
#[derive(Debug, Clone)]
pub struct NextCandidate {
    pub todo: TodoView,
    pub score: i64,
    /// 왜 위로 왔는지 (예: `이어받기(멈춤) · p2`).
    pub reason: String,
}

pub struct RankNextOptions {
    /// 기준 시각(ms) — 마감 D-day 계산의 "오늘". 테스트가 고정한다.
    pub now: i64,
    /// 상위 몇 개까지. None 이면 전부.
    pub limit: Option<usize>,
}

/// CLI 가 기본으로 보여줄 후보 수 — 한 화면에서 훑고 고를 수 있는 상한.
pub const NEXT_DEFAULT_LIMIT: usize = 8;

/// 랭킹 밴드 — **앞 자리가 뒤 자리를 항상 이긴다.** 각 범주를 자리값이 다른 칸(0..99)에
/// 나눠 담아, 하위 범주를 전부 합쳐도 상위 범주의 한 칸을 넘지 못한다.
mod band {
    /// 주인 없는 진행중 — 이어받을 것이 있으면 그게 최우선이다.
    pub const ORPHAN: i64 = 100_000_000;
    pub const DUE: i64 = 1_000_000;
    /// 판정할 수 없는 진행중 — 마감 아래, 우선순위 위.
    pub const DOING: i64 = 10_000;
    pub const PRIORITY: i64 = 100;
    pub const COMMENT: i64 = 1;
}

fn priority_score(p: TodoPriority) -> i64 {
    match p {
        TodoPriority::P1 => 4,
        TodoPriority::P2 => 3,
        TodoPriority::P3 => 2,
        TodoPriority::P4 => 1,
    }
}

fn priority_order(p: TodoPriority) -> i64 {
    match p {
        TodoPriority::P1 => 0,
        TodoPriority::P2 => 1,
        TodoPriority::P3 => 2,
        TodoPriority::P4 => 3,
    }
}

/// 마감이 코앞이라고 볼 기간(일).
const DUE_SOON_DAYS: i64 = 7;
/// 댓글이 "방금 오갔다" 고 볼 기간(일).
const FRESH_COMMENT_DAYS: i64 = 3;

const DAY_MS: i64 = 86_400_000;

/// 열려 있는가 — done/보관은 후보가 아니다.
fn is_open(todo: &TodoView) -> bool {
    todo.todo.status != TodoStatus::Done && todo.todo.archived_at.is_none()
}

/// `YYYY-MM-DD` → 에포크 기준 일수. **달력에 없는 날짜는 None** — `2026-02-31` 같은
/// 값이 있지도 않은 마감으로 D-day 를 찍지 않게 되돌려 대조한다.
fn day_number(date: &str) -> Option<i64> {
    let text: String = date.chars().take(10).collect();
    let bytes = text.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let digits_ok = |range: std::ops::Range<usize>| bytes[range].iter().all(u8::is_ascii_digit);
    if !digits_ok(0..4) || !digits_ok(5..7) || !digits_ok(8..10) {
        return None;
    }
    let y: i32 = text[0..4].parse().ok()?;
    let m: u32 = text[5..7].parse().ok()?;
    let d: u32 = text[8..10].parse().ok()?;
    let date = chrono::NaiveDate::from_ymd_opt(y, m, d)?; // 달력 검증까지 한 번에
    Some(date.and_hms_opt(0, 0, 0)?.and_utc().timestamp_millis() / DAY_MS)
}

/// 기준 시각의 **로컬** 날짜를 같은 일수 축으로 — 마감은 사람이 사는 날짜다.
fn today_number(now: i64) -> i64 {
    use chrono::{Datelike, TimeZone};
    let local = chrono::Local
        .timestamp_millis_opt(now)
        .single()
        .unwrap_or_else(chrono::Local::now);
    let (y, m, d) = (local.year(), local.month(), local.day());
    chrono::NaiveDate::from_ymd_opt(y, m, d)
        .and_then(|date| date.and_hms_opt(0, 0, 0))
        .map(|dt| dt.and_utc().timestamp_millis() / DAY_MS)
        .unwrap_or(0)
}

struct Scored {
    score: i64,
    labels: Vec<String>,
}

fn none_scored() -> Scored {
    Scored {
        score: 0,
        labels: Vec::new(),
    }
}

/// 마감 점수 — 지난 것 > 오늘 > 코앞. 깨진 값은 0점으로 흘린다(랭킹은 조언이고,
/// 조언은 최악의 입력에서도 나와야 한다).
fn due_score(todo: &TodoView, now: i64) -> Scored {
    let Some(due) = &todo.todo.due else {
        return none_scored();
    };
    let Some(day) = day_number(due) else {
        return none_scored();
    };
    let days = day - today_number(now);
    if days < 0 {
        Scored {
            score: 3 * band::DUE,
            labels: vec![format!("마감 D+{}", -days)],
        }
    } else if days == 0 {
        Scored {
            score: 2 * band::DUE,
            labels: vec!["마감 D-day".to_string()],
        }
    } else if days <= DUE_SOON_DAYS {
        Scored {
            score: band::DUE,
            labels: vec![format!("마감 D-{days}")],
        }
    } else {
        none_scored()
    }
}

/// 진행중 점수 — **주인 없는 doing 이 가장 위**. `live` 는 후보에서 아예 빠진다.
fn doing_score(todo: &TodoView) -> Scored {
    if todo.todo.status != TodoStatus::Doing {
        return none_scored();
    }
    match todo.doing_state {
        Some(DoingState::Gone) => Scored {
            score: 2 * band::ORPHAN,
            labels: vec!["이어받기(세션 없음)".to_string()],
        },
        Some(DoingState::Idle) => Scored {
            score: band::ORPHAN,
            labels: vec!["이어받기(멈춤)".to_string()],
        },
        // 판정 불가나 사람이 잡은 doing — "이어받기" 라 부르지 않되 todo 보다는 위.
        _ => Scored {
            score: band::DOING,
            labels: vec![match &todo.todo.doing_by {
                Some(by) => format!("진행중({by})"),
                None => "진행중".to_string(),
            }],
        },
    }
}

/// 우선순위 점수. 라벨은 p1/p2 만 — p3/p4 까지 찍으면 근거 줄이 소음이 된다.
fn priority_scored(todo: &TodoView) -> Scored {
    let p = todo.todo.priority;
    let labels = match p {
        TodoPriority::P1 | TodoPriority::P2 => vec![p.as_str().to_string()],
        _ => Vec::new(),
    };
    Scored {
        score: priority_score(p) * band::PRIORITY,
        labels,
    }
}

/// 최근 댓글 점수 — 보드에서 대화가 오가는 중이면 그쪽이 대개 지금 관심사다.
fn comment_score(todo: &TodoView, now: i64) -> Scored {
    let Some(last) = &todo.last_comment_at else {
        return none_scored();
    };
    let Ok(at) = chrono::DateTime::parse_from_rfc3339(last) else {
        return none_scored();
    };
    let at_ms = at.timestamp_millis();
    if now - at_ms > FRESH_COMMENT_DAYS * DAY_MS {
        return none_scored();
    }
    Scored {
        score: band::COMMENT,
        labels: vec!["최근 댓글".to_string()],
    }
}

fn score_of(todo: &TodoView, now: i64) -> Scored {
    let parts = [
        doing_score(todo),
        due_score(todo, now),
        priority_scored(todo),
        comment_score(todo, now),
    ];
    let mut score = 0;
    let mut labels = Vec::new();
    for part in parts {
        score += part.score;
        labels.extend(part.labels);
    }
    Scored { score, labels }
}

/// 점수 내림차순, 동점은 우선순위 → position → number → ref 로 완전히 결정.
fn compare(a: &NextCandidate, b: &NextCandidate) -> std::cmp::Ordering {
    b.score
        .cmp(&a.score)
        .then(priority_order(a.todo.todo.priority).cmp(&priority_order(b.todo.todo.priority)))
        .then(a.todo.todo.position.cmp(&b.todo.todo.position))
        .then(a.todo.todo.number.cmp(&b.todo.todo.number))
        .then(a.todo.r#ref.cmp(&b.todo.r#ref))
}

/// 착수 후보를 랭킹해 상위 limit 개. 빠지는 것: done/보관, `Live` doing,
/// **열린 자식을 가진 부모**(우산 항목 — 자식이 전부 done 인 부모는 남는다).
pub fn rank_next(todos: &[TodoView], options: &RankNextOptions) -> Vec<NextCandidate> {
    let umbrellas: std::collections::HashSet<&str> = todos
        .iter()
        .filter(|t| t.todo.parent_id.is_some() && is_open(t))
        .filter_map(|t| t.todo.parent_id.as_deref())
        .collect();
    let mut candidates: Vec<NextCandidate> = todos
        .iter()
        .filter(|t| {
            is_open(t)
                && !umbrellas.contains(t.todo.id.as_str())
                && t.doing_state != Some(DoingState::Live)
        })
        .map(|t| {
            let Scored { score, labels } = score_of(t, options.now);
            NextCandidate {
                todo: t.clone(),
                score,
                reason: if labels.is_empty() {
                    "대기 중".to_string()
                } else {
                    labels.join(" · ")
                },
            }
        })
        .collect();
    candidates.sort_by(compare);
    match options.limit {
        None => candidates,
        Some(limit) => {
            candidates.truncate(limit);
            candidates
        }
    }
}

/// `summary` 로 자를 길이.
const SUMMARY_MAX: usize = 160;

/// `--json` 이 내보내는 후보 하나 — **TodoView 전체가 아니다** (고르는 데 필요한 것만).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NextCandidateJson {
    pub r#ref: String,
    pub number: i64,
    pub board: String,
    pub title: String,
    /// `NextCandidate.reason` 그대로.
    pub reason: String,
    pub priority: TodoPriority,
    pub status: TodoStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub due: Option<String>,
    pub labels: Vec<String>,
    pub comment_count: i64,
    /// description 을 한 줄로 눌러 SUMMARY_MAX 자까지. 없으면 필드 자체가 없다.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
}

/// 공백류를 단일 공백으로 눌러 한 줄로 — 개행 든 제목이 가짜 후보로 보이는 오선택 방지.
fn flatten(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// 여러 줄 markdown 을 한 줄로 눌러 max 자까지. 자르면 `…`.
fn condense(text: &str, max: usize) -> Option<String> {
    let flat = flatten(text);
    if flat.is_empty() {
        return None;
    }
    let chars: Vec<char> = flat.chars().collect();
    if chars.len() <= max {
        Some(flat)
    } else {
        let cut: String = chars[..max].iter().collect();
        Some(format!("{}…", cut.trim_end()))
    }
}

/// 후보를 `--json` 출력용 컴팩트 형태로. 보드 못 찾으면 빈 문자열(던지지 않는다).
pub fn to_json_candidates(
    candidates: &[NextCandidate],
    board_key_of: impl Fn(&str) -> Option<String>,
) -> Vec<NextCandidateJson> {
    candidates
        .iter()
        .map(|c| NextCandidateJson {
            r#ref: c.todo.r#ref.clone(),
            number: c.todo.todo.number,
            board: board_key_of(&c.todo.todo.board_id).unwrap_or_default(),
            title: c.todo.todo.title.clone(),
            reason: c.reason.clone(),
            priority: c.todo.todo.priority,
            status: c.todo.todo.status,
            due: c.todo.todo.due.clone(),
            labels: c.todo.todo.labels.clone(),
            comment_count: c.todo.comment_count,
            summary: condense(&c.todo.todo.description, SUMMARY_MAX),
        })
        .collect()
}

/// 후보 목록 컴팩트 렌더 — 한 줄에 `번호. ref  제목  — 근거`. **한 후보는 반드시 한 줄.**
pub fn format_next_candidates(candidates: &[NextCandidate]) -> String {
    if candidates.is_empty() {
        return "착수할 후보가 없다 — 열린 항목이 없거나, 남은 것이 전부 다른 세션에 잡혀 있다"
            .to_string();
    }
    candidates
        .iter()
        .enumerate()
        .map(|(i, c)| {
            format!(
                "{}. {}  {}  — {}",
                i + 1,
                c.todo.r#ref,
                flatten(&c.todo.todo.title),
                c.reason
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}
