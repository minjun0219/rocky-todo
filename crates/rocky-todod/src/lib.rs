//! rocky-todod — axum REST + SSE + rmcp /mcp 데몬 (lib).
//!
//! lib 크레이트인 이유: Tauri 앱(app/)이 같은 프로세스에 마운트한다.
//! 단독 실행(헤드리스/개발)은 src/main.rs.

pub mod config;
pub mod daemon;
pub mod github;
pub mod mcp;
pub mod runner;
pub mod server;
pub mod sessions_exec;
pub mod spawnctl;
pub mod tailscale;
