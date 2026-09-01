//! TS `src/cli.ts` 의 서브커맨드 디스패치 포팅.
//!
//! 각 커맨드는 REST 한두 번을 치고 결과를 컴팩트 텍스트로 찍는다. `--json` 이면 서버
//! 응답 원본을 그대로 낸다 — 텍스트 렌더는 사람용이고 JSON 은 스크립트/모델용이라
//! 둘을 같은 형태로 억지로 맞추지 않는다.

use rocky_todo_core::github::{is_repo_slug, parse_repo_from_remote};
use rocky_todo_core::refs::TodoView;
use rocky_todo_core::types::{Board, Comment, HistoryEntry, Section};
use serde_json::{json, Value};

use crate::client::{request, request_value, CliContext};
use crate::flags::ParsedFlags;
use crate::format::*;

/// 텍스트/JSON 출력을 한 자리에서 가른다.
pub struct Printer {
    pub json: bool,
}

impl Printer {
    /// `--json` 이면 값 원본을, 아니면 `text()` 가 만든 문자열을 찍는다.
    ///
    /// 텍스트를 클로저로 받는 이유는 JSON 경로에서 렌더 비용을 아예 안 치르기 위해서다.
    pub fn emit(&self, value: &Value, text: impl FnOnce() -> String) {
        if self.json {
            println!(
                "{}",
                serde_json::to_string_pretty(value).unwrap_or_default()
            );
        } else {
            println!("{}", text());
        }
    }

    /// JSON 표현이 따로 없는 안내 문구 — `--json` 이어도 그대로 낸다.
    pub fn line(&self, text: &str) {
        println!("{text}");
    }
}

/// 현재 시각(epoch millis) — doing 경과 계산의 기준.
fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// `null` 이 아닌 값만 남긴 객체를 만든다.
///
/// 서버의 PATCH 는 **키의 존재**를 "이 필드를 바꾼다"로 읽는다. `None` 을 `null` 로
/// 실어 보내면 "지운다"가 되어, 플래그를 안 준 필드가 조용히 비워진다.
fn compact(pairs: Vec<(&str, Option<Value>)>) -> Value {
    let mut map = serde_json::Map::new();
    for (key, value) in pairs {
        if let Some(value) = value {
            map.insert(key.to_string(), value);
        }
    }
    Value::Object(map)
}

fn s(value: Option<&str>) -> Option<Value> {
    value.map(|v| json!(v))
}

/// `--link URL` 들을 서버가 받는 `[{ url }]` 형태로.
fn links_value(flags: &ParsedFlags) -> Option<Value> {
    let links = flags.list_flag("link");
    if links.is_empty() {
        return None;
    }
    Some(Value::Array(
        links.iter().map(|url| json!({ "url": url })).collect(),
    ))
}

fn labels_value(flags: &ParsedFlags) -> Option<Value> {
    let labels = flags.list_flag("label");
    if labels.is_empty() {
        None
    } else {
        Some(json!(labels))
    }
}

/// `ls` — 계층 + 섹션(또는 `--all` 이면 보드)으로 묶어 렌더한다.
pub fn cmd_ls(
    ctx: &CliContext,
    flags: &ParsedFlags,
    board: &str,
    printer: &Printer,
) -> Result<(), String> {
    // `--board` 를 명시하면 그 보드만 본다 — `--all` 과 같이 오면 명시가 이긴다.
    let all_view = flags.bool_flag("all") && flags.str_flag("board").is_none();
    let mut query: Vec<String> = Vec::new();
    if !all_view {
        query.push(format!("board={}", encode_uri_component(board)));
    }
    if flags.bool_flag("archived") {
        query.push("includeArchived=true".to_string());
    }
    let qs = if query.is_empty() {
        String::new()
    } else {
        format!("?{}", query.join("&"))
    };

    let raw = request_value(ctx, "GET", &format!("/api/todos{qs}"), None)?;
    let todos: Vec<TodoView> =
        serde_json::from_value(raw.clone()).map_err(|e| format!("todo 목록을 읽지 못했다: {e}"))?;
    let boards: Vec<Board> = request(ctx, "GET", "/api/boards", None)?;
    let sections: Vec<Section> = if all_view {
        Vec::new()
    } else {
        request(
            ctx,
            "GET",
            &format!("/api/sections?board={}", encode_uri_component(board)),
            None,
        )?
    };
    printer.emit(&raw, || {
        group_and_render(&todos, &sections, &boards, all_view, now_ms())
    });
    Ok(())
}

/// `add` — 새 todo.
pub fn cmd_add(
    ctx: &CliContext,
    rest: &[String],
    flags: &ParsedFlags,
    board: &str,
    printer: &Printer,
) -> Result<(), String> {
    let Some(title) = rest.first().filter(|t| !t.is_empty()) else {
        return Err("usage: rocky-todo add \"제목\" [플래그]".into());
    };
    let body = compact(vec![
        ("board", Some(json!(board))),
        ("title", Some(json!(title))),
        ("description", s(flags.str_flag("desc"))),
        ("section", s(flags.str_flag("section"))),
        ("parentId", s(flags.str_flag("parent"))),
        ("priority", s(flags.str_flag("priority"))),
        ("due", s(flags.str_flag("due"))),
        ("labels", labels_value(flags)),
        ("links", links_value(flags)),
    ]);
    let raw = request_value(ctx, "POST", "/api/todos", Some(&body))?;
    let todo: TodoView =
        serde_json::from_value(raw.clone()).map_err(|e| format!("응답을 읽지 못했다: {e}"))?;
    printer.emit(&raw, || format!("✓ {} 생성 ({board})", todo.r#ref));
    Ok(())
}

/// `show` — 상세 + 댓글 + 히스토리.
pub fn cmd_show(
    ctx: &CliContext,
    rest: &[String],
    board: &str,
    printer: &Printer,
) -> Result<(), String> {
    let Some(id) = rest.first() else {
        return Err("usage: rocky-todo show REF".into());
    };
    let raw = request_value(ctx, "GET", &todo_ref_path(id, "", board), None)?;
    let todo: TodoView = serde_json::from_value(raw.get("todo").cloned().unwrap_or(Value::Null))
        .map_err(|e| format!("응답을 읽지 못했다: {e}"))?;
    let history: Vec<HistoryEntry> =
        serde_json::from_value(raw.get("history").cloned().unwrap_or(json!([])))
            .unwrap_or_default();
    let comments: Vec<Comment> =
        serde_json::from_value(raw.get("comments").cloned().unwrap_or(json!([])))
            .unwrap_or_default();
    printer.emit(&raw, || {
        format_todo_show(&todo, &history, &comments, now_ms())
    });
    Ok(())
}

/// `update` — 메타 수정.
pub fn cmd_update(
    ctx: &CliContext,
    rest: &[String],
    flags: &ParsedFlags,
    board: &str,
    printer: &Printer,
) -> Result<(), String> {
    let Some(id) = rest.first() else {
        return Err("usage: rocky-todo update REF [플래그]".into());
    };
    let body = compact(vec![
        ("title", s(flags.str_flag("title"))),
        ("description", s(flags.str_flag("desc"))),
        ("section", s(flags.str_flag("section"))),
        ("parentId", s(flags.str_flag("parent"))),
        ("priority", s(flags.str_flag("priority"))),
        ("due", s(flags.str_flag("due"))),
        ("labels", labels_value(flags)),
        ("links", links_value(flags)),
    ]);
    let raw = request_value(ctx, "PATCH", &todo_ref_path(id, "", board), Some(&body))?;
    let todo: TodoView =
        serde_json::from_value(raw.clone()).map_err(|e| format!("응답을 읽지 못했다: {e}"))?;
    printer.emit(&raw, || format!("✓ {} 수정", todo.r#ref));
    Ok(())
}

/// `comment` — todo 타임라인에 한 줄.
pub fn cmd_comment(
    ctx: &CliContext,
    rest: &[String],
    board: &str,
    printer: &Printer,
) -> Result<(), String> {
    let (Some(id), Some(body)) = (rest.first(), rest.get(1)) else {
        return Err("usage: rocky-todo comment REF \"본문\"".into());
    };
    let raw = request_value(
        ctx,
        "POST",
        &todo_ref_path(id, "/comments", board),
        Some(&json!({ "body": body })),
    )?;
    printer.emit(&raw, || format!("✓ {id} 댓글 작성"));
    Ok(())
}

/// `start` / `stop` / `done` / `reopen` / `archive` / `unarchive`.
pub fn cmd_status(
    ctx: &CliContext,
    action: &str,
    rest: &[String],
    board: &str,
    printer: &Printer,
) -> Result<(), String> {
    let Some(id) = rest.first() else {
        return Err(format!("usage: rocky-todo {action} REF"));
    };
    let raw = request_value(
        ctx,
        "POST",
        &todo_ref_path(id, "/status", board),
        Some(&json!({ "action": action })),
    )?;
    let todo: TodoView =
        serde_json::from_value(raw.clone()).map_err(|e| format!("응답을 읽지 못했다: {e}"))?;
    printer.emit(&raw, || format!("✓ {} {action}", todo.r#ref));
    Ok(())
}

/// `move` — 보드 이동(`--to`) 또는 순서 이동(`--before` / `--last`).
pub fn cmd_move(
    ctx: &CliContext,
    rest: &[String],
    flags: &ParsedFlags,
    board: &str,
    printer: &Printer,
) -> Result<(), String> {
    const USAGE: &str = "usage: rocky-todo move REF --to BOARD | --before REF2 | --last";
    let Some(id) = rest.first() else {
        return Err(USAGE.into());
    };
    if let Some(to) = flags.str_flag("to") {
        let raw = request_value(
            ctx,
            "POST",
            &todo_ref_path(id, "/board", board),
            Some(&json!({ "board": to })),
        )?;
        let moved: TodoView =
            serde_json::from_value(raw.clone()).map_err(|e| format!("응답을 읽지 못했다: {e}"))?;
        printer.emit(&raw, || {
            format!("✓ {id} → {to} 보드로 이동 (새 참조 {})", moved.r#ref)
        });
        return Ok(());
    }
    let before = flags.str_flag("before");
    let last = flags.bool_flag("last");
    if before.is_none() && !last {
        return Err(USAGE.into());
    }
    // `--last` 는 명시적 null 로 보낸다 — 여기서만 null 이 "맨 끝"이라는 뜻이다.
    let body = json!({ "before": if last { Value::Null } else { json!(before) } });
    let raw = request_value(ctx, "POST", &todo_ref_path(id, "/move", board), Some(&body))?;
    let moved: TodoView =
        serde_json::from_value(raw.clone()).map_err(|e| format!("응답을 읽지 못했다: {e}"))?;
    printer.emit(&raw, || format!("✓ {} 순서 이동", moved.r#ref));
    Ok(())
}

/// `sessions` — 실행 중인 Claude Code 세션 (`*` 는 이 보드).
pub fn cmd_sessions(ctx: &CliContext, board: &str, printer: &Printer) -> Result<(), String> {
    let raw = request_value(
        ctx,
        "GET",
        &format!("/api/sessions?board={}", encode_uri_component(board)),
        None,
    )?;
    let view: SessionsView =
        serde_json::from_value(raw.clone()).map_err(|e| format!("응답을 읽지 못했다: {e}"))?;
    printer.emit(&raw, || format_sessions(&view));
    Ok(())
}

/// `spawn` — 그 todo 전용 워크트리에 새 세션.
pub fn cmd_spawn(
    ctx: &CliContext,
    rest: &[String],
    flags: &ParsedFlags,
    board: &str,
    printer: &Printer,
) -> Result<(), String> {
    let Some(id) = rest.first() else {
        return Err("usage: rocky-todo spawn REF [--message \"본문\"]".into());
    };
    let body = match flags.str_flag("message") {
        Some(note) => json!({ "note": note }),
        None => json!({}),
    };
    let raw = request_value(
        ctx,
        "POST",
        &todo_ref_path(id, "/spawn", board),
        Some(&body),
    )?;
    let result: SpawnResult =
        serde_json::from_value(raw.clone()).map_err(|e| format!("응답을 읽지 못했다: {e}"))?;
    printer.emit(&raw, || format_spawn_result(id, &result));
    Ok(())
}

/// `section add|ls|archive`.
pub fn cmd_section(
    ctx: &CliContext,
    rest: &[String],
    board: &str,
    printer: &Printer,
) -> Result<(), String> {
    const USAGE: &str =
        "usage: rocky-todo section add \"이름\" | section ls | section archive \"이름\"";
    let sub = rest.first().map(String::as_str).unwrap_or("");
    let arg = rest.get(1).map(|s| s.trim());

    match (sub, arg) {
        ("add", Some(title)) if !title.is_empty() => {
            // 보드를 자동 생성하지 않는다 — `--board` 오타로 빈 보드가 조용히 생기면
            // 서버가 없는 보드를 404 로 거절하는 취지가 무너진다.
            let section: Section = request(
                ctx,
                "POST",
                "/api/sections",
                Some(&json!({ "board": board, "title": title })),
            )?;
            printer.line(&format!("✓ 섹션: {}", section.title));
            Ok(())
        }
        ("archive", Some(wanted)) if !wanted.is_empty() => {
            // 서버는 title 을 trim 해 저장한다 — 인자에 공백이 붙어도 같은 섹션을 찾게 맞춘다.
            let sections: Vec<Section> = request(
                ctx,
                "GET",
                &format!("/api/sections?board={}", encode_uri_component(board)),
                None,
            )?;
            let Some(target) = sections.into_iter().find(|s| s.title == wanted) else {
                return Err(format!("섹션 없음: {wanted} (board: {board})"));
            };
            request_value(
                ctx,
                "POST",
                &format!("/api/sections/{}/archive", encode_uri_component(&target.id)),
                None,
            )?;
            printer.line(&format!(
                "✓ 섹션 보관: {} — 속해 있던 작업은 미분류로 돌아간다",
                target.title
            ));
            Ok(())
        }
        ("ls", _) => {
            let raw = request_value(
                ctx,
                "GET",
                &format!("/api/sections?board={}", encode_uri_component(board)),
                None,
            )?;
            let sections: Vec<Section> = serde_json::from_value(raw.clone()).unwrap_or_default();
            printer.emit(&raw, || {
                if sections.is_empty() {
                    "(섹션 없음)".to_string()
                } else {
                    sections
                        .iter()
                        .map(|s| format!("# {}", s.title))
                        .collect::<Vec<_>>()
                        .join("\n")
                }
            });
            Ok(())
        }
        _ => Err(USAGE.into()),
    }
}

/// `handoff` — 실행 중인 세션에 작업 요청. `--cancel` 이면 대기 중인 요청 취소.
pub fn cmd_handoff(
    ctx: &CliContext,
    rest: &[String],
    flags: &ParsedFlags,
    board: &str,
    printer: &Printer,
) -> Result<(), String> {
    let Some(id) = rest.first() else {
        return Err(
            "usage: rocky-todo handoff REF [--session NAME] [--message \"본문\"] [--cancel]".into(),
        );
    };

    if flags.bool_flag("cancel") {
        // board 로 거르지 않는다 — 해석된 **실제 todo id** 로 찾으므로 필터가 불필요하고
        // 오히려 해롭다: `board` 는 cwd 유추값인데 REF 는 다른 보드를 가리킬 수 있어
        // (`other-12`), 거르면 실재하는 요청을 못 찾는다.
        let pending: Vec<rocky_todo_core::types::Handoff> =
            request(ctx, "GET", "/api/handoffs?status=pending", None)?;
        let detail = request_value(ctx, "GET", &todo_ref_path(id, "", board), None)?;
        let todo_id = detail
            .get("todo")
            .and_then(|t| t.get("id"))
            .and_then(|v| v.as_str())
            .ok_or_else(|| format!("{id} 를 찾지 못했다"))?;
        let Some(target) = pending.into_iter().find(|h| h.todo_id == todo_id) else {
            return Err(format!("{id} 앞으로 대기 중인 요청이 없다"));
        };
        let raw = request_value(
            ctx,
            "POST",
            &format!("/api/handoffs/{}/cancel", encode_uri_component(&target.id)),
            None,
        )?;
        printer.emit(&raw, || format!("✓ {id} 핸드오프 취소"));
        return Ok(());
    }

    // `--session` 이 오면 이름 → sessionId 로 바꾼다. 활성 목록에 없으면 여기서 끊는다 —
    // 없는 세션에 큐잉하면 영영 배달되지 않는다.
    let mut session_id: Option<String> = None;
    if let Some(name) = flags.str_flag("session") {
        let view: SessionsView = request(
            ctx,
            "GET",
            &format!("/api/sessions?board={}", encode_uri_component(board)),
            None,
        )?;
        session_id = view
            .sessions
            .iter()
            .find(|s| s.name == name)
            .map(|s| s.session_id.clone());
        if session_id.is_none() {
            return Err(format!("활성 세션이 아니다: {name}"));
        }
    }

    let body = compact(vec![
        ("sessionId", session_id.map(|v| json!(v))),
        ("note", s(flags.str_flag("message"))),
    ]);
    let raw = request_value(
        ctx,
        "POST",
        &todo_ref_path(id, "/handoff", board),
        Some(&body),
    )?;
    let created: HandoffCreated =
        serde_json::from_value(raw.clone()).map_err(|e| format!("응답을 읽지 못했다: {e}"))?;
    printer.emit(&raw, || render_handoff_created(id, &created));
    Ok(())
}

/// `board ls|show|add|rename|title|desc|repo|path` — 보드 메타.
///
/// `show` 를 뺀 수정 명령은 전부 **cwd 로 유추한 보드**를 고친다. 다른 보드는
/// `--board KEY` 로 지정한다.
pub fn cmd_board(
    ctx: &CliContext,
    rest: &[String],
    board: &str,
    printer: &Printer,
) -> Result<(), String> {
    const USAGE: &str = "usage: rocky-todo board ls | board show [KEY] | board add KEY [제목] | board rename NEWKEY | board title \"제목\" | board desc [\"설명\"] | board repo [OWNER/NAME] | board path [절대경로]\n  show 를 뺀 수정 명령은 모두 cwd 로 유추한 보드를 고친다 — 다른 보드는 --board KEY 로 지정한다";
    let sub = rest.first().map(String::as_str).unwrap_or("ls");
    let arg = rest.get(1).map(String::as_str);

    let patch = |field: &str, value: Value| -> Result<(Value, Board), String> {
        let mut body = serde_json::Map::new();
        body.insert(field.to_string(), value);
        let raw = request_value(
            ctx,
            "PATCH",
            &board_detail_path(board),
            Some(&Value::Object(body)),
        )?;
        let updated: Board =
            serde_json::from_value(raw.clone()).map_err(|e| format!("응답을 읽지 못했다: {e}"))?;
        Ok((raw, updated))
    };

    match sub {
        "ls" => {
            let raw = request_value(ctx, "GET", "/api/boards", None)?;
            let boards: Vec<Board> = serde_json::from_value(raw.clone()).unwrap_or_default();
            printer.emit(&raw, || {
                if boards.is_empty() {
                    "(보드 없음)".to_string()
                } else {
                    boards
                        .iter()
                        .map(|b| {
                            let desc = b
                                .description
                                .as_deref()
                                .filter(|d| !d.is_empty())
                                .map(|d| format!(" — {d}"))
                                .unwrap_or_default();
                            format!("{}  {}{desc}", b.key, b.title)
                        })
                        .collect::<Vec<_>>()
                        .join("\n")
                }
            });
            Ok(())
        }
        "add" => {
            let Some(key) = arg else {
                return Err(USAGE.into());
            };
            let body = compact(vec![
                ("key", Some(json!(key))),
                ("title", rest.get(2).map(|t| json!(t))),
            ]);
            let raw = request_value(ctx, "POST", "/api/boards", Some(&body))?;
            let created: Board = serde_json::from_value(raw.clone())
                .map_err(|e| format!("응답을 읽지 못했다: {e}"))?;
            printer.emit(&raw, || format!("✓ 보드 {}", created.key));
            Ok(())
        }
        "show" => {
            // 인자를 주면 그 보드, 없으면 cwd 로 유추한 보드.
            let wanted = arg.unwrap_or(board);
            let boards: Vec<Board> = request(ctx, "GET", "/api/boards", None)?;
            let found = boards
                .into_iter()
                .find(|b| {
                    b.key == wanted
                        || b.previous_keys
                            .as_ref()
                            .is_some_and(|keys| keys.iter().any(|k| k == wanted))
                })
                .ok_or_else(|| format!("보드 없음: {wanted}"))?;
            let raw = serde_json::to_value(&found).unwrap_or(Value::Null);
            printer.emit(&raw, || render_board(&found));
            Ok(())
        }
        "rename" => {
            let Some(new_key) = arg else {
                return Err(USAGE.into());
            };
            // key 는 참조 접두사(`rocky-12`)이자 cwd 유추 대상이지만, 옛 key 는 서버가
            // 별칭으로 남겨 계속 받는다 — 그래서 여기서 경고하지 않는다.
            let (raw, updated) = patch("key", json!(new_key))?;
            printer.emit(&raw, || {
                format!(
                    "✓ {board} → {} (옛 참조 {board}-N 은 계속 풀린다)",
                    updated.key
                )
            });
            Ok(())
        }
        "title" => {
            let Some(title) = arg else {
                return Err(USAGE.into());
            };
            let (raw, updated) = patch("title", json!(title))?;
            printer.emit(&raw, || format!("✓ {} → {}", updated.key, updated.title));
            Ok(())
        }
        "desc" => {
            // 인자 없이(또는 빈 문자열로) 부르면 설명을 지운다. 사람에게 둘은 같은
            // 의도인데 REST 는 `null` 만 "지운다"로 받고 빈 문자열은 400 이라 여기서 접는다.
            let next = match arg.map(str::trim).filter(|v| !v.is_empty()) {
                Some(value) => json!(value),
                None => Value::Null,
            };
            let (raw, updated) = patch("description", next)?;
            printer.emit(&raw, || {
                format!(
                    "✓ {} → {}",
                    updated.key,
                    updated.description.as_deref().unwrap_or("(설명 없음)")
                )
            });
            Ok(())
        }
        "repo" => {
            // 인자를 주면 그 값, 없으면 cwd 의 git remote 에서 유추한다.
            let inferred = crate::context::git(&["remote", "get-url", "origin"])
                .and_then(|url| parse_repo_from_remote(&url));
            let repo = arg.map(str::to_string).or(inferred);
            let repo = repo.filter(|r| is_repo_slug(r)).ok_or_else(|| {
                "GitHub 레포를 알 수 없다 — OWNER/NAME 을 직접 준다: rocky-todo board repo OWNER/NAME".to_string()
            })?;
            let (raw, updated) = patch("repo", json!(repo))?;
            printer.emit(&raw, || {
                format!(
                    "✓ {} → {}",
                    updated.key,
                    updated.repo.as_deref().unwrap_or("")
                )
            });
            Ok(())
        }
        "path" => {
            // 인자를 주면 그 값, 없으면 지금 있는 자리 — 보통 레포 안에서 부른다.
            let target = match arg {
                Some(value) => value.to_string(),
                None => std::env::current_dir()
                    .map_err(|e| format!("cwd 를 알 수 없다: {e}"))?
                    .to_string_lossy()
                    .to_string(),
            };
            let (raw, updated) = patch("path", json!(target))?;
            printer.emit(&raw, || {
                format!(
                    "✓ {} → {}",
                    updated.key,
                    updated.path.as_deref().unwrap_or("")
                )
            });
            Ok(())
        }
        _ => Err(USAGE.into()),
    }
}

/// `history REF [--limit N] [--global|--note]`.
pub fn cmd_history(
    ctx: &CliContext,
    rest: &[String],
    flags: &ParsedFlags,
    board: &str,
    printer: &Printer,
) -> Result<(), String> {
    let Some(id) = rest.first() else {
        return Err("usage: rocky-todo history REF [--limit N] [--global|--note]".into());
    };
    let limit = flags.str_flag("limit").unwrap_or("20");
    // prefix 로 들어와도 detail 조회로 전체 id 를 확정한 뒤 히스토리를 가져온다.
    let detail = resolve_history_entity(
        ctx,
        id,
        board,
        flags.bool_flag("global"),
        flags.bool_flag("note"),
    )?;
    let entity_id = detail
        .get("todo")
        .or_else(|| detail.get("note"))
        .and_then(|e| e.get("id"))
        .and_then(|v| v.as_str())
        .unwrap_or(id)
        .to_string();

    let raw = request_value(
        ctx,
        "GET",
        &format!(
            "/api/history?entityId={}&limit={}",
            encode_uri_component(&entity_id),
            encode_uri_component(limit)
        ),
        None,
    )?;
    let history: Vec<Value> = serde_json::from_value(raw.clone()).unwrap_or_default();
    printer.emit(&raw, || {
        history
            .iter()
            .map(|h| {
                let at = h.get("at").and_then(|v| v.as_str()).unwrap_or("");
                let actor = h.get("actor").and_then(|v| v.as_str()).unwrap_or("");
                let action = h.get("action").and_then(|v| v.as_str()).unwrap_or("");
                // changes 는 있을 때만, 서버가 준 JSON 을 그대로 붙인다.
                let changes = h
                    .get("changes")
                    .filter(|v| !v.is_null())
                    .map(|v| format!(" {}", serde_json::to_string(v).unwrap_or_default()))
                    .unwrap_or_default();
                format!(
                    "{} {actor} {action}{changes}",
                    at.chars().take(16).collect::<String>()
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    });
    Ok(())
}

/// todo 인지 note 인지 모르는 REF 를 상세 조회로 확정한다.
///
/// `--global`/`--note` 가 서면 note 로 확정한다. 아니면 todo 를 먼저 시도하고 실패하면
/// note 로 떨어진다 — 같은 보드에 todo #1 과 note #1 이 동시에 존재할 수 있어(번호 공간이
/// 독립) todo 가 먼저 성공하면 note 히스토리에 닿을 길이 없기 때문이다.
fn resolve_history_entity(
    ctx: &CliContext,
    id: &str,
    board: &str,
    global: bool,
    note: bool,
) -> Result<Value, String> {
    if global || note {
        return request_value(ctx, "GET", &note_ref_path(id, "", board, global), None);
    }
    match request_value(ctx, "GET", &todo_ref_path(id, "", board), None) {
        Ok(value) => Ok(value),
        Err(_) => request_value(ctx, "GET", &note_ref_path(id, "", board, false), None),
    }
}

/// `next` — 착수 후보 랭킹.
pub fn cmd_next(
    ctx: &CliContext,
    flags: &ParsedFlags,
    board: &str,
    printer: &Printer,
) -> Result<(), String> {
    use rocky_todo_core::next::{
        format_next_candidates, rank_next, to_json_candidates, RankNextOptions, NEXT_DEFAULT_LIMIT,
    };

    let all_view = flags.bool_flag("all") && flags.str_flag("board").is_none();
    let qs = if all_view {
        String::new()
    } else {
        format!("?board={}", encode_uri_component(board))
    };
    // `ls` 와 같은 라우트다 — 서버가 doing 항목에 `doingState` 를 얹어 주므로 "주인 없는
    // 진행중" 판정을 클라이언트에서 다시 하지 않는다.
    let todos: Vec<TodoView> = request(ctx, "GET", &format!("/api/todos{qs}"), None)?;
    // 파싱 실패는 기본값으로 떨어진다 — TS 의 `Number.isNaN` 분기와 같다.
    let limit = flags
        .str_flag("limit")
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(NEXT_DEFAULT_LIMIT);
    let candidates = rank_next(
        &todos,
        &RankNextOptions {
            now: now_ms(),
            limit: Some(limit),
        },
    );

    if printer.json {
        // JSON 은 컴팩트 형태로만 낸다 — 소비자가 모델이라 payload 가 곧 응답 지연이다.
        // 보드 목록은 ref 를 board key 로 되돌리기 위한 것.
        let boards: Vec<Board> = request(ctx, "GET", "/api/boards", None)?;
        let key_by_id: std::collections::HashMap<&str, &str> = boards
            .iter()
            .map(|b| (b.id.as_str(), b.key.as_str()))
            .collect();
        let json = json!({
            "board": if all_view { Value::Null } else { json!(board) },
            "candidates": to_json_candidates(&candidates, |id| key_by_id.get(id).map(|k| k.to_string())),
        });
        println!(
            "{}",
            serde_json::to_string_pretty(&json).unwrap_or_default()
        );
        return Ok(());
    }
    println!("{}", format_next_candidates(&candidates));
    Ok(())
}
