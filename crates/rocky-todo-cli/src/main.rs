//! `rocky-todo` 진입점.

use rocky_todo_cli::commands::{self, Printer};
use rocky_todo_cli::context::{build_cli_context, infer_board_key};
use rocky_todo_cli::flags::parse_flags;
use rocky_todo_cli::HELP;

fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    if let Err(error) = run(&argv) {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn run(argv: &[String]) -> Result<(), String> {
    let parsed = parse_flags(argv)?;
    let command = parsed.positionals.first().map(String::as_str).unwrap_or("");
    let rest: Vec<String> = parsed.positionals.iter().skip(1).cloned().collect();

    // `help` 와 인자 없음은 데몬을 건드리지 않는다 — 도움말 보려다 데몬이 뜨면 곤란하다.
    if command.is_empty() || command == "help" || parsed.bool_flag("help") {
        println!("{HELP}");
        return Ok(());
    }

    let (ctx, _runtime) = build_cli_context(parsed.str_flag("actor"));
    let board = parsed
        .str_flag("board")
        .map(str::to_string)
        .unwrap_or_else(infer_board_key);
    let printer = Printer {
        json: parsed.bool_flag("json"),
    };

    match command {
        "ls" => commands::cmd_ls(&ctx, &parsed, &board, &printer),
        "add" => commands::cmd_add(&ctx, &rest, &parsed, &board, &printer),
        "show" => commands::cmd_show(&ctx, &rest, &board, &printer),
        "update" => commands::cmd_update(&ctx, &rest, &parsed, &board, &printer),
        "comment" => commands::cmd_comment(&ctx, &rest, &board, &printer),
        "move" => commands::cmd_move(&ctx, &rest, &parsed, &board, &printer),
        "sessions" => commands::cmd_sessions(&ctx, &board, &printer),
        "spawn" => commands::cmd_spawn(&ctx, &rest, &parsed, &board, &printer),
        "section" => commands::cmd_section(&ctx, &rest, &board, &printer),
        "handoff" => commands::cmd_handoff(&ctx, &rest, &parsed, &board, &printer),
        "board" => commands::cmd_board(&ctx, &rest, &board, &printer),
        "history" => commands::cmd_history(&ctx, &rest, &parsed, &board, &printer),
        "next" => commands::cmd_next(&ctx, &parsed, &board, &printer),
        "note" => commands::cmd_note(&ctx, &rest, &parsed, &board, &printer),
        "start" | "stop" | "done" | "reopen" | "archive" | "unarchive" => {
            commands::cmd_status(&ctx, command, &rest, &board, &printer)
        }
        // 아직 안 옮긴 것들은 조용히 성공하지 않는다 — 없는 기능을 있는 척하면
        // 스크립트가 실패를 못 알아챈다.
        "issue" | "open" | "daemon" | "mcp" | "tailscale" => Err(format!(
            "`{command}` 는 아직 Rust CLI 로 안 옮겼다 (Phase 3 진행 중) — 그동안은 bun 판을 쓴다"
        )),
        // 문구를 한국어로 바꾸지 않는다 — TS 판과 같은 문자열이어야 parity 게이트가
        // 의미를 갖고, 이미 이 메시지를 잡는 스크립트가 있을 수 있다.
        other => Err(format!("unknown command: {other}\n\n{HELP}")),
    }
}
