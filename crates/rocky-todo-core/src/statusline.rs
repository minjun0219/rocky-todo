//! statusline 한 줄 렌더 — 순수 함수. TS 원본 `src/statusline.ts`.
//!
//! 기본값은 전부 **조용한 쪽** — 보여줄 게 없으면 빈 문자열.

/// 이 세션이 지금 `doing` 으로 잡고 있는 항목.
#[derive(Debug, Clone, Default)]
pub struct StatuslineMine {
    pub r#ref: String,
    pub title: String,
    /// 보관되지 않은 댓글 수.
    pub comments: i64,
}

/// 템플릿이 소비하는 재료 전부. 서버 라우트가 채운다.
#[derive(Debug, Clone, Default)]
pub struct StatuslineData {
    pub mine: Option<StatuslineMine>,
    /// 이 세션 앞으로 대기 중인(pending) 핸드오프 수.
    pub inbox: i64,
    /// 보드에서 방치된 doing 수 — `resolve_doing_state` 가 idle/gone 인 것.
    pub stale: i64,
    /// 보드의 전체 doing 수.
    pub doing: i64,
}

/// 기본 템플릿 — 세션 앵커 중심.
pub const DEFAULT_STATUSLINE_TEMPLATE: &str =
    "[⏺ {mine.ref} {mine.title}][ 💬{mine.comments}][  ✉{inbox}][  ⚠{stale}]";

/// 제목 절단 길이.
pub const STATUSLINE_TITLE_MAX: usize = 30;

/// ANSI 이스케이프 도입부 — 템플릿의 `[`/`]` 가 리터럴인지 가르는 유일한 신호.
const ESC: char = '\u{001b}';

/// 제목을 한 줄에 맞게 줄인다. 문자 경계에서 자르고 `…` 로 표시한다.
pub fn truncate_title(title: &str, max: usize) -> String {
    let trimmed = title.trim();
    let chars: Vec<char> = trimmed.chars().collect();
    if chars.len() <= max {
        trimmed.to_string()
    } else {
        let mut out: String = chars[..max].iter().collect();
        out.push('…');
        out
    }
}

/// 0 은 "없음" — 빈 문자열이 되어 자기 그룹을 통째로 지운다.
fn count(n: i64) -> String {
    if n > 0 {
        n.to_string()
    } else {
        String::new()
    }
}

fn values_of(data: &StatuslineData, title_max: usize) -> Vec<(&'static str, String)> {
    vec![
        (
            "mine.ref",
            data.mine
                .as_ref()
                .map(|m| m.r#ref.clone())
                .unwrap_or_default(),
        ),
        (
            "mine.title",
            data.mine
                .as_ref()
                .map(|m| truncate_title(&m.title, title_max))
                .unwrap_or_default(),
        ),
        (
            "mine.comments",
            data.mine
                .as_ref()
                .map(|m| count(m.comments))
                .unwrap_or_default(),
        ),
        ("inbox", count(data.inbox)),
        ("stale", count(data.stale)),
        ("doing", count(data.doing)),
    ]
}

struct Part {
    text: String,
    /// 대괄호 그룹인가 — 안의 알려진 placeholder 가 전부 비면 통째로 사라진다.
    group: bool,
}

/// 템플릿을 리터럴 조각과 대괄호 그룹으로 쪼갠다. **ESC 바로 뒤의 `[`/`]` 는 리터럴**
/// (ANSI 색 `ESC[33m`). 중첩 미지원, 닫히지 않은 `[` 는 리터럴로 되돌린다.
fn split_groups(template: &str) -> Vec<Part> {
    let mut parts = Vec::new();
    let mut buf = String::new();
    let mut in_group = false;
    let mut prev: Option<char> = None;
    for ch in template.chars() {
        let literal_bracket = prev == Some(ESC);
        if ch == '[' && !literal_bracket && !in_group {
            if !buf.is_empty() {
                parts.push(Part {
                    text: std::mem::take(&mut buf),
                    group: false,
                });
            }
            in_group = true;
            prev = Some(ch);
            continue;
        }
        if ch == ']' && !literal_bracket && in_group {
            parts.push(Part {
                text: std::mem::take(&mut buf),
                group: true,
            });
            in_group = false;
            prev = Some(ch);
            continue;
        }
        buf.push(ch);
        prev = Some(ch);
    }
    if in_group {
        parts.push(Part {
            text: format!("[{buf}"),
            group: false,
        });
    } else if !buf.is_empty() {
        parts.push(Part {
            text: buf,
            group: false,
        });
    }
    parts
}

/// `{name}` 치환 — 모르는 placeholder 는 **그대로 남긴다**(오타가 눈에 띄게).
/// 반환: (치환 결과, 그룹 생존 여부 — 알려진 placeholder 가 없거나 하나라도 채워짐).
fn render_part(text: &str, values: &[(&str, String)]) -> (String, bool) {
    let mut known = 0usize;
    let mut filled = 0usize;
    let mut out = String::with_capacity(text.len());
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0usize;
    while i < chars.len() {
        if chars[i] == '{' {
            // `{[a-z][a-z.]*}` 매칭 시도
            let mut j = i + 1;
            let mut name = String::new();
            if j < chars.len() && chars[j].is_ascii_lowercase() {
                name.push(chars[j]);
                j += 1;
                while j < chars.len() && (chars[j].is_ascii_lowercase() || chars[j] == '.') {
                    name.push(chars[j]);
                    j += 1;
                }
            }
            if !name.is_empty() && j < chars.len() && chars[j] == '}' {
                if let Some((_, value)) = values.iter().find(|(k, _)| *k == name) {
                    known += 1;
                    if !value.is_empty() {
                        filled += 1;
                    }
                    out.push_str(value);
                } else {
                    out.push('{');
                    out.push_str(&name);
                    out.push('}');
                }
                i = j + 1;
                continue;
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    (out, known == 0 || filled > 0)
}

/// 템플릿에 데이터를 적용해 statusline 한 줄을 만든다. 문법은 `{name}` 치환과 `[...]`
/// 옵셔널 그룹 둘뿐. 결과는 trim — 보여줄 게 없으면 빈 문자열.
pub fn render_statusline(template: &str, data: &StatuslineData, title_max: usize) -> String {
    let values = values_of(data, title_max);
    let mut out = String::new();
    for part in split_groups(template) {
        let (rendered, keep) = render_part(&part.text, &values);
        if !part.group || keep {
            out.push_str(&rendered);
        }
    }
    out.trim().to_string()
}

/// `boardKeyForCwd` 가 보는 보드 정보.
#[derive(Debug, Clone)]
pub struct BoardLocation {
    pub key: String,
    pub path: Option<String>,
}

/// 끝의 `/` 를 떼어 비교 가능한 꼴로. 루트는 `/` 로 남긴다.
fn normalize_path(path: &str) -> String {
    let stripped = path.trim_end_matches('/');
    if stripped.is_empty() {
        "/".to_string()
    } else {
        stripped.to_string()
    }
}

/// `/a/b` 가 `/a/bc` 에 걸리지 않도록 경로 경계까지 본다.
fn is_under(cwd: &str, path: &str) -> bool {
    let base = normalize_path(path);
    let here = normalize_path(cwd);
    if here == base {
        return true;
    }
    if base == "/" {
        here.starts_with('/')
    } else {
        here.starts_with(&format!("{base}/"))
    }
}

/// cwd 로 보드를 고른다 — `boards.path` 하위(가장 정확) → key 가 cwd 의 경로 세그먼트.
/// 후보가 여럿이면 가장 긴 것(더 구체적인 쪽).
pub fn board_key_for_cwd(boards: &[BoardLocation], cwd: Option<&str>) -> Option<String> {
    let cwd = cwd?;
    let mut by_path: Vec<(&BoardLocation, String)> = boards
        .iter()
        .filter_map(|b| b.path.as_ref().map(|p| (b, normalize_path(p))))
        .filter(|(_, p)| is_under(cwd, p))
        .collect();
    by_path.sort_by_key(|(_, p)| std::cmp::Reverse(p.len()));
    if let Some((board, _)) = by_path.first() {
        return Some(board.key.clone());
    }
    let segments: Vec<&str> = cwd.split('/').collect();
    let mut by_segment: Vec<&BoardLocation> = boards
        .iter()
        .filter(|b| !b.key.is_empty() && segments.contains(&b.key.as_str()))
        .collect();
    by_segment.sort_by_key(|b| std::cmp::Reverse(b.key.len()));
    by_segment.first().map(|b| b.key.clone())
}
