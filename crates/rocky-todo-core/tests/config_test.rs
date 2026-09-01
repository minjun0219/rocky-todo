//! TS `src/config.test.ts` + `src/rocky-config.test.ts` 포팅.

use rocky_todo_core::config::*;
use rocky_todo_core::statusline::DEFAULT_STATUSLINE_TEMPLATE;

fn env(pairs: &[(&str, &str)]) -> EnvMap {
    pairs
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

#[test]
fn defaults_when_nothing_is_set() {
    let runtime = resolve_runtime_config(&env(&[]), &TodoConfig::default());
    assert_eq!(runtime.port, 8636);
    assert_eq!(runtime.host, "127.0.0.1");
    assert!(runtime.expose.is_empty());
    assert!(runtime
        .dir
        .to_string_lossy()
        .ends_with(".config/rocky/todo"));
}

#[test]
fn todo_block_overrides_defaults() {
    let todo = TodoConfig {
        port: Some(9000),
        dir: Some("/data/todo".into()),
        ..Default::default()
    };
    let runtime = resolve_runtime_config(&env(&[]), &todo);
    assert_eq!(runtime.port, 9000);
    assert_eq!(runtime.dir.to_string_lossy(), "/data/todo");
}

#[test]
fn env_wins_and_tilde_expands() {
    let todo = TodoConfig {
        port: Some(9000),
        dir: Some("/data/todo".into()),
        ..Default::default()
    };
    let runtime = resolve_runtime_config(
        &env(&[
            ("ROCKY_TODO_PORT", "9100"),
            ("ROCKY_TODO_DIR", "~/todo-dir"),
        ]),
        &todo,
    );
    assert_eq!(runtime.port, 9100);
    assert!(runtime.dir.is_absolute());
    assert!(runtime.dir.to_string_lossy().ends_with("todo-dir"));
    assert!(!runtime.dir.to_string_lossy().contains('~'));
}

#[test]
fn invalid_env_port_falls_through() {
    let todo = TodoConfig {
        port: Some(9000),
        ..Default::default()
    };
    let runtime = resolve_runtime_config(&env(&[("ROCKY_TODO_PORT", "abc")]), &todo);
    assert_eq!(runtime.port, 9000);
    let runtime = resolve_runtime_config(&env(&[("ROCKY_TODO_PORT", "0")]), &TodoConfig::default());
    assert_eq!(runtime.port, 8636);
}

#[test]
fn expose_defaults_to_loopback() {
    let runtime = resolve_runtime_config(&env(&[]), &TodoConfig::default());
    assert!(runtime.expose.is_empty());
    assert_eq!(runtime.host, "127.0.0.1");
}

#[test]
fn lan_binds_all_tailscale_keeps_loopback_both_combine() {
    let lan = TodoConfig {
        expose: Some(ExposeValue::Channels(vec![ExposeChannel::Lan])),
        ..Default::default()
    };
    assert_eq!(resolve_runtime_config(&env(&[]), &lan).host, "0.0.0.0");

    let ts = TodoConfig {
        expose: Some(ExposeValue::Channels(vec![ExposeChannel::TailscaleServe])),
        ..Default::default()
    };
    let runtime = resolve_runtime_config(&env(&[]), &ts);
    assert_eq!(runtime.host, "127.0.0.1");
    assert_eq!(runtime.expose, vec![ExposeChannel::TailscaleServe]);

    let both = TodoConfig {
        expose: Some(ExposeValue::Channels(vec![
            ExposeChannel::Lan,
            ExposeChannel::TailscaleServe,
        ])),
        ..Default::default()
    };
    let runtime = resolve_runtime_config(&env(&[]), &both);
    assert_eq!(runtime.host, "0.0.0.0");
    assert_eq!(runtime.expose.len(), 2);
}

#[test]
fn env_expose_is_comma_separated_and_wins_entirely() {
    let config_on = TodoConfig {
        expose: Some(ExposeValue::Channels(vec![ExposeChannel::Lan])),
        ..Default::default()
    };
    // env "off"(유효 채널 없음)로 config 를 통째로 덮어 강제 차단
    let runtime = resolve_runtime_config(&env(&[("ROCKY_TODO_EXPOSE", "off")]), &config_on);
    assert!(runtime.expose.is_empty());
    assert_eq!(runtime.host, "127.0.0.1");

    let runtime = resolve_runtime_config(
        &env(&[("ROCKY_TODO_EXPOSE", "lan, tailscale-serve")]),
        &TodoConfig::default(),
    );
    assert_eq!(runtime.expose.len(), 2);
    assert_eq!(runtime.host, "0.0.0.0");
}

#[test]
fn statusline_template_default() {
    let runtime = resolve_runtime_config(&env(&[]), &TodoConfig::default());
    assert_eq!(runtime.statusline_template, DEFAULT_STATUSLINE_TEMPLATE);
}

#[test]
fn statusline_template_config_over_default() {
    let todo = TodoConfig {
        statusline_template: Some("[{doing}]".into()),
        ..Default::default()
    };
    assert_eq!(
        resolve_runtime_config(&env(&[]), &todo).statusline_template,
        "[{doing}]"
    );
}

#[test]
fn statusline_template_env_over_config() {
    let todo = TodoConfig {
        statusline_template: Some("[{doing}]".into()),
        ..Default::default()
    };
    let runtime = resolve_runtime_config(&env(&[("ROCKY_TODO_STATUSLINE", "[{stale}]")]), &todo);
    assert_eq!(runtime.statusline_template, "[{stale}]");
}

#[test]
fn blank_statusline_template_falls_back_to_default() {
    let todo = TodoConfig {
        statusline_template: Some("   ".into()),
        ..Default::default()
    };
    let runtime = resolve_runtime_config(&env(&[("ROCKY_TODO_STATUSLINE", "  ")]), &todo);
    assert_eq!(runtime.statusline_template, DEFAULT_STATUSLINE_TEMPLATE);
}

// ── load_todo_config (rocky-config.test.ts) ──

fn write_config(content: &str) -> (tempfile::TempDir, std::path::PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("rocky.json");
    std::fs::write(&path, content).unwrap();
    (dir, path)
}

#[test]
fn missing_file_is_fail_open() {
    let config = load_todo_config(std::path::Path::new("/no/such/rocky.json"));
    assert!(config.port.is_none());
}

#[test]
fn unparsable_json_is_fail_open() {
    let (_dir, path) = write_config("not json");
    let config = load_todo_config(&path);
    assert!(config.port.is_none());
}

#[test]
fn non_object_top_level_is_fail_open() {
    let (_dir, path) = write_config("[1,2,3]");
    assert!(load_todo_config(&path).port.is_none());
}

#[test]
fn missing_todo_block_is_fail_open() {
    let (_dir, path) = write_config(r#"{"openapi":{}}"#);
    assert!(load_todo_config(&path).port.is_none());
}

#[test]
fn non_object_todo_is_fail_open() {
    let (_dir, path) = write_config(r#"{"todo":"yes"}"#);
    assert!(load_todo_config(&path).port.is_none());
}

#[test]
fn reads_port_dir_expose_watch() {
    let (_dir, path) =
        write_config(r#"{"todo":{"port":9000,"dir":"/data","expose":["lan"],"watch":false}}"#);
    let config = load_todo_config(&path);
    assert_eq!(config.port, Some(9000));
    assert_eq!(config.dir.as_deref(), Some("/data"));
    assert!(
        matches!(config.expose, Some(ExposeValue::Channels(ref c)) if c == &vec![ExposeChannel::Lan])
    );
    assert_eq!(config.watch, Some(false));
}

#[test]
fn expose_string_and_off_forms() {
    let (_dir, path) = write_config(r#"{"todo":{"expose":"lan"}}"#);
    assert!(matches!(
        load_todo_config(&path).expose,
        Some(ExposeValue::Channels(ref c)) if c == &vec![ExposeChannel::Lan]
    ));
    let (_dir2, path2) = write_config(r#"{"todo":{"expose":"off"}}"#);
    assert!(matches!(
        load_todo_config(&path2).expose,
        Some(ExposeValue::Off)
    ));
    let (_dir3, path3) = write_config(r#"{"todo":{"expose":null}}"#);
    assert!(matches!(
        load_todo_config(&path3).expose,
        Some(ExposeValue::Off)
    ));
}

#[test]
fn wrong_typed_fields_are_dropped() {
    let (_dir, path) = write_config(r#"{"todo":{"port":"9000","dir":123}}"#);
    let config = load_todo_config(&path);
    assert!(config.port.is_none());
    assert!(config.dir.is_none());
}

#[test]
fn reads_statusline_template() {
    let (_dir, path) = write_config(r#"{"todo":{"statusline":{"template":"[{doing}]"}}}"#);
    assert_eq!(
        load_todo_config(&path).statusline_template.as_deref(),
        Some("[{doing}]")
    );
}

#[test]
fn malformed_statusline_is_ignored() {
    let (_dir, path) = write_config(r#"{"todo":{"statusline":"template"}}"#);
    assert!(load_todo_config(&path).statusline_template.is_none());
    let (_dir2, path2) = write_config(r#"{"todo":{"statusline":{"template":123}}}"#);
    assert!(load_todo_config(&path2).statusline_template.is_none());
}
