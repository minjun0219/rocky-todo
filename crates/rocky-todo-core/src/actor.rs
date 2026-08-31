//! actor(누가) 와 board key(어느 프로젝트) 해석 — TS 원본 `src/actor.ts`.
//!
//! actor 우선순위: env `ROCKY_TODO_ACTOR` > 호스트 마커 자동 감지 > 'agent'.

/// 호스트 감지 마커 — 앞선 항목이 이긴다.
const HOST_MARKERS: [(&str, &str); 4] = [
    ("CLAUDECODE", "claude-code"),
    ("CLAUDE_CODE", "claude-code"),
    ("OPENCODE", "opencode"),
    ("CODEX", "codex"),
];

/// env 스냅샷에서 actor 를 감지한다.
pub fn detect_actor(env: &[(String, String)]) -> String {
    if let Some((_, value)) = env.iter().find(|(k, _)| k == "ROCKY_TODO_ACTOR") {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    for (prefix, actor) in HOST_MARKERS {
        if env
            .iter()
            .any(|(k, v)| k.starts_with(prefix) && !v.is_empty())
        {
            return actor.to_string();
        }
    }
    "agent".to_string()
}

pub struct BoardKeySources<'a> {
    /// `git remote get-url origin` 결과 (실패 시 None)
    pub remote_url: Option<&'a str>,
    /// `git rev-parse --show-toplevel` 결과 (실패 시 None)
    pub toplevel: Option<&'a str>,
    pub cwd: Option<&'a str>,
}

fn basename(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

fn sanitize_key(raw: &str) -> String {
    let no_git = raw.strip_suffix(".git").unwrap_or(raw);
    let mut out = String::with_capacity(no_git.len());
    let mut last_dash = false;
    for c in no_git.chars() {
        if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
            out.push(c);
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    out.trim_matches('-').to_string()
}

/// git remote basename > toplevel basename > cwd basename. 비면 'board'.
pub fn board_key_from(sources: &BoardKeySources) -> String {
    let candidates = [
        sources
            .remote_url
            .map(|u| basename(u.trim_end_matches('/'))),
        sources.toplevel.map(basename),
        sources.cwd.map(basename),
    ];
    for candidate in candidates.into_iter().flatten() {
        let key = sanitize_key(candidate);
        if !key.is_empty() {
            return key;
        }
    }
    "board".to_string()
}
