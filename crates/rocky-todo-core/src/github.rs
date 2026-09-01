//! GitHub 레포 식별자 처리 (순수) — TS 원본 `src/github.ts` 의 문자열 부분.
//!
//! `gh` CLI 를 부르는 쪽은 데몬(`rocky-todod::github`)에 있고, 여기에는 입력 검증과
//! remote URL 파싱만 둔다 — CLI 의 `board repo` / `issue` 가 같은 판정을 쓴다.

fn is_slug_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-'
}

fn is_repo_slug_exact(value: &str) -> bool {
    let mut parts = value.split('/');
    match (parts.next(), parts.next(), parts.next()) {
        (Some(owner), Some(name), None) => {
            !owner.is_empty()
                && !name.is_empty()
                && owner.chars().all(is_slug_char)
                && name.chars().all(is_slug_char)
        }
        _ => false,
    }
}

/// 사용자 입력(웹 UI·CLI 플래그)이 `owner/name` 모양인지.
pub fn is_repo_slug(value: &str) -> bool {
    is_repo_slug_exact(value.trim())
}

/// git remote URL → `owner/name`. GitHub 이 아니거나 해석 불가면 None.
/// 호스트는 실제 파싱된 호스트가 정확히 `github.com` 인지로 판별한다(lookalike 방지).
pub fn parse_repo_from_remote(url: &str) -> Option<String> {
    let trimmed = url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return None;
    }

    let lower = trimmed.to_lowercase();
    let has_scheme = ["https://", "http://", "ssh://", "git://"]
        .iter()
        .any(|scheme| lower.starts_with(scheme));
    if has_scheme {
        let rest = trimmed.split("://").nth(1)?;
        let (authority, path) = rest.split_once('/')?;
        let host = authority.rsplit('@').next()?.split(':').next()?;
        if !host.eq_ignore_ascii_case("github.com") {
            return None;
        }
        let slug = path.trim_start_matches('/').trim_end_matches(".git");
        return is_repo_slug_exact(slug).then(|| slug.to_string());
    }

    // scp-like: `(user@)?github.com:o/n(.git)` — user@ 접두사는 최대 하나, 호스트 정확 일치.
    let (head, tail) = trimmed.split_once(':')?;
    let host = head.rsplit('@').next()?;
    if head.matches('@').count() > 1 || host.contains('/') {
        return None;
    }
    if !host.eq_ignore_ascii_case("github.com") {
        return None;
    }
    let slug = tail.trim_end_matches(".git");
    is_repo_slug_exact(slug).then(|| slug.to_string())
}
