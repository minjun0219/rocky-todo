//! TS `src/cli.ts` 의 출력 포맷과 경로 헬퍼 포팅 (순수).

use rocky_todo_core::refs::TodoView;
use rocky_todo_core::types::{
    Board, Comment, Handoff, HistoryEntry, TodoPriority, TodoStatus, DETAIL_HISTORY_EXCLUDED,
};

// ── URL 인코딩 ───────────────────────────────────────────────────────────────

/// JS `encodeURIComponent` 와 같은 집합을 남긴다 — `A-Za-z0-9` 와 `-_.!~*'()`.
///
/// 직접 쓰는 이유는 의존성을 늘리지 않기 위해서다. 흔한 percent-encoding 크레이트는
/// 보존 집합이 조금씩 달라(`!`·`'`·`(`·`)` 를 escape 하는 쪽이 많다) 데몬이 되읽는
/// ref 문자열이 TS 시절과 갈릴 수 있다.
pub fn encode_uri_component(input: &str) -> String {
    const KEEP: &[u8] = b"-_.!~*'()";
    let mut out = String::with_capacity(input.len());
    for byte in input.as_bytes() {
        if byte.is_ascii_alphanumeric() || KEEP.contains(byte) {
            out.push(*byte as char);
        } else {
            out.push('%');
            out.push_str(&format!("{byte:02X}"));
        }
    }
    out
}

// ── 경로 헬퍼 ────────────────────────────────────────────────────────────────

/// 경로에 `board=` 를 붙인다. 이미 쿼리스트링이 있으면 `&`, 없으면 `?`.
pub fn with_board(path: &str, board: &str) -> String {
    let sep = if path.contains('?') { '&' } else { '?' };
    format!("{path}{sep}board={}", encode_uri_component(board))
}

/// todo 단건 엔드포인트 — show/update/status/history 넷이 전부 여기를 거친다.
///
/// ref 를 URL 인코딩하는 게 핵심이다: ref 는 `#`(URL fragment 구분자)를 담을 수 있어
/// (옛 표기 맨숫자 `#12` 가 여전히 들어온다) 인코딩하지 않으면 ref 뒷부분과 뒤에 붙는
/// `?board=` 가 통째로 fragment 로 잘린다. 호출부마다 인코딩을 흩어 두면 그중 하나가
/// 되돌려져도 못 잡으므로 넷 다 이 함수를 거친다.
pub fn todo_ref_path(id: &str, suffix: &str, board: &str) -> String {
    let path = format!("/api/todos/{}{suffix}", encode_uri_component(id));
    with_board(&path, board)
}

/// note 단건 엔드포인트. `global` 이면 board 컨텍스트를 보내지 않아 맨 번호가 전역 메모
/// 공간으로 풀리고, 아니면 todos 와 같게 현재 보드로 스코프된다.
pub fn note_ref_path(id: &str, suffix: &str, board: &str, global: bool) -> String {
    let path = format!("/api/notes/{}{suffix}", encode_uri_component(id));
    if global {
        path
    } else {
        with_board(&path, board)
    }
}

/// 보드 단건 엔드포인트 — board key 는 `.` 등을 담을 수 있어 인코딩한다.
pub fn board_detail_path(key: &str) -> String {
    format!("/api/boards/{}", encode_uri_component(key))
}

// ── 링크 라벨 ────────────────────────────────────────────────────────────────

/// URL 에서 host 와 path 를 뽑는다. 파싱 실패면 `None`.
fn split_url(url: &str) -> Option<(String, String)> {
    let rest = url.split("://").nth(1)?;
    let mut parts = rest.splitn(2, ['/', '?', '#']);
    let authority = parts.next()?;
    let host_port = authority.rsplit('@').next()?;
    if host_port.is_empty() {
        return None;
    }
    let host = if let Some(end) = host_port.find(']') {
        host_port[..=end].to_lowercase()
    } else {
        host_port.split(':').next()?.to_lowercase()
    };
    // splitn 이 구분자를 버리므로 path 는 원본에서 다시 잘라 낸다.
    let path = rest
        .get(authority.len()..)
        .unwrap_or("")
        .split(['?', '#'])
        .next()
        .unwrap_or("")
        .to_string();
    Some((host, path))
}

/// 링크 URL → 짧은 출처 라벨 (`repo#12`, `owner/repo`, `todoist`, 호스트명).
pub fn link_label(url: &str) -> String {
    let Some((host, path)) = split_url(url) else {
        return url.to_string();
    };
    if host == "github.com" {
        let segments: Vec<&str> = path.trim_start_matches('/').split('/').collect();
        let owner = segments.first().copied().unwrap_or("");
        let repo = segments.get(1).copied().unwrap_or("");
        let kind = segments.get(2).copied().unwrap_or("");
        let num = segments.get(3).copied().unwrap_or("");
        if !owner.is_empty()
            && !repo.is_empty()
            && (kind == "issues" || kind == "pull")
            && !num.is_empty()
        {
            return format!("{repo}#{num}");
        }
        let joined = format!("{owner}/{repo}");
        return joined.trim_end_matches('/').to_string();
    }
    if host.contains("todoist") {
        return "todoist".to_string();
    }
    host.strip_prefix("www.").unwrap_or(&host).to_string()
}

// ── todo 렌더 ────────────────────────────────────────────────────────────────

fn status_glyph(status: TodoStatus) -> &'static str {
    match status {
        TodoStatus::Todo => "○",
        TodoStatus::Doing => "▶",
        TodoStatus::Done => "✓",
    }
}

/// `○ 12  제목 p1 [label] ~due ↗link (doingBy 12분)` 한 줄. depth 는 2칸 들여쓰기.
///
/// `now_ms` 는 doing 경과 분 계산용 기준 시각 — 순수 함수로 두려고 주입받는다.
pub fn format_todo_line(todo: &TodoView, depth: usize, now_ms: i64) -> String {
    let mut parts: Vec<String> = vec![
        status_glyph(todo.todo.status).to_string(),
        format!("{:<3}", todo.todo.number),
        todo.todo.title.clone(),
    ];
    if todo.todo.priority != TodoPriority::P4 {
        parts.push(priority_str(todo.todo.priority).to_string());
    }
    for label in &todo.todo.labels {
        parts.push(format!("[{label}]"));
    }
    if let Some(due) = todo.todo.due.as_deref().filter(|d| !d.is_empty()) {
        parts.push(format!("~{due}"));
    }
    for link in &todo.todo.links {
        let label = link.title.clone().unwrap_or_else(|| link_label(&link.url));
        parts.push(format!("↗{label}"));
    }
    if todo.todo.status == TodoStatus::Doing {
        if let Some(doing_by) = todo.todo.doing_by.as_deref().filter(|d| !d.is_empty()) {
            let minutes = todo
                .todo
                .doing_since
                .as_deref()
                .and_then(parse_iso_ms)
                .map(|since| (now_ms - since).div_euclid(60_000))
                .unwrap_or(0);
            parts.push(format!("({doing_by} {minutes}분)"));
        }
    }
    if todo.todo.archived_at.is_some() {
        parts.push("(보관됨)".to_string());
    }
    format!("{}{}", "  ".repeat(depth), parts.join(" "))
}

fn priority_str(p: TodoPriority) -> &'static str {
    match p {
        TodoPriority::P1 => "p1",
        TodoPriority::P2 => "p2",
        TodoPriority::P3 => "p3",
        TodoPriority::P4 => "p4",
    }
}

/// ISO 8601 문자열 → epoch millis. 파싱 실패면 `None`.
fn parse_iso_ms(iso: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(iso)
        .ok()
        .map(|dt| dt.timestamp_millis())
}

/// 여러 공백을 한 칸으로 — JS `replace(/\s+/g, ' ')` 대응.
fn collapse_whitespace(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut in_space = false;
    for ch in input.chars() {
        if ch.is_whitespace() {
            if !in_space {
                out.push(' ');
                in_space = true;
            }
        } else {
            out.push(ch);
            in_space = false;
        }
    }
    out
}

/// `show` 의 텍스트 출력 — 상세 + 링크 + 댓글 타임라인 + 히스토리.
pub fn format_todo_show(
    todo: &TodoView,
    history: &[HistoryEntry],
    comments: &[Comment],
    now_ms: i64,
) -> String {
    let mut lines: Vec<String> = vec![todo.r#ref.clone(), format_todo_line(todo, 0, now_ms)];
    if !todo.todo.description.is_empty() {
        lines.push(String::new());
        lines.push(todo.todo.description.clone());
    }
    if !todo.todo.links.is_empty() {
        lines.push(String::new());
        for link in &todo.todo.links {
            lines.push(format!("↗ {}", link.url));
        }
    }
    lines.push(String::new());
    lines.push(format!("id: {}", todo.todo.id));

    if !comments.is_empty() {
        lines.push(String::new());
        lines.push("댓글:".to_string());
        // 오래된 것부터 온 배열이라 최근 8개는 꼬리를 자른다 — 앞쪽(더 오래된)을 버린다.
        let start = comments.len().saturating_sub(8);
        let omitted = start;
        if omitted > 0 {
            lines.push(format!("  …외 {omitted}개"));
        }
        for c in &comments[start..] {
            let stamp = slice_chars(&c.created_at, 16).replace('T', " ");
            lines.push(format!(
                "  {stamp} {}: {}",
                c.actor,
                collapse_whitespace(&c.body)
            ));
        }
    }

    lines.push(String::new());
    lines.push("히스토리:".to_string());
    // comment/comment-edit 은 위 댓글 섹션이 본문까지 보여주니 같은 사건을 한 줄 더 찍지
    // 않는다. comment-archive/comment-unarchive 는 카드가 사라진 뒤라 여기 남아야 한다.
    let rows: Vec<&HistoryEntry> = history
        .iter()
        .filter(|h| !DETAIL_HISTORY_EXCLUDED.contains(&h.action.as_str()))
        .collect();
    for h in rows.iter().take(8) {
        lines.push(format!(
            "  {} {} {}",
            slice_chars(&h.at, 16),
            h.actor,
            h.action
        ));
    }
    lines.join("\n")
}

/// JS `String.prototype.slice(0, n)` 대응 — UTF-16 이 아니라 char 경계로 자른다.
/// 대상이 ISO 타임스탬프(전부 ASCII)라 둘의 결과가 같다.
fn slice_chars(input: &str, n: usize) -> String {
    input.chars().take(n).collect()
}

// ── 세션 / spawn / handoff 렌더 ──────────────────────────────────────────────

/// `GET /api/sessions` 응답 — CLI 와 테스트가 공유하는 뷰 타입.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionsView {
    pub available: bool,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub sessions: Vec<MatchedSession>,
}

/// 세션 한 건 + 현재 보드와 일치하는지.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchedSession {
    pub name: String,
    pub status: String,
    pub cwd: String,
    #[serde(default)]
    pub matched: bool,
}

/// 세션 목록을 컴팩트하게 렌더한다. `*` 는 현재 보드와 일치하는 세션.
pub fn format_sessions(view: &SessionsView) -> String {
    if !view.available {
        let reason = view.reason.as_deref().unwrap_or("알 수 없는 이유");
        return format!("활성 세션 목록을 가져올 수 없다: {reason}");
    }
    if view.sessions.is_empty() {
        return "실행 중인 Claude Code 세션이 없다".to_string();
    }
    view.sessions
        .iter()
        .map(|s| {
            let mark = if s.matched { "*" } else { " " };
            format!("{mark} {}  {}  {}", s.name, s.status, s.cwd)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// `POST /api/todos/:ref/spawn` 응답.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnResult {
    pub handoff: Handoff,
    pub reused: bool,
    pub worktree_path: String,
    #[serde(default)]
    pub session_short_id: Option<String>,
}

/// `spawn` 결과를 사람이 읽는 한두 줄로 렌더한다.
///
/// `reused` 면 이미 도는 세션에 큐잉했다는 문장, 아니면 새 세션 정보 + 그대로 복사해 쓸
/// `claude attach` 명령을 함께 준다. `sessionName` 은 표시용 스냅샷이라 없을 수 있어
/// `sessionId` 로 떨어뜨린다 — 빈 괄호는 어디로 보냈는지 못 읽게 만든다.
pub fn format_spawn_result(r#ref: &str, result: &SpawnResult) -> String {
    if result.reused {
        let target = result
            .handoff
            .session_name
            .as_deref()
            .unwrap_or(&result.handoff.session_id);
        format!(
            "✓ {ref} → 이미 도는 세션({target})에 큐잉 · {}",
            result.worktree_path,
            ref = r#ref
        )
    } else {
        let short = result.session_short_id.as_deref().unwrap_or("");
        format!(
            "✓ {ref} → 새 세션 {short} · {}\n  claude attach {short}",
            result.worktree_path,
            ref = r#ref
        )
    }
}

/// `POST /api/todos/:ref/handoff` 응답 — 생성된 handoff + 대상 세션을 깨울 poke.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HandoffCreated {
    #[serde(flatten)]
    pub handoff: Handoff,
    /// **optional 이다** — CLI 와 데몬의 버전이 갈릴 수 있다. 데몬은 자기 버전이 설치본과
    /// 같으면 경로가 달라도 재기동하지 않으므로 `poke` 를 모르는 데몬이 계속 살아 있을 수
    /// 있고, 그때 이 필드는 오지 않는다.
    #[serde(default)]
    pub poke: Option<HandoffPokeView>,
}

/// 대상 세션을 깨우는 poke.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HandoffPokeView {
    pub to: String,
    pub message: String,
}

/// `handoff` 결과를 렌더한다.
///
/// "보냄"이라고 쓰지 않는다 — 이 시점에 일어난 일은 **큐잉**뿐이고 배달은 대상 세션이
/// 다음 턴 경계에 이르러야 일어난다. idle 세션은 그 턴이 영영 오지 않으므로 호출자가
/// 턴을 열어줘야 한다는 것까지가 이 출력의 책임이다.
pub fn render_handoff_created(r#ref: &str, created: &HandoffCreated) -> String {
    let target = created
        .handoff
        .session_name
        .as_deref()
        .unwrap_or(&created.handoff.session_id);
    let head = format!("✓ {ref} → {target} 큐에 넣음 (아직 배달 전 — 대상의 다음 턴에 주입된다)", ref = r#ref);
    let Some(poke) = &created.poke else {
        // 구버전 데몬이다. 없는 poke 를 지어내지 않고 무엇이 어긋났는지와 두 갈래를 그대로
        // 준다 — 여기서 조용히 예전 문구로 돌아가면 "보냈는데 안 온다" 를 다시 만든다.
        return [
            head,
            "  이 데몬은 poke 를 주지 않는다 (CLI 보다 낮은 버전) — 대상이 idle 이면 배달되지 않는다.".to_string(),
            "  `rocky-todo daemon stop` 후 최신 버전으로 다시 띄우거나, 그 세션에 직접 한 줄 입력해라.".to_string(),
        ]
        .join("\n");
    };
    [
        head,
        "  대상이 idle 이면 턴을 열어줘야 한다:".to_string(),
        format!(
            "    에이전트 → SendMessage {{ to: \"{}\", message: ... }}  (--json 에 poke.message)",
            poke.to
        ),
        "    사람   → 그 세션에 아무 입력이나 한 줄".to_string(),
    ]
    .join("\n")
}

/// 보드 메타 한 건을 사람이 읽는 여러 줄로 — `board show` 가 쓴다.
pub fn render_board(board: &Board) -> String {
    let mut lines = vec![format!("{}  {}", board.key, board.title)];
    if let Some(desc) = board.description.as_deref().filter(|d| !d.is_empty()) {
        lines.push(format!("  {desc}"));
    }
    if let Some(repo) = board.repo.as_deref().filter(|r| !r.is_empty()) {
        lines.push(format!("  repo  {repo}  (https://github.com/{repo})"));
    }
    if let Some(path) = board.path.as_deref().filter(|p| !p.is_empty()) {
        lines.push(format!("  path  {path}"));
    }
    if let Some(previous) = board.previous_keys.as_ref().filter(|k| !k.is_empty()) {
        // 옛 참조가 아직 살아 있다는 사실을 여기서만 알 수 있다 — 다른 표면은 새 key 만 낸다.
        lines.push(format!(
            "  옛 이름  {} (참조는 계속 풀린다)",
            previous.join(", ")
        ));
    }
    lines.join("\n")
}
