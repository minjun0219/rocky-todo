//! TS `src/tailscale.test.ts` 포팅.

use std::sync::{Arc, Mutex};

use rocky_todod::runner::{CmdOutput, Runner};
use rocky_todod::tailscale::*;

fn json_for(port: u16) -> String {
    format!(
        r#"{{"Web":{{"host.ts.net:443":{{"Handlers":{{"/":{{"Proxy":"http://127.0.0.1:{port}"}}}}}}}}}}"#
    )
}

#[test]
fn parses_loopback_proxy_port_at_root() {
    assert_eq!(parse_serve_proxy_port(&json_for(8636)), Some(8636));
}

#[test]
fn ipv6_loopback_counts() {
    let json = r#"{"Web":{"h:443":{"Handlers":{"/":{"Proxy":"http://[::1]:8993"}}}}}"#;
    assert_eq!(parse_serve_proxy_port(json), Some(8993));
    let localhost = r#"{"Web":{"h:443":{"Handlers":{"/":{"Proxy":"http://localhost:8993"}}}}}"#;
    assert_eq!(parse_serve_proxy_port(localhost), Some(8993));
}

#[test]
fn unset_or_unparsable_is_none() {
    assert_eq!(parse_serve_proxy_port(""), None);
    assert_eq!(parse_serve_proxy_port("not json"), None);
    assert_eq!(parse_serve_proxy_port("{}"), None);
    assert_eq!(parse_serve_proxy_port(r#"{"Web":{}}"#), None);
}

#[test]
fn non_loopback_target_is_ignored() {
    let json = r#"{"Web":{"h:443":{"Handlers":{"/":{"Proxy":"http://192.168.1.5:8636"}}}}}"#;
    assert_eq!(parse_serve_proxy_port(json), None);
}

#[test]
fn non_root_paths_only_is_none() {
    let json = r#"{"Web":{"h:443":{"Handlers":{"/api":{"Proxy":"http://127.0.0.1:8636"}}}}}"#;
    assert_eq!(parse_serve_proxy_port(json), None);
}

#[test]
fn empty_slot_claims() {
    let decision = decide_serve_action(8636, None, false);
    assert_eq!(decision.action, ServeAction::Claim);
}

#[test]
fn own_port_keeps() {
    let decision = decide_serve_action(8636, Some(8636), false);
    assert_eq!(decision.action, ServeAction::Keep);
}

#[test]
fn live_other_daemon_yields() {
    let decision = decide_serve_action(8993, Some(8636), true);
    assert_eq!(decision.action, ServeAction::Yield);
    assert!(decision.message.contains(":8636"));
}

#[test]
fn dead_port_reclaims() {
    let decision = decide_serve_action(8636, Some(8993), false);
    assert_eq!(decision.action, ServeAction::Reclaim);
}

// ── ensure_tailscale_serve ──

fn recording_runner(status_json: String) -> (Runner, Arc<Mutex<Vec<Vec<String>>>>) {
    let calls: Arc<Mutex<Vec<Vec<String>>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = calls.clone();
    let runner: Runner = Arc::new(move |cmd, _stdin, _timeout| {
        sink.lock().unwrap().push(cmd.clone());
        let out = if cmd.get(2).map(String::as_str) == Some("status") {
            CmdOutput {
                code: 0,
                stdout: status_json.clone(),
                stderr: String::new(),
            }
        } else {
            CmdOutput {
                code: 0,
                stdout: "serve set".into(),
                stderr: String::new(),
            }
        };
        Box::pin(async move { out })
    });
    (runner, calls)
}

fn probe(alive: bool) -> impl Fn(u16) -> rocky_todod::runner::BoxFut<bool> {
    move |_port| Box::pin(async move { alive })
}

#[tokio::test]
async fn does_not_steal_live_daemons_serve() {
    let (runner, calls) = recording_runner(json_for(8636));
    let message = ensure_tailscale_serve(&runner, 8993, probe(true)).await;
    assert!(message.contains("건드리지 않는다"), "{message}");
    // serve --bg 를 실행하지 않았다
    let calls = calls.lock().unwrap();
    assert!(calls
        .iter()
        .all(|c| c.get(2).map(String::as_str) != Some("--bg")));
    assert!(!calls.iter().any(|c| c.contains(&"--bg".to_string())));
}

#[tokio::test]
async fn stale_dead_port_is_reclaimed() {
    let (runner, calls) = recording_runner(json_for(8636));
    let message = ensure_tailscale_serve(&runner, 8993, probe(false)).await;
    assert!(message.contains("되돌린다"), "{message}");
    let calls = calls.lock().unwrap();
    assert!(calls.iter().any(|c| c.contains(&"--bg".to_string())));
}

#[tokio::test]
async fn own_port_is_noop_without_probe() {
    let (runner, calls) = recording_runner(json_for(8636));
    let probed = Arc::new(Mutex::new(false));
    let flag = probed.clone();
    let message = ensure_tailscale_serve(&runner, 8636, move |_| {
        *flag.lock().unwrap() = true;
        Box::pin(async { true })
    })
    .await;
    assert!(message.contains("이미"), "{message}");
    assert!(!*probed.lock().unwrap());
    let calls = calls.lock().unwrap();
    assert!(!calls.iter().any(|c| c.contains(&"--bg".to_string())));
}

#[tokio::test]
async fn unset_serve_claims() {
    let (runner, calls) = recording_runner("{}".into());
    let message = ensure_tailscale_serve(&runner, 8636, probe(false)).await;
    assert!(message.contains("활성화"), "{message}");
    let calls = calls.lock().unwrap();
    assert!(calls.iter().any(|c| c.contains(&"--bg".to_string())));
}

#[tokio::test]
async fn status_failure_is_fail_open() {
    let runner: Runner = Arc::new(|cmd, _stdin, _timeout| {
        Box::pin(async move {
            if cmd.get(2).map(String::as_str) == Some("status") {
                CmdOutput::failure("boom")
            } else {
                CmdOutput {
                    code: 1,
                    stdout: String::new(),
                    stderr: "serve failed".into(),
                }
            }
        })
    });
    let message = ensure_tailscale_serve(&runner, 8636, probe(false)).await;
    // claim 을 시도하고 실패해도 던지지 않는다
    assert!(message.contains("실패"), "{message}");
}
