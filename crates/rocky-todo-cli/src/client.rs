//! TS `src/client.ts` 포팅 — 데몬의 얇은 REST 클라이언트.
//!
//! 데몬이 죽어 있으면 `ensure_daemon` 이 detached spawn 후 health 가 응답할 때까지
//! (최대 ~5s) 기다린다. 모든 요청에 `x-rocky-actor` 헤더를 붙여 히스토리에 남긴다.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::de::DeserializeOwned;
use serde::Deserialize;

/// health 폴링 간격 — TS 와 같다.
const POLL_INTERVAL: Duration = Duration::from_millis(200);
/// 기동 대기 = 25 × 200ms ≈ 5s.
const START_ATTEMPTS: u32 = 25;
/// 종료 대기 = 15 × 200ms ≈ 3s.
const STOP_ATTEMPTS: u32 = 15;
/// health 는 짧게 끊는다 — 안 뜬 데몬을 기다리는 게 목적이 아니다.
const HEALTH_TIMEOUT: Duration = Duration::from_millis(700);
/// 일반 요청 타임아웃 — spawn 처럼 오래 도는 라우트가 있어 넉넉히 둔다.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// CLI 실행 컨텍스트.
#[derive(Debug, Clone)]
pub struct CliContext {
    pub base_url: String,
    pub port: u16,
    pub dir: PathBuf,
    pub actor: String,
}

/// port/dir/actor 로 컨텍스트를 조립한다 (baseUrl 은 127.0.0.1 루프백).
pub fn build_context(port: u16, dir: impl Into<PathBuf>, actor: impl Into<String>) -> CliContext {
    CliContext {
        base_url: format!("http://127.0.0.1:{port}"),
        port,
        dir: dir.into(),
        actor: actor.into(),
    }
}

/// `/api/health` 응답 — version/pid 는 0.2.0 이전 데몬에는 없다.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonHealth {
    pub ok: bool,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub pid: Option<u32>,
    /// 이 요청과 같은 출처에서 GitHub 이슈를 만들 수 있는지 — 웹 UI 가 누를 수 없는
    /// 버튼을 그리지 않기 위한 힌트다(강제는 이슈 라우트가 403 으로 한다).
    #[serde(default)]
    pub issue_create_allowed: Option<bool>,
}

fn agent(timeout: Duration) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(timeout))
        .build()
        .into()
}

/// 데몬 health 를 본문째 돌려준다 — 호출자가 실행 중인 코드의 버전/pid 를 볼 수 있다.
///
/// **신원 검증**: 설정된 포트에 rocky-todo 가 아닌 서비스가 떠 2xx JSON 을 돌려줄 수
/// 있으므로 `ok == true` 와 `name == "rocky-todo"` 를 확인한 응답만 데몬으로 인정한다.
/// (version/pid 는 ≤0.1.0 데몬엔 없어 stale 판별의 근거라 검증 대상이 아니다.) 이 가드가
/// 없으면 호출자가 무관한 프로세스의 pid 에 SIGTERM 을 보낼 수 있다.
///
/// 응답이 없거나 비정상이거나 rocky-todo 데몬이 아니면 `None`.
pub fn daemon_health(base_url: &str) -> Option<DaemonHealth> {
    let mut response = agent(HEALTH_TIMEOUT)
        .get(format!("{base_url}/api/health"))
        .call()
        .ok()?;
    let body: DaemonHealth = response.body_mut().read_json().ok()?;
    if !body.ok || body.name.as_deref() != Some("rocky-todo") {
        return None;
    }
    Some(body)
}

/// 데몬이 살아 있는지.
pub fn health(base_url: &str) -> bool {
    daemon_health(base_url).is_some()
}

/// `daemon.pid` 파일을 읽는다 — health 가 pid 를 안 주는 구버전 데몬 폴백.
fn read_pid_file(dir: &Path) -> Option<u32> {
    let raw = std::fs::read_to_string(dir.join("daemon.pid")).ok()?;
    let pid: u32 = raw.trim().parse().ok()?;
    if pid > 0 {
        Some(pid)
    } else {
        None
    }
}

/// 실행 중인 데몬에 SIGTERM 을 보내고 포트가 풀릴 때까지 (최대 ~3s) 기다린다.
///
/// `pid` 는 health 가 보고한 값. 없으면 `daemon.pid` 파일로 폴백한다.
/// 종료가 확인되면 `true`. pid 를 못 찾거나 시간 안에 안 죽으면 `false`.
pub fn stop_daemon(ctx: &CliContext, pid: Option<u32>) -> bool {
    let Some(target) = pid.or_else(|| read_pid_file(&ctx.dir)) else {
        return false;
    };
    // SAFETY: `kill(2)` 는 pid 와 시그널 번호만 받는 순수 시스템 호출이라 포인터를
    // 다루지 않는다. 대상이 이미 죽었으면 ESRCH 로 실패할 뿐 다른 프로세스를 건드리지
    // 않는다 — 애초에 pid 는 신원 검증을 통과한 health 응답에서 온 값이다.
    let sent = unsafe { libc::kill(target as libc::pid_t, libc::SIGTERM) } == 0;
    if !sent {
        // ESRCH(이미 죽음)와 EPERM(남의 프로세스)을 errno 로 나누지 않고 포트로 판정한다 —
        // 이미 죽었다면 목적은 달성된 것이고(health 확인 직후 죽는 레이스), 남의 프로세스면
        // health 가 계속 응답하므로 자연히 false 가 된다.
        return daemon_health(&ctx.base_url).is_none();
    }
    for _ in 0..STOP_ATTEMPTS {
        std::thread::sleep(POLL_INTERVAL);
        if daemon_health(&ctx.base_url).is_none() {
            return true;
        }
    }
    false
}

/// 같이 설치된 `rocky-todod` 실행 파일 경로.
///
/// CLI 옆(`current_exe` 의 형제)을 먼저 본다 — cargo 산출물이든 설치본이든 두 바이너리는
/// 같은 디렉터리에 놓이므로, PATH 에 있는 **다른 버전**을 집는 사고를 막는다. 형제가
/// 없을 때만 PATH 에 맡긴다.
pub fn daemon_binary() -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(sibling) = exe.parent().map(|dir| dir.join("rocky-todod")) {
            if sibling.is_file() {
                return sibling;
            }
        }
    }
    PathBuf::from("rocky-todod")
}

/// 데몬이 안 떠 있으면 detached spawn 하고 health 가 응답할 때까지 (최대 ~5s) 기다린다.
///
/// # Errors
/// 시간 안에 뜨지 않으면 에러 문자열.
pub fn ensure_daemon(ctx: &CliContext) -> Result<(), String> {
    if health(&ctx.base_url) {
        return Ok(());
    }
    // stdio 를 전부 끊어 detach 한다 — 부모(CLI)가 끝나도 데몬은 산다. TS 시절 cwd 를
    // 레포 루트로 고정했던 것은 bunfig.toml(Tailwind 플러그인)이 시작 cwd 에서 읽히기
    // 때문인데, Rust 데몬은 UI 를 미리 번들된 dist 로 서빙하므로 그 제약이 없다.
    std::process::Command::new(daemon_binary())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|error| format!("rocky-todod 를 띄우지 못했다: {error}"))?;

    for _ in 0..START_ATTEMPTS {
        std::thread::sleep(POLL_INTERVAL);
        if health(&ctx.base_url) {
            return Ok(());
        }
    }
    Err(format!(
        "rocky-todo daemon did not start on port {} — check `rocky-todo daemon status`",
        ctx.port
    ))
}

/// 응답 본문에서 에러 메시지를 꺼낸다 — 데몬은 `{ "error": "..." }` 로 답한다.
fn error_message(body: &serde_json::Value, status: u16) -> String {
    body.get("error")
        .and_then(|e| e.as_str())
        .map(str::to_string)
        .unwrap_or_else(|| format!("HTTP {status}"))
}

/// 데몬에 요청을 보내고 JSON 본문을 역직렬화한다. 필요하면 데몬을 먼저 띄운다.
///
/// # Errors
/// 기동 실패, 전송 실패, 비 2xx 응답(본문의 `error` 를 그대로 올린다), 역직렬화 실패.
pub fn request<T: DeserializeOwned>(
    ctx: &CliContext,
    method: &str,
    path: &str,
    body: Option<&serde_json::Value>,
) -> Result<T, String> {
    let raw = request_value(ctx, method, path, body)?;
    serde_json::from_value(raw).map_err(|error| format!("응답을 읽지 못했다: {error}"))
}

/// `request` 의 원본 JSON 판 — `--json` 출력과 형태를 모르는 응답에 쓴다.
///
/// # Errors
/// `request` 와 같다.
pub fn request_value(
    ctx: &CliContext,
    method: &str,
    path: &str,
    body: Option<&serde_json::Value>,
) -> Result<serde_json::Value, String> {
    ensure_daemon(ctx)?;
    let url = format!("{}{path}", ctx.base_url);
    // `http_status_as_error(false)` 가 핵심이다 — 켜 두면 4xx/5xx 가 상태 코드만 담은
    // 에러로 올라와 본문을 못 읽는다. 데몬은 실패 이유를 `{ "error": ... }` 로 주고
    // 그게 사용자에게 보여줄 메시지라, 상태와 무관하게 본문을 끝까지 읽어야 한다.
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(REQUEST_TIMEOUT))
        .http_status_as_error(false)
        .build()
        .into();

    // ureq 3 의 빌더는 본문 유무가 타입으로 갈려(`WithBody` / `WithoutBody`) 메서드
    // 문자열 하나로 합칠 수 없다. 데몬이 쓰는 다섯 가지만 받는다.
    let upper = method.to_ascii_uppercase();
    let sent = match upper.as_str() {
        "GET" => agent.get(&url).header("x-rocky-actor", &ctx.actor).call(),
        "DELETE" => agent
            .delete(&url)
            .header("x-rocky-actor", &ctx.actor)
            .call(),
        "POST" | "PATCH" | "PUT" => {
            let builder = match upper.as_str() {
                "POST" => agent.post(&url),
                "PATCH" => agent.patch(&url),
                _ => agent.put(&url),
            }
            .header("x-rocky-actor", &ctx.actor);
            match body {
                Some(payload) => builder
                    .header("content-type", "application/json")
                    .send_json(payload),
                // 본문 없는 POST 도 있다(상태 전이 등) — 빈 본문으로 보낸다.
                None => builder.send_empty(),
            }
        }
        other => return Err(format!("지원하지 않는 메서드: {other}")),
    };

    let mut response = sent.map_err(|error| format!("데몬에 닿지 못했다: {error}"))?;
    let status = response.status().as_u16();
    let value: serde_json::Value = response
        .body_mut()
        .read_json()
        .map_err(|error| format!("응답을 읽지 못했다: {error}"))?;
    if !(200..300).contains(&status) {
        return Err(error_message(&value, status));
    }
    Ok(value)
}
