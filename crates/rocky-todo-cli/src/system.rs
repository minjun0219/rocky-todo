//! 시스템 연동 — tailscale serve 수동 제어, 접속 주소 나열, MCP 등록 안내.
//! TS 원본 `src/tailscale.ts` 의 CLI 부분 + `src/cli.ts` 의 `printAddresses`/`mcpSetupGuide`.

use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// 자식을 마감 안에서 돌리고 넘기면 kill 한다 — `Command::output()` 에는 타임아웃이
/// 없어서, tailscale 이 멈추거나 입력을 기다리면 CLI/훅이 무기한 매달린다.
///
/// stdin 은 `/dev/null` 이다 — 프롬프트를 띄우는 명령이 즉시 EOF 를 받게 한다.
/// try_wait 폴링 동안 파이프를 읽지 않으므로 출력이 파이프 버퍼(64KB)를 넘치면
/// 자식이 write 에서 막히는데, 여기서 부르는 명령들(tailscale)의 출력은 그보다 훨씬
/// 작다. kill 뒤 `wait_with_output` 이 회수까지 겸한다.
fn run_with_deadline(
    program: &str,
    args: &[&str],
    timeout: Duration,
) -> Option<std::process::Output> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                break;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(_) => break,
        }
    }
    child.wait_with_output().ok()
}

/// `tailscale` CLI 한 번 실행 — stdout+stderr 를 합쳐 trim 한다. 마감을 넘기면
/// kill 되어 실패로 떨어진다(TS 의 `Bun.spawnSync({ timeout })` 대응).
///
/// 미설치면 에러 메시지로 떨어진다. 기본 off 정책이라, tailscale 을 쓰면 안 되는
/// 환경에서는 이 함수 자체가 불리지 않는다.
fn tailscale_cmd(args: &[&str], timeout: Duration) -> (bool, String) {
    match run_with_deadline("tailscale", args, timeout) {
        Some(out) => (
            out.status.success(),
            format!(
                "{}{}",
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr)
            )
            .trim()
            .to_string(),
        ),
        None => (
            false,
            "tailscale CLI 를 찾을 수 없다 (미설치 환경에서는 이 기능을 쓰지 않는다)".to_string(),
        ),
    }
}

/// `tailscale on` — serve 를 이 포트로 잡는다. **수동 경로는 남의 노출을 빼앗는다** —
/// 사용자가 명시적으로 요구한 것이므로 자동 경로(`decide_serve_action`)와 달리 가드하지
/// 않는다.
pub fn tailscale_serve_on(port: u16) -> String {
    let (ok, out) = tailscale_cmd(
        &["serve", "--bg", &port.to_string()],
        Duration::from_secs(10),
    );
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

/// `tailscale off`.
pub fn tailscale_serve_off() -> String {
    let (ok, out) = tailscale_cmd(&["serve", "--https=443", "off"], Duration::from_secs(10));
    if ok {
        "✓ tailscale serve 해제".to_string()
    } else {
        format!("tailscale serve 해제 실패: {out}")
    }
}

/// `tailscale status` — serve 설정 원문 또는 "미설정".
pub fn tailscale_serve_status() -> String {
    let (ok, out) = tailscale_cmd(&["serve", "status"], Duration::from_secs(10));
    if !ok {
        return format!("tailscale: {out}");
    }
    if out.is_empty() || out.contains("No serve config") {
        "tailscale serve: 미설정 (로컬 전용)".to_string()
    } else {
        out
    }
}

/// 이 머신의 테일넷 DNS 이름 (`xxx.ts.net`) — 없으면 None.
fn tailnet_dns_name() -> Option<String> {
    let (ok, out) = tailscale_cmd(&["status", "--json"], Duration::from_secs(3));
    if !ok {
        return None;
    }
    let json: serde_json::Value = serde_json::from_str(&out).ok()?;
    let dns = json.get("Self")?.get("DNSName")?.as_str()?;
    let trimmed = dns.trim_end_matches('.');
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// 내부망(non-loopback IPv4) 주소 목록.
///
/// TS 는 `os.networkInterfaces()` 를 썼다. Rust 표준 라이브러리에는 대응물이 없어
/// `ifconfig` 출력의 `inet A.B.C.D` 줄을 줍는다 — 대상 플랫폼(macOS)에는 늘 있고,
/// 파싱이 실패해도 주소 안내 한 줄이 빠질 뿐이라 의존성을 더할 이유가 없다.
fn lan_ipv4_addresses() -> Vec<String> {
    let Ok(out) = Command::new("ifconfig").output() else {
        return Vec::new();
    };
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    let mut found = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        let Some(rest) = trimmed.strip_prefix("inet ") else {
            continue;
        };
        let Some(addr) = rest.split_whitespace().next() else {
            continue;
        };
        if addr.starts_with("127.") || !addr.chars().all(|c| c.is_ascii_digit() || c == '.') {
            continue;
        }
        found.push(addr.to_string());
    }
    found
}

/// 활성 노출 채널 기준으로 접속 가능한 주소를 전부 출력한다 — `open` / `daemon status` 공용.
pub fn print_addresses(base_url: &str, port: u16, expose_lan: bool, expose_tailscale: bool) {
    println!("{base_url}");
    if expose_lan {
        for addr in lan_ipv4_addresses() {
            println!("http://{addr}:{port}  (내부망 — 같은 네트워크 기기용)");
        }
    }
    if expose_tailscale {
        if let Some(dns) = tailnet_dns_name() {
            println!("https://{dns}  (테일넷 기기용)");
        }
    }
}

/// `mcp setup` 안내문.
pub fn mcp_setup_guide(base_url: &str) -> String {
    format!(
        r#"rocky-todo 데몬의 MCP 엔드포인트: {base_url}/mcp (streamable HTTP)

Claude Code:
  rocky 플러그인이 http 로 자동 등록한다 (plugin.json 의 mcpServers.rocky-todo → {base_url}/mcp).
  데몬이 안 떠 있으면 도구가 안 붙는다 — rocky-todo daemon start 로 켠 뒤 /mcp 패널에서 retry.
  과거 수동 http 등록이 있으면 제거: claude mcp remove rocky-todo

opencode (~/.config/opencode/opencode.json):
  {{ "mcp": {{ "rocky-todo": {{ "type": "remote", "url": "{base_url}/mcp" }} }} }}

Codex (~/.codex/config.toml — streamable HTTP 지원 버전):
  [mcp_servers.rocky-todo]
  url = "{base_url}/mcp""#
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 마감을 넘긴 자식이 실제로 죽는지 — 수정 전(`Command::output()` 직행)에는 이
    /// 테스트가 60초를 통째로 기다렸다.
    #[test]
    fn run_with_deadline_kills_an_overrunning_child() {
        let started = Instant::now();
        let out = run_with_deadline("sleep", &["60"], Duration::from_millis(200))
            .expect("spawn 은 성공해야 한다");
        assert!(!out.status.success(), "kill 된 자식은 실패로 떨어진다");
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "마감이 안 듣는다: {:?}",
            started.elapsed()
        );
    }

    /// 마감 안에 끝나는 자식은 출력째 돌아온다.
    #[test]
    fn run_with_deadline_returns_output_within_the_deadline() {
        let out = run_with_deadline("echo", &["hello"], Duration::from_secs(5)).unwrap();
        assert!(out.status.success());
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "hello");
    }
}
