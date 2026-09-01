//! TS `src/client.test.ts` 포팅 — 실제 HTTP 서버를 띄워 왕복시킨다.
//!
//! 목(mock) 대신 진짜 소켓을 쓰는 이유는 이 모듈의 값이 전부 **전송 계층 세부**에 있기
//! 때문이다: 신원 검증, 4xx 본문에서 에러 메시지 꺼내기, actor 헤더 부착. 목으로는
//! 그중 어느 것도 증명되지 않는다.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::mpsc;
use std::thread;

use rocky_todo_cli::client::{build_context, daemon_health, health, request_value};

/// 테스트 서버의 응답 한 벌.
struct Reply {
    status: &'static str,
    body: &'static str,
}

/// `/api/health` 와 그 외 경로에 **다른** 응답을 주는 테스트 서버.
///
/// 둘을 가르는 게 핵심이다 — `request_value` 는 먼저 `ensure_daemon` 으로 health 를
/// 확인하므로, 한 응답만 주는 서버로는 "health 는 통과했는데 본 요청이 4xx" 를 만들 수
/// 없다. 그러면 에러 경로 테스트가 기동 실패로도 통과해 아무것도 증명하지 못한다.
///
/// 받은 요청 원문은 채널로 넘겨 헤더를 검사할 수 있게 한다.
fn serve(health_reply: Reply, other_reply: Reply) -> (u16, mpsc::Receiver<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = listener.local_addr().expect("addr").port();
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let mut buf = [0u8; 8192];
            let read = stream.read(&mut buf).unwrap_or(0);
            let raw = String::from_utf8_lossy(&buf[..read]).to_string();
            let reply = if raw.contains("/api/health") {
                &health_reply
            } else {
                &other_reply
            };
            let _ = tx.send(raw);
            let response = format!(
                "HTTP/1.1 {}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                reply.status,
                reply.body.len(),
                reply.body
            );
            let _ = stream.write_all(response.as_bytes());
            let _ = stream.flush();
        }
    });
    (port, rx)
}

/// 정상 데몬으로 인정받는 health 응답.
fn ok_health() -> Reply {
    Reply {
        status: "200 OK",
        body: r#"{"ok":true,"name":"rocky-todo","version":"9.9.9"}"#,
    }
}

fn empty_json() -> Reply {
    Reply {
        status: "200 OK",
        body: "{}",
    }
}

#[test]
fn health_accepts_a_genuine_daemon() {
    let (port, _rx) = serve(ok_health(), empty_json());
    let found = daemon_health(&format!("http://127.0.0.1:{port}")).expect("데몬으로 인정해야 한다");
    assert!(found.ok);
    assert_eq!(found.version.as_deref(), Some("9.9.9"));
}

/// **신원 검증** — 같은 포트에 뜬 무관한 서비스의 2xx JSON 을 데몬으로 오인하면
/// 호출자가 남의 프로세스에 SIGTERM 을 보낼 수 있다.
#[test]
fn health_rejects_another_service_on_the_same_port() {
    let (port, _rx) = serve(
        Reply {
            status: "200 OK",
            body: r#"{"ok":true,"name":"something-else"}"#,
        },
        empty_json(),
    );
    assert!(daemon_health(&format!("http://127.0.0.1:{port}")).is_none());
}

#[test]
fn health_rejects_a_body_without_ok() {
    let (port, _rx) = serve(
        Reply {
            status: "200 OK",
            body: r#"{"name":"rocky-todo"}"#,
        },
        empty_json(),
    );
    assert!(daemon_health(&format!("http://127.0.0.1:{port}")).is_none());
}

#[test]
fn health_rejects_a_non_2xx_response() {
    let (port, _rx) = serve(
        Reply {
            status: "500 Internal Server Error",
            body: r#"{"ok":true,"name":"rocky-todo"}"#,
        },
        empty_json(),
    );
    assert!(!health(&format!("http://127.0.0.1:{port}")));
}

/// 아무도 안 듣는 포트 — 붙지 못하면 데몬이 아니다.
#[test]
fn health_on_a_dead_port_is_none() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = listener.local_addr().expect("addr").port();
    drop(listener);
    assert!(!health(&format!("http://127.0.0.1:{port}")));
}

/// 모든 요청에 actor 헤더가 붙어야 히스토리에 누가 했는지 남는다.
/// health 조회에는 붙지 않으므로 **본 요청** 쪽에서 확인한다.
#[test]
fn request_attaches_the_actor_header() {
    let (port, rx) = serve(
        ok_health(),
        Reply {
            status: "200 OK",
            body: "[]",
        },
    );
    let ctx = build_context(port, std::env::temp_dir(), "tester");
    request_value(&ctx, "GET", "/api/todos", None).expect("요청이 성공해야 한다");

    let mut saw_todos_with_actor = false;
    while let Ok(raw) = rx.try_recv() {
        if raw.contains("/api/todos") && raw.to_lowercase().contains("x-rocky-actor: tester") {
            saw_todos_with_actor = true;
        }
    }
    assert!(saw_todos_with_actor, "본 요청에 x-rocky-actor 헤더가 없다");
}

/// 4xx 는 상태 코드로 뭉개지 않고 본문의 `error` 를 그대로 올린다 — 그게 사용자가
/// 읽을 메시지다. health 는 통과시키고 본 요청만 400 으로 답해 이 경로를 고립시킨다.
#[test]
fn request_surfaces_the_error_body_on_failure() {
    let (port, _rx) = serve(
        ok_health(),
        Reply {
            status: "400 Bad Request",
            body: r#"{"error":"board key already in use"}"#,
        },
    );
    let ctx = build_context(port, std::env::temp_dir(), "tester");
    let error = request_value(&ctx, "POST", "/api/boards", None).unwrap_err();
    assert_eq!(error, "board key already in use");
}

/// `error` 가 없는 실패는 상태 코드로 떨어진다 — 조용히 성공하지 않는다.
#[test]
fn request_falls_back_to_the_status_code_without_an_error_field() {
    let (port, _rx) = serve(
        ok_health(),
        Reply {
            status: "503 Service Unavailable",
            body: "{}",
        },
    );
    let ctx = build_context(port, std::env::temp_dir(), "tester");
    let error = request_value(&ctx, "GET", "/api/todos", None).unwrap_err();
    assert!(error.contains("503"), "{error}");
}

/// 2xx 본문은 그대로 돌아온다.
#[test]
fn request_returns_the_parsed_body_on_success() {
    let (port, _rx) = serve(
        ok_health(),
        Reply {
            status: "201 Created",
            body: r#"{"id":"807modyl","number":1}"#,
        },
    );
    let ctx = build_context(port, std::env::temp_dir(), "tester");
    let value = request_value(&ctx, "POST", "/api/todos", None).expect("성공해야 한다");
    assert_eq!(value.get("id").and_then(|v| v.as_str()), Some("807modyl"));
    assert_eq!(value.get("number").and_then(|v| v.as_i64()), Some(1));
}
