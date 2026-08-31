//! tailscale serve 연동 (옵션) — TS 원본 `src/tailscale.ts`.
//!
//! 기본 off — expose 에 채널이 없으면 tailscale 을 일절 안 건드린다(회사 환경 대비).
//! **자동 경로는 남의 노출을 빼앗지 않는다**(`decide_serve_action`) — serve 의 노출
//! 지점은 443 의 `/` 하나뿐인 머신 공유 자원이다. 수동 경로는 사용자가 명시적으로
//! 요구한 것이므로 그대로 인수한다.

use std::time::Duration;

use crate::runner::Runner;

async fn tailscale_cmd(runner: &Runner, args: &[&str], timeout: Duration) -> (bool, String) {
    let mut cmd = vec!["tailscale".to_string()];
    cmd.extend(args.iter().map(|s| s.to_string()));
    let result = runner(cmd, String::new(), timeout).await;
    if result.code != 0 && result.stdout.is_empty() && result.stderr.contains("No such file") {
        return (
            false,
            "tailscale CLI 를 찾을 수 없다 (미설치 환경에서는 이 기능을 쓰지 않는다)".into(),
        );
    }
    (
        result.ok(),
        format!("{}{}", result.stdout, result.stderr)
            .trim()
            .to_string(),
    )
}

pub async fn tailscale_serve_on(runner: &Runner, port: u16) -> String {
    let (ok, out) = tailscale_cmd(
        runner,
        &["serve", "--bg", &port.to_string()],
        Duration::from_secs(10),
    )
    .await;
    if ok {
        return format!("✓ tailscale serve 활성 — 테일넷 기기에서 접근 가능:\n{out}");
    }
    if out.contains("not enabled on your tailnet") {
        return format!(
            "tailscale serve 가 테일넷에서 비활성 상태다. 관리 콘솔에서 1회 승인이 필요하다:\n{out}\n(승인 후 다시: rocky-todo tailscale on)"
        );
    }
    format!("tailscale serve 실패: {out}")
}

pub async fn tailscale_serve_off(runner: &Runner) -> String {
    let (ok, out) = tailscale_cmd(
        runner,
        &["serve", "--https=443", "off"],
        Duration::from_secs(10),
    )
    .await;
    if ok {
        "✓ tailscale serve 해제".to_string()
    } else {
        format!("tailscale serve 해제 실패: {out}")
    }
}

pub async fn tailscale_serve_status(runner: &Runner) -> String {
    let (ok, out) = tailscale_cmd(runner, &["serve", "status"], Duration::from_secs(10)).await;
    if !ok {
        return format!("tailscale: {out}");
    }
    if out.is_empty() || out.contains("No serve config") {
        "tailscale serve: 미설정 (로컬 전용)".to_string()
    } else {
        out
    }
}

fn is_loopback_host(hostname: &str) -> bool {
    let host = hostname
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_lowercase();
    host == "127.0.0.1" || host == "localhost" || host == "::1"
}

/// `serve status --json` 에서 루트(`/`) 핸들러가 프록시하는 **루프백** 포트를 뽑는다.
/// 텍스트 트리는 버전마다 흔들려 JSON 을 파싱한다. 실패·비루프백은 None.
pub fn parse_serve_proxy_port(json: &str) -> Option<u16> {
    let parsed: serde_json::Value = serde_json::from_str(json).ok()?;
    let web = parsed.get("Web")?.as_object()?;
    for site in web.values() {
        let Some(proxy) = site
            .get("Handlers")
            .and_then(|h| h.get("/"))
            .and_then(|r| r.get("Proxy"))
            .and_then(|p| p.as_str())
        else {
            continue;
        };
        // `http://127.0.0.1:8636` 꼴 — 손 파싱.
        let Some(rest) = proxy.split("://").nth(1) else {
            continue;
        };
        let authority = rest.split('/').next().unwrap_or("");
        let (host, port) = if let Some(end) = authority.find(']') {
            (&authority[..=end], authority.get(end + 2..))
        } else {
            match authority.rsplit_once(':') {
                Some((h, p)) => (h, Some(p)),
                None => (authority, None),
            }
        };
        if !is_loopback_host(host) {
            continue;
        }
        if let Some(port) = port.and_then(|p| p.parse::<u16>().ok()) {
            if port > 0 {
                return Some(port);
            }
        }
    }
    None
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServeAction {
    Claim,
    Keep,
    Yield,
    Reclaim,
}

pub struct ServeDecision {
    pub action: ServeAction,
    pub message: String,
}

/// 기동 시 serve 를 잡을지 판정 (순수) — claim/keep/yield/reclaim.
/// `reclaim` 이 있어야 한 번 빼앗긴 노출이 정상 재기동으로 복구된다.
pub fn decide_serve_action(
    my_port: u16,
    occupied_port: Option<u16>,
    occupant_is_live_daemon: bool,
) -> ServeDecision {
    match occupied_port {
        None => ServeDecision {
            action: ServeAction::Claim,
            message: "tailscale serve 활성화 (todo.expose: tailscale-serve)".into(),
        },
        Some(occupied) if occupied == my_port => ServeDecision {
            action: ServeAction::Keep,
            message: format!("tailscale serve 이미 :{my_port} 로 설정됨"),
        },
        Some(occupied) if occupant_is_live_daemon => ServeDecision {
            action: ServeAction::Yield,
            message: format!(
                "tailscale serve 는 :{occupied} 의 다른 rocky-todo 데몬이 쓰는 중 — 건드리지 않는다.\n      이 인스턴스(:{my_port})는 테일넷에 노출되지 않는다. 넘기려면: rocky-todo tailscale on"
            ),
        },
        Some(occupied) => ServeDecision {
            action: ServeAction::Reclaim,
            message: format!("tailscale serve 가 죽은 :{occupied} 를 가리키고 있어 :{my_port} 로 되돌린다"),
        },
    }
}

/// 데몬 기동 시 자동 보장 — 판정은 `decide_serve_action`, 여기는 실행만. 실패는
/// 메시지로만(fail-open: tailscale 문제로 데몬이 죽으면 안 된다).
pub async fn ensure_tailscale_serve(
    runner: &Runner,
    port: u16,
    probe_daemon: impl Fn(u16) -> crate::runner::BoxFut<bool>,
) -> String {
    let (status_ok, status_out) = tailscale_cmd(
        runner,
        &["serve", "status", "--json"],
        Duration::from_secs(5),
    )
    .await;
    // status 조회 실패면 점유자를 알 수 없다 — 빈 자리로 보고 claim 시도.
    let occupied_port = if status_ok {
        parse_serve_proxy_port(&status_out)
    } else {
        None
    };
    let occupant_is_live = match occupied_port {
        Some(occupied) if occupied != port => probe_daemon(occupied).await,
        _ => false,
    };
    let decision = decide_serve_action(port, occupied_port, occupant_is_live);
    if matches!(decision.action, ServeAction::Keep | ServeAction::Yield) {
        return decision.message;
    }
    let (ok, out) = tailscale_cmd(
        runner,
        &["serve", "--bg", &port.to_string()],
        Duration::from_secs(10),
    )
    .await;
    if ok {
        format!("{}\n{out}", decision.message)
    } else {
        format!(
            "tailscale serve 자동 활성화 실패 (무시하고 계속): {}",
            out.lines().next().unwrap_or("")
        )
    }
}
