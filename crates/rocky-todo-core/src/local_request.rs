//! 요청 출처 판별 — 순수 함수. TS 원본 `src/local-request.ts`.
//!
//! HTTP 프레임워크에 묶이지 않게 헤더 조회를 클로저로 받는다 — axum 통합은 Phase 2 의
//! rocky-todod 가 이 함수에 자기 헤더맵을 접어 넣는다.

/// 프록시가 붙이는 헤더 — 하나라도 있으면 중계된 요청으로 본다.
pub const FORWARDED_HEADERS: [&str; 8] = [
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
    "x-real-ip",
    "forwarded",
    "tailscale-user-login",
    "tailscale-user-name",
    "tailscale-user-profile-pic",
];

/// 루프백 주소인지 — IPv4 `127.0.0.0/8`, IPv6 `::1`, IPv4-mapped `::ffff:127.x.y.z`.
/// 대괄호와 zone id(`%lo0`)는 벗겨서 본다. 주소를 모르면 루프백이 **아니다**(fail-closed).
pub fn is_loopback_address(address: Option<&str>) -> bool {
    let Some(address) = address else {
        return false;
    };
    let bare = address
        .trim()
        .to_lowercase()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .split('%')
        .next()
        .unwrap_or("")
        .to_string();
    if bare == "::1" || bare == "0:0:0:0:0:0:0:1" {
        return true;
    }
    // IPv4-mapped(`::ffff:127.0.0.1`)는 실제로 IPv4 루프백이다.
    let v4 = bare.strip_prefix("::ffff:").unwrap_or(&bare);
    let mut parts = v4.split('.');
    let first = parts.next();
    let rest: Vec<&str> = parts.collect();
    first == Some("127")
        && rest.len() == 3
        && rest
            .iter()
            .all(|p| !p.is_empty() && p.len() <= 3 && p.bytes().all(|b| b.is_ascii_digit()))
}

/// peer 주소가 루프백이고 **중계 흔적이 없어야** 로컬로 본다. 헤더는 위조로 "있게" 만들
/// 수는 있어도 "없게" 만들 수는 없어, 위조는 덜 신뢰하는 방향으로만 작용한다.
pub fn is_local_request(peer_address: Option<&str>, has_header: impl Fn(&str) -> bool) -> bool {
    if !is_loopback_address(peer_address) {
        return false;
    }
    !FORWARDED_HEADERS.iter().any(|name| has_header(name))
}

/// URL 문자열에서 hostname 만 뽑는다 — `http://host:port/path` 꼴. IPv6 는 대괄호째 준다
/// (TS `URL.hostname` 과 동일). 파싱 불가면 None.
fn hostname_of(url: &str) -> Option<String> {
    let rest = url.split("://").nth(1)?;
    let authority = rest.split(['/', '?', '#']).next()?;
    // userinfo 제거
    let host_port = authority.rsplit('@').next()?;
    if host_port.is_empty() {
        return None;
    }
    if let Some(bracket_end) = host_port.find(']') {
        // IPv6 — 대괄호 포함 그대로 (TS URL.hostname 계약).
        return Some(host_port[..=bracket_end].to_lowercase());
    }
    Some(host_port.split(':').next()?.to_lowercase())
}

/// 다른 사이트의 페이지가 시킨 요청인가 — 브라우저發 CSRF 판별.
///
/// 1순위 `Sec-Fetch-Site` == `cross-site` 만 거부. 없으면 `Origin` 폴백 — **헤더가 아예
/// 없을 때만** 통과(비브라우저 클라이언트), 불투명 Origin(`null`)·파싱 불가는 거부.
/// 호스트 비교는 포트 무시, `x-forwarded-host` 가 보존한 원래 호스트도 허용 대상.
pub fn is_cross_site_request(get_header: impl Fn(&str) -> Option<String>, req_url: &str) -> bool {
    if let Some(site) = get_header("sec-fetch-site") {
        return site.trim().to_lowercase() == "cross-site";
    }
    let Some(origin) = get_header("origin") else {
        return false;
    };
    let Some(origin_hostname) = hostname_of(&origin) else {
        // 불투명 Origin(`null`) 포함 — 정상 브라우저가 이 데몬을 향해 만들 값이 아니다.
        return true;
    };
    let mut allowed: Vec<String> = Vec::new();
    if let Some(own) = hostname_of(req_url) {
        allowed.push(own);
    }
    if let Some(forwarded) = get_header("x-forwarded-host") {
        if let Some(first) = forwarded.split(',').next() {
            let trimmed = first.trim();
            if !trimmed.is_empty() {
                // `host[:port]` — 포트만 뗀다. IPv6 대괄호는 유지.
                let without_port = strip_trailing_port(trimmed);
                allowed.push(without_port.to_lowercase());
            }
        }
    }
    !allowed.contains(&origin_hostname)
}

/// `host:1234` 의 끝 포트만 뗀다 — `[::1]:80` 도 지원. TS 의 `/:\d+$/` 대응.
fn strip_trailing_port(host: &str) -> String {
    if let Some(colon) = host.rfind(':') {
        let after = &host[colon + 1..];
        if !after.is_empty() && after.bytes().all(|b| b.is_ascii_digit()) {
            return host[..colon].to_string();
        }
    }
    host.to_string()
}

/// cross-site 쓰기 거부 문구.
pub const CROSS_SITE_MESSAGE: &str =
    "다른 사이트에서 시작된 변경 요청은 처리하지 않는다 (CSRF 방지) — 보드 화면이나 CLI 에서 다시 시도한다";

/// 거부 문구 — REST(403)와 MCP(도구 에러)가 같은 말을 하도록 한 곳에 둔다.
pub const NON_LOCAL_ISSUE_MESSAGE: &str =
    "GitHub 이슈 생성은 로컬(루프백) 요청만 할 수 있다 — 데몬 사용자의 gh 인증을 쓰기 때문에 노출된 표면으로는 허용하지 않는다";

pub const NON_LOCAL_BOARD_META_MESSAGE: &str =
    "보드의 path·repo 변경은 로컬(루프백) 요청만 할 수 있다 — spawn 워크트리와 이슈 대상이 걸린 값이라 노출된 표면으로는 허용하지 않는다";

pub const NON_LOCAL_SPAWN_MESSAGE: &str =
    "백그라운드 세션 띄우기는 로컬(루프백) 요청만 할 수 있다 — 이 기계에서 파일을 고치는 프로세스를 띄우기 때문에 노출된 표면으로는 허용하지 않는다";
