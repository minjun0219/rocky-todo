//! TS `src/cli.ts` 의 인자 파서 포팅 (순수).
//!
//! **clap 을 쓰지 않는다.** 이 파서의 동작이 곧 CLI 의 사용자 표면이라 그대로 옮긴다 —
//! clap 은 `--name=value`·단축 플래그·`--` 구분자를 자동으로 받아들이고 도움말/에러
//! 문구도 달라서, 갈아끼우면 계약이 조용히 넓어진다. 규칙은 넷뿐이다:
//! `--` 로 시작하지 않으면 positional, 불리언은 존재만으로 참, 값 플래그는 **다음
//! argv 원소**를 값으로 먹고, 모르는 플래그는 에러다.

use std::collections::HashMap;

/// 존재만으로 참이 되는 플래그.
const BOOLEAN_FLAGS: [&str; 8] = [
    "all", "archived", "json", "global", "cancel", "help", "note", "last",
];

/// 다음 argv 원소를 값으로 먹는 플래그.
const VALUE_FLAGS: [&str; 15] = [
    "board", "section", "parent", "desc", "due", "priority", "actor", "title", "content", "limit",
    "repo", "session", "message", "to", "before",
];

/// 여러 번 줄 수 있어 값이 쌓이는 플래그.
const LIST_FLAGS: [&str; 2] = ["label", "link"];

/// 파싱된 플래그 값. TS 의 `string | boolean | string[]` 대응.
#[derive(Debug, Clone, PartialEq)]
pub enum FlagValue {
    Bool(bool),
    Str(String),
    List(Vec<String>),
}

impl FlagValue {
    /// 값 플래그로 읽는다. 불리언/리스트면 `None`.
    pub fn as_str(&self) -> Option<&str> {
        match self {
            FlagValue::Str(s) => Some(s),
            _ => None,
        }
    }

    /// 리스트 플래그로 읽는다.
    pub fn as_list(&self) -> Option<&[String]> {
        match self {
            FlagValue::List(v) => Some(v),
            _ => None,
        }
    }

    /// 불리언으로 읽는다 — 존재하면 참이므로 다른 종류여도 참으로 본다.
    pub fn is_true(&self) -> bool {
        match self {
            FlagValue::Bool(b) => *b,
            _ => true,
        }
    }
}

/// `parse_flags` 결과.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ParsedFlags {
    pub positionals: Vec<String>,
    pub flags: HashMap<String, FlagValue>,
}

impl ParsedFlags {
    /// 값 플래그를 문자열로.
    pub fn str_flag(&self, name: &str) -> Option<&str> {
        self.flags.get(name).and_then(FlagValue::as_str)
    }

    /// 불리언 플래그 — 없으면 false.
    pub fn bool_flag(&self, name: &str) -> bool {
        self.flags.get(name).is_some_and(FlagValue::is_true)
    }

    /// 리스트 플래그 — 없으면 빈 슬라이스.
    pub fn list_flag(&self, name: &str) -> &[String] {
        self.flags
            .get(name)
            .and_then(FlagValue::as_list)
            .unwrap_or(&[])
    }
}

/// argv 를 positional 과 플래그로 가른다.
///
/// `label` 만 쉼표로 쪼개 각 조각을 trim 하고 빈 것을 버린다(`--label a, ,b` → `["a","b"]`).
/// `link` 는 URL 이라 쪼개지 않는다 — 쿼리스트링에 쉼표가 들어갈 수 있다.
///
/// # Errors
/// 값 플래그 뒤에 값이 없거나, 모르는 `--플래그` 를 만나면 에러 문자열을 돌려준다.
pub fn parse_flags(argv: &[String]) -> Result<ParsedFlags, String> {
    let mut positionals: Vec<String> = Vec::new();
    let mut flags: HashMap<String, FlagValue> = HashMap::new();

    let mut i = 0;
    while i < argv.len() {
        let arg = &argv[i];
        if !arg.starts_with("--") {
            positionals.push(arg.clone());
            i += 1;
            continue;
        }
        let name = &arg[2..];
        if BOOLEAN_FLAGS.contains(&name) {
            flags.insert(name.to_string(), FlagValue::Bool(true));
            i += 1;
            continue;
        }
        let is_list = LIST_FLAGS.contains(&name);
        if VALUE_FLAGS.contains(&name) || is_list {
            i += 1;
            let Some(value) = argv.get(i) else {
                return Err(format!("flag --{name} requires a value"));
            };
            if is_list {
                let mut list = match flags.remove(name) {
                    Some(FlagValue::List(v)) => v,
                    _ => Vec::new(),
                };
                if name == "label" {
                    for piece in value.split(',') {
                        let trimmed = piece.trim();
                        if !trimmed.is_empty() {
                            list.push(trimmed.to_string());
                        }
                    }
                } else {
                    list.push(value.clone());
                }
                flags.insert(name.to_string(), FlagValue::List(list));
            } else {
                flags.insert(name.to_string(), FlagValue::Str(value.clone()));
            }
            i += 1;
            continue;
        }
        return Err(format!("unknown flag: --{name}"));
    }

    Ok(ParsedFlags { positionals, flags })
}
