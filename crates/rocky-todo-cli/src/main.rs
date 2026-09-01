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

    let (ctx, runtime, todo_config) = build_cli_context(parsed.str_flag("actor"));
    let expose_lan = runtime
        .expose
        .contains(&rocky_todo_core::config::ExposeChannel::Lan);
    let expose_ts = runtime
        .expose
        .contains(&rocky_todo_core::config::ExposeChannel::TailscaleServe);
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
        "issue" => commands::cmd_issue(&ctx, &rest, &parsed, &board, &printer),
        "open" => commands::cmd_open(&ctx, expose_lan, expose_ts),
        "daemon" => commands::cmd_daemon(&ctx, &rest, expose_lan, expose_ts),
        "mcp" => commands::cmd_mcp(&ctx, &rest),
        "tailscale" => commands::cmd_tailscale(&ctx, &rest),
        // 훅 엔트리 — hooks.json 이 부른다. 셋 다 fail-open 이라 항상 Ok.
        "hook" => {
            use rocky_todo_cli::hooks;
            match rest.first().map(String::as_str) {
                Some("ensure-daemon") => hooks::hook_ensure_daemon(&ctx),
                Some("notify-todo") => hooks::hook_notify_todo(&ctx, todo_config.watch),
                Some("handoff-stop") => hooks::hook_handoff_stop(&ctx),
                _ => {
                    return Err(
                        "usage: rocky-todo hook ensure-daemon|notify-todo|handoff-stop".into(),
                    )
                }
            }
            Ok(())
        }
        "start" | "stop" | "done" | "reopen" | "archive" | "unarchive" => {
            commands::cmd_status(&ctx, command, &rest, &board, &printer)
        }
        // 문구를 한국어로 바꾸지 않는다 — TS 판과 같은 문자열이어야 parity 게이트가
        // 의미를 갖고, 이미 이 메시지를 잡는 스크립트가 있을 수 있다.
        other => Err(format!("unknown command: {other}\n\n{HELP}")),
    }
}
