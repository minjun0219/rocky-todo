//! launchd 상주 등록 — `rocky-todo daemon install` 이 쓰는 macOS 전용 헬퍼.
//! TS 원본 `src/launchd.ts`.
//!
//! KeepAlive 로 데몬을 로그인 세션 동안 상시 유지한다. 미설치 상태여도 CLI 의
//! 온디맨드 자동 기동은 그대로 동작하므로 install 은 선택 사항이다.

use std::path::PathBuf;
use std::process::Command;

use rocky_todo_core::config::expand_tilde;

use crate::client::daemon_binary;

/// launchd job 라벨.
pub const LAUNCHD_LABEL: &str = "com.rocky.todo";

fn plist_path() -> PathBuf {
    expand_tilde(&format!("~/Library/LaunchAgents/{LAUNCHD_LABEL}.plist"))
}

/// plist 로그가 놓이는 기본 디렉터리 — TS 와 같이 **설정된 dir 이 아니라 기본 경로**를
/// 쓴다. plist 는 설치 시점에 구워지는 정적 파일이라 이후 설정 변경을 따라갈 수 없고,
/// 로그 위치가 설정 따라 흔들리는 것보다 한 자리에 고정되는 쪽이 찾기 쉽다.
fn default_todo_dir() -> PathBuf {
    expand_tilde("~/.config/rocky/todo")
}

/// launchd(KeepAlive) 상주 job 이 등록돼 있나 — plist 존재 여부로 판별한다 (macOS 전용).
///
/// 등록돼 있으면 데몬은 launchd 가 관리하므로, 구버전을 교체할 때 PID 만 죽여선 안 된다
/// (KeepAlive 가 같은 plist 경로의 구버전을 즉시 되살린다). `install_launchd` 로 job
/// 자체를 현재 설치 경로로 교체해야 한다.
pub fn is_launchd_registered() -> bool {
    cfg!(target_os = "macos") && plist_path().is_file()
}

/// launchd 가 잡에 물려주는 PATH 는 최소치(`/usr/bin:/bin:/usr/sbin:/sbin`)라 Homebrew 등
/// 사용자 설치 위치가 빠진다. 데몬이 이름만으로 spawn 하는 외부 CLI 가 둘 있다:
/// `gh`(이슈 생성 — 최소 PATH 아래서 "gh CLI 를 찾을 수 없다"는 잘못된 메시지가 뜬다)와
/// `claude`(못 찾으면 핸드오프 기능 전체가 `available:false` 로 죽는다). SessionStart
/// 훅이 띄운 데몬은 셸 PATH 를 상속해 잘 도는데 `daemon install` 로 상주시킨 데몬만
/// 안 되는 상태를 만드는 함정이다.
const PLIST_PATH_FALLBACK: &str = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

/// plist 에 구울 PATH — **설치 시점의 `PATH`** 를 우선한다. 지금 이 셸에서 `gh`/`claude`
/// 가 보이면 launchd 데몬도 보게 만드는 게 가장 정확하다. 뒤에 흔한 설치 위치를 이어
/// 붙여, PATH 가 비었거나 비표준 셸에서 설치한 경우도 받친다(중복 항목은 무해하다).
fn path_for_plist() -> String {
    match std::env::var("PATH") {
        Ok(inherited) if !inherited.is_empty() => format!("{inherited}:{PLIST_PATH_FALLBACK}"),
        _ => PLIST_PATH_FALLBACK.to_string(),
    }
}

/// plist 는 XML 이다 — 보간되는 값(PATH, 실행 파일 경로, 로그 경로)에 `&`/`<`/`>` 가
/// 섞이면(예: `/Users/x/Tools & Scripts/bin`) 파싱 불가한 plist 가 만들어진다.
/// `install_launchd` 는 이 plist 를 쓰기 전에 기존 job 을 먼저 내리므로, 깨진 plist 로
/// 로드가 실패하면 상주 데몬이 롤백 없이 사라진다 — 여기서 막아야 하는 이유다.
/// `"` 는 전부 텍스트 노드 안이라 이스케이프 대상에서 뺐다.
fn escape_xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// plist 보간값 — 기본은 실제 install 시점 값. 테스트에서 특수문자 이스케이프를
/// 검증할 수 있도록 override 가능한 seam 을 열어뒀다.
#[derive(Debug, Clone, Default)]
pub struct PlistValues {
    pub exec_path: Option<String>,
    pub log_path: Option<String>,
    pub path: Option<String>,
}

/// plist 본문 — install 시점에 캡처한 PATH 를 EnvironmentVariables 로 굽는다.
///
/// TS 판과 달리 ProgramArguments 가 `bun run daemon.ts` 가 아니라 `rocky-todod`
/// 바이너리 하나다. WorkingDirectory 고정도 없다 — 그건 bunfig.toml(Tailwind serve
/// 플러그인)이 시작 cwd 에서 읽히던 TS 시절의 제약이고, Rust 데몬은 미리 번들된
/// dist 를 서빙한다.
pub fn plist_content(overrides: &PlistValues) -> String {
    let exec_path = overrides
        .exec_path
        .clone()
        .unwrap_or_else(|| daemon_binary().to_string_lossy().to_string());
    let log_path = overrides.log_path.clone().unwrap_or_else(|| {
        default_todo_dir()
            .join("daemon.log")
            .to_string_lossy()
            .to_string()
    });
    let path = overrides.path.clone().unwrap_or_else(path_for_plist);
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{exec}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>{path}</string>
  </dict>
  <key>StandardOutPath</key><string>{log}</string>
  <key>StandardErrorPath</key><string>{log}</string>
</dict>
</plist>
"#,
        exec = escape_xml(&exec_path),
        path = escape_xml(&path),
        log = escape_xml(&log_path),
    )
}

fn launchctl(args: &[&str]) -> (bool, String) {
    let output = Command::new("launchctl").args(args).output();
    match output {
        Ok(out) => {
            let text = format!(
                "{}{}",
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr)
            );
            (out.status.success(), text.trim().to_string())
        }
        Err(error) => (false, error.to_string()),
    }
}

fn gui_domain() -> String {
    // SAFETY: getuid 는 인자 없는 순수 조회다 — 실패 경로가 없다.
    let uid = unsafe { libc::getuid() };
    format!("gui/{uid}")
}

/// `daemon install` — plist 를 굽고 launchd job 을 (재)등록한다. 멱등.
pub fn install_launchd() -> String {
    let plist = plist_path();
    if let Some(parent) = plist.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::create_dir_all(default_todo_dir());
    if let Err(error) = std::fs::write(&plist, plist_content(&PlistValues::default())) {
        return format!("launchd 등록 실패: plist 를 쓰지 못했다 — {error}");
    }
    // 재설치를 멱등하게 — 이미 떠 있으면 내리고 다시 올린다.
    let plist_str = plist.to_string_lossy().to_string();
    launchctl(&["bootout", &gui_domain(), &plist_str]);
    let (ok, out) = launchctl(&["bootstrap", &gui_domain(), &plist_str]);
    if !ok {
        return format!("launchd 등록 실패: {out}\nplist: {plist_str}");
    }
    format!(
        "✓ launchd 등록 완료 ({LAUNCHD_LABEL}) — 로그인 시 자동 기동 + KeepAlive\n  plist: {plist_str}"
    )
}

/// `daemon uninstall` — job 을 내리고 plist 를 지운다.
pub fn uninstall_launchd() -> String {
    let plist = plist_path();
    let plist_str = plist.to_string_lossy().to_string();
    let (ok, _) = launchctl(&["bootout", &gui_domain(), &plist_str]);
    if plist.exists() {
        let _ = std::fs::remove_file(&plist);
    }
    if ok {
        format!("✓ launchd 해제 완료 ({LAUNCHD_LABEL})")
    } else {
        "launchd 해제: 등록되어 있지 않았다 (plist 는 정리됨)".to_string()
    }
}

/// `daemon status` 한 줄 — 미등록 / plist 만 존재 / 로드됨(state 포함)을 가른다.
pub fn launchd_status() -> String {
    let plist = plist_path();
    if !plist.is_file() {
        return "launchd: 미등록 (온디맨드 자동 기동만 사용중)".to_string();
    }
    let target = format!("{}/{LAUNCHD_LABEL}", gui_domain());
    let (ok, out) = launchctl(&["print", &target]);
    if !ok {
        return format!(
            "launchd: plist 는 있으나 로드되지 않음 ({})",
            plist.display()
        );
    }
    let state = out
        .lines()
        .find_map(|line| line.trim().strip_prefix("state = "))
        .unwrap_or("unknown");
    format!("launchd: 등록됨, state={state}")
}
