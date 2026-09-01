//! 런타임 설정 해석 — TS 원본 `src/config.ts` + `src/rocky-config.ts`.
//!
//! 우선순위: env (`ROCKY_TODO_*`) > user `rocky.json` 의 `todo` 블록 > 기본값.
//! 데몬은 시스템 전역 단일 인스턴스라 project rocky.json 은 보지 않는다.

use std::path::{Path, PathBuf};

use crate::statusline::DEFAULT_STATUSLINE_TEMPLATE;

/// 기본 포트 — 키패드로 "todo" (8636).
pub const DEFAULT_TODO_PORT: u16 = 8636;

/// 노출 채널 — 빈 배열(기본)이면 루프백만.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExposeChannel {
    Lan,
    TailscaleServe,
}

impl ExposeChannel {
    fn parse(s: &str) -> Option<Self> {
        match s {
            "lan" => Some(ExposeChannel::Lan),
            "tailscale-serve" => Some(ExposeChannel::TailscaleServe),
            _ => None,
        }
    }
}

/// user rocky.json 의 `todo` 블록 (경량 파싱 — todo 블록만, `enabled` 미read).
#[derive(Debug, Clone, Default)]
pub struct TodoConfig {
    pub port: Option<u16>,
    pub dir: Option<String>,
    /// 문자열 하나("lan")도 허용 — 배열로 정규화. "off"/null 은 미설정과 동일.
    pub expose: Option<ExposeValue>,
    pub watch: Option<bool>,
    pub statusline_template: Option<String>,
}

#[derive(Debug, Clone)]
pub enum ExposeValue {
    Off,
    Channels(Vec<ExposeChannel>),
}

#[derive(Debug, Clone)]
pub struct TodoRuntimeConfig {
    pub port: u16,
    pub dir: PathBuf,
    /// 바인딩 호스트 — expose 에서 유도 (lan 포함 → 0.0.0.0, 아니면 127.0.0.1).
    pub host: String,
    pub expose: Vec<ExposeChannel>,
    /// 항상 채워진다(기본값 폴백).
    pub statusline_template: String,
}

/// `~/...` 를 홈으로 확장한다.
pub fn expand_tilde(input: &str) -> PathBuf {
    let home = || std::env::var("HOME").map(PathBuf::from).unwrap_or_default();
    if input == "~" {
        return home();
    }
    if let Some(rest) = input.strip_prefix("~/") {
        return home().join(rest);
    }
    PathBuf::from(input)
}

/// user-level config 기본 경로 — `~/.config/rocky/rocky.json`. env `ROCKY_CONFIG` 우선.
pub fn user_config_path() -> PathBuf {
    if let Ok(p) = std::env::var("ROCKY_CONFIG") {
        return PathBuf::from(p);
    }
    expand_tilde("~/.config/rocky/rocky.json")
}

/// user rocky.json 의 `todo` 블록만 읽는다. 파일 없음/파싱 실패/모양 오류는 전부
/// 기본값(fail-open — 데몬은 기본값으로 뜬다).
pub fn load_todo_config(config_path: &Path) -> TodoConfig {
    let Ok(raw) = std::fs::read_to_string(config_path) else {
        return TodoConfig::default();
    };
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return TodoConfig::default();
    };
    let Some(todo) = parsed.get("todo").and_then(|v| v.as_object()) else {
        return TodoConfig::default();
    };
    let mut out = TodoConfig::default();
    if let Some(port) = todo.get("port").and_then(|v| v.as_u64()) {
        out.port = u16::try_from(port).ok();
    }
    if let Some(dir) = todo.get("dir").and_then(|v| v.as_str()) {
        out.dir = Some(dir.to_string());
    }
    if let Some(expose) = todo.get("expose") {
        out.expose = parse_expose_value(expose);
    }
    if let Some(watch) = todo.get("watch").and_then(|v| v.as_bool()) {
        out.watch = Some(watch);
    }
    // 모양이 어긋나면 통째로 무시 — 다른 필드와 같은 fail-open 규칙.
    if let Some(template) = todo
        .get("statusline")
        .and_then(|v| v.as_object())
        .and_then(|s| s.get("template"))
        .and_then(|v| v.as_str())
    {
        out.statusline_template = Some(template.to_string());
    }
    out
}

fn parse_expose_value(value: &serde_json::Value) -> Option<ExposeValue> {
    match value {
        serde_json::Value::Null => Some(ExposeValue::Off),
        serde_json::Value::String(s) => {
            if s == "off" {
                Some(ExposeValue::Off)
            } else {
                ExposeChannel::parse(s).map(|c| ExposeValue::Channels(vec![c]))
            }
        }
        serde_json::Value::Array(items) => Some(ExposeValue::Channels(
            items
                .iter()
                .filter_map(|v| v.as_str())
                .filter_map(ExposeChannel::parse)
                .collect(),
        )),
        _ => None,
    }
}

/// env 스냅샷 — 테스트 주입용.
pub type EnvMap = std::collections::HashMap<String, String>;

pub fn env_snapshot() -> EnvMap {
    std::env::vars().collect()
}

fn parse_port(raw: Option<&String>) -> Option<u16> {
    raw?.trim().parse::<u16>().ok().filter(|p| *p >= 1)
}

/// env > config > 기본값. TS `resolveTodoRuntimeConfig` 와 동일 규칙.
pub fn resolve_runtime_config(env: &EnvMap, todo: &TodoConfig) -> TodoRuntimeConfig {
    let port = parse_port(env.get("ROCKY_TODO_PORT"))
        .or(todo.port)
        .unwrap_or(DEFAULT_TODO_PORT);
    let raw_dir = env
        .get("ROCKY_TODO_DIR")
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| todo.dir.clone())
        .unwrap_or_else(|| "~/.config/rocky/todo".to_string());
    // env 가 설정돼 있으면 (유효 채널이 없어도) config 를 통째로 덮어쓴다 — "off" 강제 차단 가능.
    let expose: Vec<ExposeChannel> = match env.get("ROCKY_TODO_EXPOSE") {
        Some(raw) => raw
            .split(',')
            .map(|t| t.trim().to_lowercase())
            .filter_map(|t| ExposeChannel::parse(&t))
            .collect(),
        None => match &todo.expose {
            None | Some(ExposeValue::Off) => Vec::new(),
            Some(ExposeValue::Channels(channels)) => channels.clone(),
        },
    };
    let host = if expose.contains(&ExposeChannel::Lan) {
        "0.0.0.0"
    } else {
        "127.0.0.1"
    };
    // 빈 문자열은 "출력 안 함" 이 아니라 오설정 — 기본 템플릿으로 폴백한다.
    let statusline_template = env
        .get("ROCKY_TODO_STATUSLINE")
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            todo.statusline_template
                .as_ref()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        })
        .unwrap_or_else(|| DEFAULT_STATUSLINE_TEMPLATE.to_string());

    TodoRuntimeConfig {
        port,
        dir: expand_tilde(&raw_dir),
        host: host.to_string(),
        expose,
        statusline_template,
    }
}
