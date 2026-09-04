//! `app` — 데스크톱 앱(`rocky-todo.app`) 설치와 실행.
//!
//! 릴리스 첨부물은 ad-hoc 서명이라 **브라우저로 받으면** Gatekeeper 가 막는다(격리 속성
//! `com.apple.quarantine` 이 붙는다). 격리는 다운로드한 프로그램이 붙이는 것이지 파일의
//! 성질이 아니므로, 여기서 직접 받아 `ditto` 로 풀면 속성 없이 설치되고 그냥 열린다 —
//! Developer ID 서명·공증 없이 앱을 배포하는 유일한 길이다(플러그인 부트스트랩이 curl
//! 로 받는 tarball 이 문제없던 것과 같은 이유).
//!
//! 버전은 이 CLI 의 것(`CARGO_PKG_VERSION`)을 따른다 — plugin.json / Cargo.toml 이 한
//! 버전으로 동기화되므로 "플러그인이 쓰는 버전의 앱" 이 된다. 설치 위치는 `~/Applications`
//! (사용자 전용, sudo 불필요). 이미 같은 버전이 있으면 내려받지 않는다.

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

const REPO: &str = "minjun0219/rocky-todo";
/// 릴리스 산출물이 약속하는 유일한 타깃 — release.yml 의 Package 스텝이 이걸 단언한다.
const TARGET: &str = "aarch64-apple-darwin";
const BUNDLE_NAME: &str = "rocky-todo.app";
/// zip 은 지금 7MB 대다 — 넉넉히 잡되 무한정 읽지는 않는다.
const MAX_ZIP_BYTES: u64 = 256 * 1024 * 1024;
const MAX_SUMS_BYTES: u64 = 64 * 1024;

/// 설치 한 건의 재료 — 테스트가 URL/디렉터리를 갈아끼울 수 있게 값으로 뽑았다.
pub struct AppInstall {
    /// 받을 버전 (`v` 없이). 기본은 이 CLI 의 버전.
    pub version: String,
    /// `<base>/v<version>/<asset>` 의 base. 기본 GitHub Release.
    pub release_base: String,
    /// 번들을 둘 디렉터리. 기본 `~/Applications`.
    pub apps_dir: PathBuf,
}

impl AppInstall {
    /// 실제 환경의 기본값 — `ROCKY_TODO_RELEASE_BASE` 는 부트스트랩과 같은 미러 오버라이드.
    pub fn from_env() -> Result<Self, String> {
        let home = std::env::var("HOME").map_err(|_| "HOME 이 없다".to_string())?;
        Ok(Self {
            version: env!("CARGO_PKG_VERSION").to_string(),
            release_base: std::env::var("ROCKY_TODO_RELEASE_BASE")
                .unwrap_or_else(|_| format!("https://github.com/{REPO}/releases/download")),
            apps_dir: PathBuf::from(home).join("Applications"),
        })
    }

    /// 설치될(된) 번들 경로.
    pub fn bundle_path(&self) -> PathBuf {
        self.apps_dir.join(BUNDLE_NAME)
    }

    fn asset_url(&self, name: &str) -> String {
        format!(
            "{}/v{}/{name}",
            self.release_base.trim_end_matches('/'),
            self.version
        )
    }
}

/// 릴리스 첨부물 이름 — release.yml 의 Package 스텝과 같은 규칙.
pub fn asset_name(version: &str) -> String {
    format!("rocky-todo-v{version}-{TARGET}.app.zip")
}

/// `SHA256SUMS` 에서 한 파일의 해시를 찾는다. 형식은 `shasum` 출력(`<hex>  <name>`,
/// 바이너리 모드면 `*<name>`).
pub fn find_sha256(sums: &str, asset: &str) -> Option<String> {
    sums.lines().find_map(|line| {
        let mut parts = line.split_whitespace();
        let hash = parts.next()?;
        let name = parts.next()?.trim_start_matches('*');
        (name == asset && hash.len() == 64).then(|| hash.to_ascii_lowercase())
    })
}

/// SHA-256 을 소문자 hex 로.
pub fn sha256_hex(bytes: &[u8]) -> String {
    ring::digest::digest(&ring::digest::SHA256, bytes)
        .as_ref()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// 설치된 번들의 `CFBundleShortVersionString`. 번들이 없거나 plist 를 못 읽으면 `None`.
///
/// plist 는 Tauri 가 쓰는 XML 이라 `<key>` 다음 `<string>` 을 텍스트로 찾는다 — plist
/// 파서를 들이기엔 읽는 값이 하나뿐이다.
pub fn installed_version(bundle: &Path) -> Option<String> {
    let plist = fs::read_to_string(bundle.join("Contents/Info.plist")).ok()?;
    let key = "<key>CFBundleShortVersionString</key>";
    let rest = &plist[plist.find(key)? + key.len()..];
    let start = rest.find("<string>")? + "<string>".len();
    let end = rest[start..].find("</string>")? + start;
    Some(rest[start..end].trim().to_string())
}

/// 이 바이너리가 도는 곳이 릴리스 타깃인지 — 아니면 받아도 실행이 안 된다.
fn check_platform() -> Result<(), String> {
    if std::env::consts::OS == "macos" && std::env::consts::ARCH == "aarch64" {
        Ok(())
    } else {
        Err(format!(
            "미지원 플랫폼: {}-{} (앱은 {TARGET} 만 제공한다)",
            std::env::consts::OS,
            std::env::consts::ARCH
        ))
    }
}

fn http_agent(total: Duration) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_connect(Some(Duration::from_secs(5)))
        .timeout_global(Some(total))
        .build()
        .into()
}

/// URL 을 `limit` 바이트까지 받아 메모리에 든다. 상태 코드가 2xx 가 아니면 ureq 가 에러다.
fn fetch(url: &str, limit: u64, total: Duration) -> Result<Vec<u8>, String> {
    let mut response = http_agent(total)
        .get(url)
        .call()
        .map_err(|error| format!("다운로드 실패: {url} — {error}"))?;
    let mut buf = Vec::new();
    response
        .body_mut()
        .with_config()
        .limit(limit)
        .reader()
        .read_to_end(&mut buf)
        .map_err(|error| format!("다운로드 실패: {url} — {error}"))?;
    Ok(buf)
}

/// `ditto -x -k` — Archive Utility 와 같은 방식으로 푼다. zip 크레이트 대신 이걸 쓰는
/// 이유는 번들 안의 심볼릭 링크·권한·서명 리소스를 macOS 규약 그대로 복원하기 위해서다.
fn ditto_extract(zip: &Path, into: &Path) -> Result<(), String> {
    let out = Command::new("ditto")
        .arg("-x")
        .arg("-k")
        .arg(zip)
        .arg(into)
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("ditto 를 실행하지 못했다: {error}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!(
            "zip 을 풀지 못했다: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    }
}

/// 다운로드 → 검증 → 교체. 성공하면 설치된 번들 경로.
///
/// 교체는 `apps_dir` 안의 임시 디렉터리에서 `rename` 두 번(옛 것 비키기 → 새 것 들이기)
/// 이라 같은 파일시스템 안에서 끝나고, 어느 시점에 죽어도 반쯤 풀린 번들이 그 이름을
/// 차지하지 않는다. 옛 번들은 새 것이 자리에 들어간 뒤에야 지운다.
pub fn install(plan: &AppInstall, log: &mut dyn Write) -> Result<PathBuf, String> {
    check_platform()?;
    let asset = asset_name(&plan.version);
    let bundle = plan.bundle_path();

    let _ = writeln!(
        log,
        "rocky-todo: v{} 앱을 내려받는다 ({asset})",
        plan.version
    );
    let sums = fetch(
        &plan.asset_url("SHA256SUMS"),
        MAX_SUMS_BYTES,
        Duration::from_secs(15),
    )?;
    let expected = find_sha256(&String::from_utf8_lossy(&sums), &asset)
        .ok_or_else(|| format!("SHA256SUMS 에 {asset} 항목이 없다"))?;
    let zip = fetch(
        &plan.asset_url(&asset),
        MAX_ZIP_BYTES,
        Duration::from_secs(120),
    )?;
    let actual = sha256_hex(&zip);
    if actual != expected {
        return Err(format!(
            "체크섬 불일치: {asset}\n  기대 {expected}\n  실제 {actual}"
        ));
    }

    fs::create_dir_all(&plan.apps_dir)
        .map_err(|error| format!("{} 를 만들지 못했다: {error}", plan.apps_dir.display()))?;
    // 숨김 접두사 — 설치 도중 Finder/Spotlight 가 반쯤 풀린 번들을 앱으로 집지 않게.
    let stage = tempfile::Builder::new()
        .prefix(".rocky-todo-install-")
        .tempdir_in(&plan.apps_dir)
        .map_err(|error| format!("임시 디렉터리를 만들지 못했다: {error}"))?;
    let zip_path = stage.path().join(&asset);
    fs::write(&zip_path, &zip).map_err(|error| format!("zip 을 쓰지 못했다: {error}"))?;
    let unpack = stage.path().join("unpack");
    fs::create_dir(&unpack).map_err(|error| error.to_string())?;
    ditto_extract(&zip_path, &unpack)?;
    let fresh = unpack.join(BUNDLE_NAME);
    if !fresh.join("Contents/Info.plist").is_file() {
        return Err(format!("zip 안에 {BUNDLE_NAME} 이 없다"));
    }
    match installed_version(&fresh) {
        Some(v) if v == plan.version => {}
        other => {
            return Err(format!(
                "받은 앱의 버전이 다르다: {} (기대 {})",
                other.unwrap_or_else(|| "?".into()),
                plan.version
            ))
        }
    }

    let old = stage.path().join("old.app");
    if bundle.exists() {
        fs::rename(&bundle, &old)
            .map_err(|error| format!("{} 를 비키지 못했다: {error}", bundle.display()))?;
    }
    if let Err(error) = fs::rename(&fresh, &bundle) {
        let message = format!("{} 에 설치하지 못했다: {error}", bundle.display());
        // 되돌린다. 그것마저 실패하면 stage 를 지우지 않는다 — 드롭이 old.app 까지
        // 치워 기존 설치가 사라지는 것보다 사용자가 손으로 옮기는 게 낫다.
        if old.exists() {
            if let Err(rollback) = fs::rename(&old, &bundle) {
                let kept = stage.keep();
                return Err(format!(
                    "{message}
옛 번들을 되돌리지 못했다({rollback}) — {} 에 남겨 뒀다",
                    kept.join("old.app").display()
                ));
            }
        }
        return Err(message);
    }
    // old 는 stage 와 함께 지워진다
    let _ = writeln!(log, "✓ {} (v{})", bundle.display(), plan.version);
    Ok(bundle)
}

/// 설치가 필요한지 — 없거나 버전이 다르면 설치한다. 같은 버전이면 그대로.
pub fn ensure_installed(plan: &AppInstall, log: &mut dyn Write) -> Result<PathBuf, String> {
    let bundle = plan.bundle_path();
    match installed_version(&bundle) {
        Some(v) if v == plan.version => Ok(bundle),
        _ => install(plan, log),
    }
}

/// `open <bundle>` — LaunchServices 에 맡긴다. 이미 떠 있으면 앞으로 가져온다.
fn open_bundle(bundle: &Path) -> Result<(), String> {
    let status = Command::new("open")
        .arg(bundle)
        .stdin(Stdio::null())
        .status()
        .map_err(|error| format!("open 을 실행하지 못했다: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("{} 를 열지 못했다 ({status})", bundle.display()))
    }
}

/// `app [open|install|status] [--force]`. 인자 없음은 `open` — 없으면 받아서 연다.
pub fn cmd_app(rest: &[String], force: bool) -> Result<(), String> {
    const USAGE: &str = "usage: rocky-todo app [open|install|status] [--force]";
    if rest.len() > 1 {
        return Err(USAGE.into());
    }
    // status 도 막는다 — 다른 플랫폼에서 "미설치" 는 틀린 답이다
    check_platform()?;
    let plan = AppInstall::from_env()?;
    // --force 는 open/install 공통 — 같은 버전이어도 다시 받는다(망가진 번들 복구용)
    let ensure = |force: bool| {
        let mut log = std::io::stderr();
        if force {
            install(&plan, &mut log)
        } else {
            ensure_installed(&plan, &mut log)
        }
    };
    match rest.first().map(String::as_str) {
        None | Some("open") => {
            let bundle = ensure(force)?;
            open_bundle(&bundle)
        }
        Some("install") => {
            println!("{}", ensure(force)?.display());
            Ok(())
        }
        Some("status") => {
            let bundle = plan.bundle_path();
            match installed_version(&bundle) {
                Some(v) => println!(
                    "{} v{v}{}",
                    bundle.display(),
                    if v == plan.version {
                        ""
                    } else {
                        " (CLI 와 버전 다름 — `app install` 로 맞춘다)"
                    }
                ),
                None => println!("미설치 ({})", bundle.display()),
            }
            Ok(())
        }
        _ => Err(USAGE.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asset_name_follows_release_layout() {
        assert_eq!(
            asset_name("0.15.0-next.1"),
            "rocky-todo-v0.15.0-next.1-aarch64-apple-darwin.app.zip"
        );
    }

    #[test]
    fn find_sha256_matches_exact_name_only() {
        let sums = "aaaa  rocky-todo-v1-aarch64-apple-darwin.tar.gz\n\
                    0123456789abcdef0123456789abcdef0123456789abcdef0123456789ABCDEF *rocky-todo-v1-aarch64-apple-darwin.app.zip\n";
        assert_eq!(
            find_sha256(sums, "rocky-todo-v1-aarch64-apple-darwin.app.zip").as_deref(),
            Some("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")
        );
        // 해시 길이가 틀린 줄은 무시한다
        assert_eq!(
            find_sha256(sums, "rocky-todo-v1-aarch64-apple-darwin.tar.gz"),
            None
        );
        assert_eq!(find_sha256(sums, "nope"), None);
    }

    #[test]
    fn sha256_hex_known_vector() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    fn write_bundle(dir: &Path, version: &str) -> PathBuf {
        let bundle = dir.join(BUNDLE_NAME);
        fs::create_dir_all(bundle.join("Contents/MacOS")).unwrap();
        fs::write(
            bundle.join("Contents/Info.plist"),
            format!(
                "<?xml version=\"1.0\"?>\n<plist version=\"1.0\"><dict>\n\
                 \t<key>CFBundleExecutable</key>\n\t<string>rocky-todo-app</string>\n\
                 \t<key>CFBundleShortVersionString</key>\n\t<string>{version}</string>\n\
                 </dict></plist>\n"
            ),
        )
        .unwrap();
        fs::write(bundle.join("Contents/MacOS/rocky-todo-app"), b"#!/bin/sh\n").unwrap();
        bundle
    }

    #[test]
    fn installed_version_reads_plist() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(installed_version(&dir.path().join(BUNDLE_NAME)), None);
        let bundle = write_bundle(dir.path(), "0.15.0-next.1");
        assert_eq!(installed_version(&bundle).as_deref(), Some("0.15.0-next.1"));
    }

    /// 로컬 HTTP 서버 + ditto 로 만든 zip 으로 설치 경로 전체를 돈다 — macOS 전용
    /// (ditto). 응답은 요청 경로별 바이트 맵.
    #[cfg(target_os = "macos")]
    mod e2e {
        use super::*;
        use std::collections::HashMap;
        use std::io::{BufRead, BufReader};
        use std::net::TcpListener;
        use std::sync::Arc;

        fn serve(files: HashMap<String, Vec<u8>>) -> String {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let base = format!("http://{}", listener.local_addr().unwrap());
            let files = Arc::new(files);
            std::thread::spawn(move || {
                for stream in listener.incoming() {
                    let Ok(mut stream) = stream else { break };
                    let files = Arc::clone(&files);
                    std::thread::spawn(move || {
                        let mut reader = BufReader::new(stream.try_clone().unwrap());
                        let mut line = String::new();
                        reader.read_line(&mut line).unwrap();
                        let path = line.split_whitespace().nth(1).unwrap_or("/").to_string();
                        // 헤더는 빈 줄까지 버린다
                        loop {
                            let mut h = String::new();
                            if reader.read_line(&mut h).unwrap() == 0 || h.trim().is_empty() {
                                break;
                            }
                        }
                        let response = match files.get(&path) {
                            Some(body) => {
                                let mut r = format!(
                                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                    body.len()
                                )
                                .into_bytes();
                                r.extend_from_slice(body);
                                r
                            }
                            None => b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec(),
                        };
                        let _ = stream.write_all(&response);
                    });
                }
            });
            base
        }

        fn zipped_bundle(version: &str) -> Vec<u8> {
            let dir = tempfile::tempdir().unwrap();
            let bundle = write_bundle(dir.path(), version);
            let zip = dir.path().join("app.zip");
            let ok = Command::new("ditto")
                .args(["-c", "-k", "--keepParent"])
                .arg(&bundle)
                .arg(&zip)
                .status()
                .unwrap()
                .success();
            assert!(ok);
            fs::read(zip).unwrap()
        }

        fn release(version: &str, zip: Vec<u8>, sums: String) -> AppInstall {
            let asset = asset_name(version);
            let mut files = HashMap::new();
            files.insert(format!("/v{version}/{asset}"), zip);
            files.insert(format!("/v{version}/SHA256SUMS"), sums.into_bytes());
            AppInstall {
                version: version.to_string(),
                release_base: serve(files),
                apps_dir: tempfile::tempdir().unwrap().keep(),
            }
        }

        #[test]
        fn installs_then_skips_when_same_version() {
            let zip = zipped_bundle("9.9.9");
            let sums = format!("{}  {}\n", sha256_hex(&zip), asset_name("9.9.9"));
            let plan = release("9.9.9", zip, sums);
            let mut log = Vec::new();
            let bundle = install(&plan, &mut log).unwrap();
            assert_eq!(bundle, plan.apps_dir.join(BUNDLE_NAME));
            assert_eq!(installed_version(&bundle).as_deref(), Some("9.9.9"));
            assert!(String::from_utf8_lossy(&log).contains("내려받는다"));
            // 임시 스테이지가 남지 않는다
            let leftovers: Vec<_> = fs::read_dir(&plan.apps_dir)
                .unwrap()
                .filter_map(|e| e.ok())
                .filter(|e| e.file_name() != BUNDLE_NAME)
                .collect();
            assert!(leftovers.is_empty(), "{leftovers:?}");

            let mut log = Vec::new();
            ensure_installed(&plan, &mut log).unwrap();
            assert!(log.is_empty(), "같은 버전이면 다시 받지 않는다");
            fs::remove_dir_all(&plan.apps_dir).unwrap();
        }

        #[test]
        fn replaces_older_bundle() {
            let zip = zipped_bundle("9.9.9");
            let sums = format!("{}  {}\n", sha256_hex(&zip), asset_name("9.9.9"));
            let plan = release("9.9.9", zip, sums);
            let old = write_bundle(&plan.apps_dir, "1.0.0");
            fs::write(old.join("Contents/marker"), b"old").unwrap();
            let mut log = Vec::new();
            let bundle = ensure_installed(&plan, &mut log).unwrap();
            assert_eq!(installed_version(&bundle).as_deref(), Some("9.9.9"));
            assert!(
                !bundle.join("Contents/marker").exists(),
                "옛 번들이 통째로 교체된다"
            );
            fs::remove_dir_all(&plan.apps_dir).unwrap();
        }

        #[test]
        fn rejects_checksum_mismatch_and_keeps_old() {
            let zip = zipped_bundle("9.9.9");
            let sums = format!("{}  {}\n", sha256_hex(b"tampered"), asset_name("9.9.9"));
            let plan = release("9.9.9", zip, sums);
            write_bundle(&plan.apps_dir, "1.0.0");
            let error = install(&plan, &mut Vec::new()).unwrap_err();
            assert!(error.contains("체크섬 불일치"), "{error}");
            assert_eq!(
                installed_version(&plan.bundle_path()).as_deref(),
                Some("1.0.0")
            );
            fs::remove_dir_all(&plan.apps_dir).unwrap();
        }

        #[test]
        fn rejects_version_mismatch_inside_zip() {
            let zip = zipped_bundle("1.2.3");
            let sums = format!("{}  {}\n", sha256_hex(&zip), asset_name("9.9.9"));
            let plan = release("9.9.9", zip, sums);
            let error = install(&plan, &mut Vec::new()).unwrap_err();
            assert!(error.contains("버전이 다르다"), "{error}");
            fs::remove_dir_all(&plan.apps_dir).unwrap();
        }

        #[test]
        fn missing_release_is_a_download_error() {
            let plan = AppInstall {
                version: "0.0.0".into(),
                release_base: serve(HashMap::new()),
                apps_dir: tempfile::tempdir().unwrap().keep(),
            };
            let error = install(&plan, &mut Vec::new()).unwrap_err();
            assert!(error.contains("다운로드 실패"), "{error}");
            fs::remove_dir_all(&plan.apps_dir).unwrap();
        }
    }
}
