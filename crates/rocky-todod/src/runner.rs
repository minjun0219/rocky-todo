//! 외부 명령 실행 — `gh` / `tailscale` / `claude` 공용.
//!
//! TS 의 `Bun.spawnSync`(동기 블로킹 — 데몬 전체가 멎는다)와 달리 전부 tokio 비동기다.
//! 주입 가능한 함수 타입으로 두어 테스트가 프로세스 없이 계약을 검증한다.

use std::future::Future;
use std::pin::Pin;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

#[derive(Debug, Clone)]
pub struct CmdOutput {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

impl CmdOutput {
    pub fn ok(&self) -> bool {
        self.code == 0
    }

    pub fn failure(message: impl Into<String>) -> Self {
        CmdOutput {
            code: 1,
            stdout: String::new(),
            stderr: message.into(),
        }
    }
}

pub type BoxFut<T> = Pin<Box<dyn Future<Output = T> + Send>>;

/// (argv, stdin, timeout) → 출력. argv 배열이라 셸이 개입하지 않는다(주입 없음).
pub type Runner = Arc<dyn Fn(Vec<String>, String, Duration) -> BoxFut<CmdOutput> + Send + Sync>;

/// 기본 실행기 — 프로세스가 timeout 을 넘기면 죽이고 실패로 돌려준다.
/// (`wait_with_output` 은 detach 손자가 fd 를 물면 매달린다 — 그런 명령(`claude --bg`)은
/// 이 러너가 아니라 `run_in_dir` 를 쓴다.)
pub fn default_runner() -> Runner {
    Arc::new(|cmd, stdin, timeout| {
        Box::pin(async move {
            let Some((program, args)) = cmd.split_first() else {
                return CmdOutput::failure("empty command");
            };
            let mut command = tokio::process::Command::new(program);
            command
                .args(args)
                .stdin(if stdin.is_empty() {
                    Stdio::null()
                } else {
                    Stdio::piped()
                })
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true);
            let mut child = match command.spawn() {
                Ok(child) => child,
                Err(error) => return CmdOutput::failure(error.to_string()),
            };
            if !stdin.is_empty() {
                if let Some(mut handle) = child.stdin.take() {
                    use tokio::io::AsyncWriteExt;
                    let _ = handle.write_all(stdin.as_bytes()).await;
                    drop(handle); // EOF
                }
            }
            match tokio::time::timeout(timeout, child.wait_with_output()).await {
                Ok(Ok(output)) => CmdOutput {
                    code: output.status.code().unwrap_or(1),
                    stdout: String::from_utf8_lossy(&output.stdout).to_string(),
                    stderr: String::from_utf8_lossy(&output.stderr).to_string(),
                },
                Ok(Err(error)) => CmdOutput::failure(error.to_string()),
                // kill_on_drop 이 자식을 정리한다.
                Err(_) => {
                    CmdOutput::failure(format!("{}ms 안에 끝나지 않았다", timeout.as_millis()))
                }
            }
        })
    })
}
