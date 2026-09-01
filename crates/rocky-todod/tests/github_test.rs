//! TS `src/github.test.ts` 포팅.

use std::sync::{Arc, Mutex};

use rocky_todo_core::store::TodoStore;
use rocky_todo_core::types::*;
use rocky_todod::github::*;
use rocky_todod::runner::{CmdOutput, Runner};

/// gh 를 부르지 않고 끼우는 fake — 호출 인자도 기록한다.
type Calls = Arc<Mutex<Vec<(Vec<String>, String)>>>;

struct FakeRun {
    calls: Calls,
    runner: Runner,
}

fn fake_run(code: i32, stdout: &str, stderr: &str) -> FakeRun {
    let calls: Calls = Arc::new(Mutex::new(Vec::new()));
    let (stdout, stderr) = (stdout.to_string(), stderr.to_string());
    let sink = calls.clone();
    let runner: Runner = Arc::new(move |cmd, stdin, _timeout| {
        sink.lock().unwrap().push((cmd, stdin));
        let output = CmdOutput {
            code,
            stdout: stdout.clone(),
            stderr: stderr.clone(),
        };
        Box::pin(async move { output })
    });
    FakeRun { calls, runner }
}

#[test]
fn parse_repo_reads_ssh_form() {
    assert_eq!(
        parse_repo_from_remote("git@github.com:minjun0219/rocky.git").as_deref(),
        Some("minjun0219/rocky")
    );
    assert_eq!(
        parse_repo_from_remote("git@github.com:o/n").as_deref(),
        Some("o/n")
    );
}

#[test]
fn parse_repo_reads_https_form() {
    assert_eq!(
        parse_repo_from_remote("https://github.com/o/n.git").as_deref(),
        Some("o/n")
    );
    assert_eq!(
        parse_repo_from_remote("https://github.com/o/n").as_deref(),
        Some("o/n")
    );
}

#[test]
fn parse_repo_reads_ssh_scheme_and_trailing_slash() {
    assert_eq!(
        parse_repo_from_remote("ssh://git@github.com/o/n.git").as_deref(),
        Some("o/n")
    );
    assert_eq!(
        parse_repo_from_remote("https://github.com/o/n/").as_deref(),
        Some("o/n")
    );
}

#[test]
fn parse_repo_rejects_non_github_and_junk() {
    assert_eq!(parse_repo_from_remote("git@gitlab.com:o/n.git"), None);
    assert_eq!(parse_repo_from_remote("https://example.com/o/n"), None);
    assert_eq!(parse_repo_from_remote(""), None);
    assert_eq!(parse_repo_from_remote("   "), None);
}

#[test]
fn parse_repo_rejects_lookalike_host() {
    assert_eq!(
        parse_repo_from_remote("https://evil.com/github.com/o/n"),
        None
    );
    assert_eq!(
        parse_repo_from_remote("https://github.com.evil.com/o/n"),
        None
    );
}

#[test]
fn parse_repo_scp_like_with_and_without_user() {
    assert_eq!(
        parse_repo_from_remote("github.com:o/n").as_deref(),
        Some("o/n")
    );
    assert_eq!(
        parse_repo_from_remote("user@github.com:o/n.git").as_deref(),
        Some("o/n")
    );
}

#[test]
fn parse_repo_malformed_does_not_panic() {
    assert_eq!(parse_repo_from_remote("github.com:"), None);
    assert_eq!(parse_repo_from_remote("a@b@github.com:o/n"), None);
}

#[test]
fn repo_slug_accepts_owner_name() {
    assert!(is_repo_slug("o/n"));
    assert!(is_repo_slug("minjun0219/rocky-todo"));
    assert!(is_repo_slug("  o/n  ")); // trim
}

#[test]
fn repo_slug_rejects_everything_else() {
    assert!(!is_repo_slug("o"));
    assert!(!is_repo_slug("o/n/x"));
    assert!(!is_repo_slug("o n/x"));
    assert!(!is_repo_slug(""));
}

#[test]
fn finds_issue_link_among_links() {
    let links = vec![
        TodoLink {
            url: "https://example.com/x".into(),
            title: None,
        },
        TodoLink {
            url: "https://github.com/o/n/issues/12".into(),
            title: None,
        },
    ];
    assert_eq!(
        find_issue_link(&links),
        Some("https://github.com/o/n/issues/12")
    );
}

#[test]
fn pull_request_url_is_not_issue_link() {
    let links = vec![TodoLink {
        url: "https://github.com/o/n/pull/12".into(),
        title: None,
    }];
    assert_eq!(find_issue_link(&links), None);
}

#[test]
fn no_links_means_none() {
    assert_eq!(find_issue_link(&[]), None);
}

#[test]
fn issue_number_must_end_at_boundary() {
    let bad = vec![TodoLink {
        url: "https://github.com/o/n/issues/12abc".into(),
        title: None,
    }];
    assert_eq!(find_issue_link(&bad), None);
    let slash = vec![TodoLink {
        url: "https://github.com/o/n/issues/12/".into(),
        title: None,
    }];
    assert_eq!(
        find_issue_link(&slash),
        Some("https://github.com/o/n/issues/12/")
    );
    let hash = vec![TodoLink {
        url: "https://github.com/o/n/issues/12#comment".into(),
        title: None,
    }];
    assert_eq!(
        find_issue_link(&hash),
        Some("https://github.com/o/n/issues/12#comment")
    );
}

#[test]
fn issue_number_from_reads_trailing_number() {
    assert_eq!(
        issue_number_from("https://github.com/o/n/issues/12"),
        Some(12)
    );
    assert_eq!(
        issue_number_from("https://github.com/o/n/issues/12\n"),
        Some(12)
    );
    assert_eq!(issue_number_from("https://github.com/o/n/issues/"), None);
    assert_eq!(issue_number_from("nonsense"), None);
}

#[test]
fn issue_body_appends_back_reference() {
    assert_eq!(
        issue_body("설명이다", "rocky-todo#8"),
        "설명이다\n\n— rocky-todo `rocky-todo#8`"
    );
    assert_eq!(
        issue_body("", "rocky-todo#8"),
        "— rocky-todo `rocky-todo#8`"
    );
}

#[tokio::test]
async fn create_issue_passes_body_on_stdin_and_returns_url() {
    let fake = fake_run(0, "https://github.com/o/n/issues/7\n", "");
    let result = create_issue("o/n", "제목", "본문", &fake.runner).await;
    match result {
        CreateIssueOutcome::Ok { url } => assert_eq!(url, "https://github.com/o/n/issues/7"),
        CreateIssueOutcome::Failed { message } => panic!("{message}"),
    }
    let calls = fake.calls.lock().unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(
        calls[0].0,
        vec!["gh", "issue", "create", "-R", "o/n", "-t", "제목", "-F", "-"]
    );
    assert_eq!(calls[0].1, "본문");
}

#[tokio::test]
async fn missing_gh_is_reported_actionably() {
    // tokio 러너는 spawn 실패를 stderr 로 접는다 — ENOENT 문구로 판별한다.
    let missing: Runner = Arc::new(|_c, _s, _t| {
        Box::pin(async { CmdOutput::failure("No such file or directory (os error 2)") })
    });
    let result = create_issue("o/n", "t", "b", &missing).await;
    let CreateIssueOutcome::Failed { message } = result else {
        panic!("must fail")
    };
    assert!(message.contains("gh"));
    assert!(message.contains("cli.github.com"));
}

#[tokio::test]
async fn auth_failures_get_login_hint() {
    for stderr in [
        "gh auth login required",
        "authentication required",
        "HTTP 401: Unauthorized (https://api.github.com/graphql)",
        "error: Bad credentials",
        "To get started with GitHub CLI, please run: gh auth login",
        "error: not logged in to any GitHub hosts",
    ] {
        let fake = fake_run(1, "", stderr);
        let CreateIssueOutcome::Failed { message } =
            create_issue("o/n", "t", "b", &fake.runner).await
        else {
            panic!("must fail")
        };
        assert!(message.contains("gh auth login"), "{stderr} → {message}");
    }
}

#[tokio::test]
async fn author_words_are_not_auth_failures() {
    for stderr in [
        "Author field required",
        "could not assign author: not a collaborator",
        "authored by someone else",
    ] {
        let fake = fake_run(1, "", stderr);
        let CreateIssueOutcome::Failed { message } =
            create_issue("o/n", "t", "b", &fake.runner).await
        else {
            panic!("must fail")
        };
        assert!(!message.contains("gh auth login"), "{stderr} → {message}");
    }
}

#[tokio::test]
async fn other_failures_surface_verbatim() {
    let fake = fake_run(1, "", "could not resolve to a Repository");
    let CreateIssueOutcome::Failed { message } = create_issue("o/n", "t", "b", &fake.runner).await
    else {
        panic!("must fail")
    };
    assert!(message.contains("could not resolve to a Repository"));
}

#[tokio::test]
async fn zero_exit_without_url_is_failure() {
    let fake = fake_run(0, "\n", "");
    let CreateIssueOutcome::Failed { message } = create_issue("o/n", "t", "b", &fake.runner).await
    else {
        panic!("must fail")
    };
    assert!(message.contains("URL"));
}

#[tokio::test]
async fn finds_url_despite_trailing_warning() {
    let fake = fake_run(
        0,
        "https://github.com/o/n/issues/9\nwarning: something noisy\n",
        "",
    );
    match create_issue("o/n", "t", "b", &fake.runner).await {
        CreateIssueOutcome::Ok { url } => assert_eq!(url, "https://github.com/o/n/issues/9"),
        CreateIssueOutcome::Failed { message } => panic!("{message}"),
    }
}

// ── createIssueForTodo ──

struct Gh {
    _dir: tempfile::TempDir,
    store: Arc<TodoStore>,
}

fn gh_fx() -> Gh {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(TodoStore::open(&dir.path().join("todo.db")).unwrap());
    Gh { _dir: dir, store }
}

fn seed_todo(store: &TodoStore, board: &str, repo: Option<&str>) -> Todo {
    store.ensure_board(board, None, "logan").unwrap();
    if let Some(repo) = repo {
        store.set_board_repo(board, repo, "logan").unwrap();
    }
    store
        .create_todo(
            &CreateTodoInput {
                board: board.into(),
                title: "작업".into(),
                description: Some("설명".into()),
                ..Default::default()
            },
            "logan",
        )
        .unwrap()
}

async fn issue_for(
    store: &TodoStore,
    todo_ref: &str,
    repo: Option<&str>,
    runner: &Runner,
) -> Result<(String, Todo), IssueForTodoError> {
    create_issue_for_todo(
        store,
        todo_ref,
        IssueForTodoOptions {
            actor: "claude-code",
            current_board_id: None,
            repo,
        },
        runner,
    )
    .await
}

#[tokio::test]
async fn creates_issue_and_appends_link() {
    let f = gh_fx();
    let todo = seed_todo(&f.store, "rocky", Some("o/n"));
    let fake = fake_run(0, "https://github.com/o/n/issues/7\n", "");
    let (url, updated) = issue_for(&f.store, &todo.id, None, &fake.runner)
        .await
        .ok()
        .unwrap();
    assert_eq!(url, "https://github.com/o/n/issues/7");
    assert_eq!(updated.links[0].url, "https://github.com/o/n/issues/7");
    assert_eq!(updated.links[0].title.as_deref(), Some("#7"));
    // 이슈 본문에 보드 참조가 실린다
    let calls = fake.calls.lock().unwrap();
    assert!(calls[0].1.contains("rocky-1"));
}

#[tokio::test]
async fn legacy_space_board_key_falls_back_to_raw_id_in_body() {
    let f = gh_fx();
    // 레거시 malformed key 보드를 raw SQL 로 심는다.
    {
        let raw = rusqlite_open(&f);
        raw.execute(
            "INSERT INTO boards (id, key, title, repo, created_at) VALUES ('b1', 'my repo', 'my repo', 'o/n', '2026-07-01T00:00:00.000Z')",
            [],
        )
        .unwrap();
        raw.execute(
            "INSERT INTO todos (id, number, board_id, title, description, status, priority, labels, links, position, created_at, updated_at)
             VALUES ('aaaa1111', 1, 'b1', '작업', '', 'todo', 'p4', '[]', '[]', 1, '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')",
            [],
        )
        .unwrap();
    }
    let fake = fake_run(0, "https://github.com/o/n/issues/7\n", "");
    let result = issue_for(&f.store, "aaaa1111", None, &fake.runner).await;
    assert!(result.is_ok());
    let calls = fake.calls.lock().unwrap();
    assert!(calls[0].1.contains("aaaa1111"), "{}", calls[0].1);
}

fn rusqlite_open(f: &Gh) -> rusqlite::Connection {
    rusqlite::Connection::open(f._dir.path().join("todo.db")).unwrap()
}

#[tokio::test]
async fn refuses_without_board_repo() {
    let f = gh_fx();
    let todo = seed_todo(&f.store, "rocky", None);
    let fake = fake_run(0, "https://github.com/o/n/issues/7\n", "");
    let Err(IssueForTodoError::Other(error)) =
        issue_for(&f.store, &todo.id, None, &fake.runner).await
    else {
        panic!("must fail")
    };
    assert!(error.to_string().contains("no GitHub repo"));
    assert!(fake.calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn refuses_when_issue_link_exists() {
    let f = gh_fx();
    let todo = seed_todo(&f.store, "rocky", Some("o/n"));
    f.store
        .update_todo(
            &todo.id,
            &UpdateTodoPatch {
                links: Some(vec![TodoLink {
                    url: "https://github.com/o/n/issues/3".into(),
                    title: None,
                }]),
                ..Default::default()
            },
            "logan",
            None,
        )
        .unwrap();
    let fake = fake_run(0, "https://github.com/o/n/issues/7\n", "");
    let Err(IssueForTodoError::AlreadyExists(error)) =
        issue_for(&f.store, &todo.id, None, &fake.runner).await
    else {
        panic!("must be AlreadyExists")
    };
    assert_eq!(error.url, "https://github.com/o/n/issues/3");
}

#[tokio::test]
async fn gh_failure_leaves_todo_untouched() {
    let f = gh_fx();
    let todo = seed_todo(&f.store, "rocky", Some("o/n"));
    let fake = fake_run(1, "", "boom");
    assert!(issue_for(&f.store, &todo.id, None, &fake.runner)
        .await
        .is_err());
    assert!(f
        .store
        .get_todo(&todo.id, None)
        .unwrap()
        .unwrap()
        .links
        .is_empty());
}

#[tokio::test]
async fn unknown_todo_is_not_found() {
    let f = gh_fx();
    let fake = fake_run(0, "https://github.com/o/n/issues/7\n", "");
    let Err(IssueForTodoError::Other(error)) =
        issue_for(&f.store, "nosuchid", None, &fake.runner).await
    else {
        panic!("must fail")
    };
    assert!(error.to_string().contains("todo not found"));
}

#[tokio::test]
async fn options_repo_fills_repo_less_board_on_success() {
    let f = gh_fx();
    let todo = seed_todo(&f.store, "rocky", None);
    let fake = fake_run(0, "https://github.com/o/n/issues/7\n", "");
    assert!(issue_for(&f.store, &todo.id, Some("o/n"), &fake.runner)
        .await
        .is_ok());
    assert_eq!(
        f.store.get_board("rocky").unwrap().unwrap().repo.as_deref(),
        Some("o/n")
    );
}

#[tokio::test]
async fn options_repo_never_persisted_when_gh_fails() {
    let f = gh_fx();
    let todo = seed_todo(&f.store, "rocky", None);
    let fake = fake_run(1, "", "boom");
    assert!(issue_for(&f.store, &todo.id, Some("o/n"), &fake.runner)
        .await
        .is_err());
    assert_eq!(f.store.get_board("rocky").unwrap().unwrap().repo, None);
}

#[tokio::test]
async fn options_repo_overrides_board_repo_and_persists_on_success() {
    let f = gh_fx();
    let todo = seed_todo(&f.store, "rocky", Some("old/repo"));
    let fake = fake_run(0, "https://github.com/o/n/issues/7\n", "");
    assert!(
        issue_for(&f.store, &todo.id, Some("new/repo"), &fake.runner)
            .await
            .is_ok()
    );
    let calls = fake.calls.lock().unwrap();
    assert!(calls[0].0.contains(&"new/repo".to_string()));
    assert_eq!(
        f.store.get_board("rocky").unwrap().unwrap().repo.as_deref(),
        Some("new/repo")
    );
}
