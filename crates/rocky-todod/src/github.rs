//! GitHub 연동 — todo 를 이슈로 올리는 경로의 단일 소유자. TS 원본 `src/github.ts`.
//!
//! 토큰을 저장하지 않는다 — `gh` CLI 를 실행해 사용자의 인증을 그대로 빌린다.

use std::time::Duration;

use rocky_todo_core::store::{StoreError, StoreResult, TodoStore};
use rocky_todo_core::types::{Todo, TodoLink};
// slug 판별·remote 파싱은 순수 문자열 처리라 코어에 있다 — CLI 도 같은 함수를 쓴다.
pub use rocky_todo_core::github::{is_repo_slug, parse_repo_from_remote};

use crate::runner::{CmdOutput, Runner};

const GH_TIMEOUT: Duration = Duration::from_secs(30);

/// `owner/name` — GitHub 의 소유자·레포 이름이 허용하는 문자만.
/// links 중 GitHub **이슈** URL — PR URL(`/pull/<n>`)은 이슈가 아니다.
pub fn find_issue_link(links: &[TodoLink]) -> Option<&str> {
    links
        .iter()
        .map(|l| l.url.as_str())
        .find(|url| is_issue_url(url))
}

fn is_issue_url(url: &str) -> bool {
    // `^https://github\.com/[^/]+/[^/]+/issues/\d+([/?#]|$)`
    let Some(rest) = url.strip_prefix("https://github.com/") else {
        return false;
    };
    let mut parts = rest.splitn(4, '/');
    let (Some(owner), Some(name), Some(kind), tail) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return false;
    };
    if owner.is_empty() || name.is_empty() || kind != "issues" {
        return false;
    }
    let Some(tail) = tail else {
        return false;
    };
    let digits: String = tail.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return false;
    }
    let after = &tail[digits.len()..];
    after.is_empty() || after.starts_with('/') || after.starts_with('?') || after.starts_with('#')
}

/// 이슈 URL 끝의 번호 — 링크 제목(`#12`)용.
pub fn issue_number_from(url: &str) -> Option<i64> {
    let idx = url.trim().find("/issues/")?;
    let tail = &url.trim()[idx + "/issues/".len()..];
    let digits: String = tail.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().ok()
}

/// 이슈 본문 — 설명 뒤에 보드 참조 한 줄. 데몬은 루프백이라 클릭 URL 을 넣을 수 없다.
pub fn issue_body(description: &str, todo_ref: &str) -> String {
    let backlink = format!("— rocky-todo `{todo_ref}`");
    let body = description.trim();
    if body.is_empty() {
        backlink
    } else {
        format!("{body}\n\n{backlink}")
    }
}

/// 인증 실패로 보이는 `gh` 출력 — TS 원본의 정규식을 손으로 옮겼다.
/// `\bauth\b|\bauthn\b|\bauthz\b|authentic|authoriz|credential|\blogin\b|\blogged in\b`
fn looks_like_auth_failure(output: &str) -> bool {
    let lower = output.to_lowercase();
    let word_bounded = |word: &str| {
        lower.match_indices(word).any(|(at, _)| {
            let before_ok = at == 0 || !lower.as_bytes()[at - 1].is_ascii_alphanumeric();
            let after = at + word.len();
            let after_ok = after >= lower.len() || !lower.as_bytes()[after].is_ascii_alphanumeric();
            before_ok && after_ok
        })
    };
    word_bounded("auth")
        || word_bounded("authn")
        || word_bounded("authz")
        || lower.contains("authentic")
        || lower.contains("authoriz")
        || lower.contains("credential")
        || word_bounded("login")
        || word_bounded("logged in")
}

pub enum CreateIssueOutcome {
    Ok { url: String },
    Failed { message: String },
}

/// `gh` 로 이슈를 만든다 — 실패는 사람이 읽는 메시지로.
/// 본문은 argv 가 아니라 stdin(`-F -`)으로 넘긴다(길이 제한·이스케이프 회피).
pub async fn create_issue(
    repo: &str,
    title: &str,
    body: &str,
    runner: &Runner,
) -> CreateIssueOutcome {
    let result: CmdOutput = runner(
        vec![
            "gh".into(),
            "issue".into(),
            "create".into(),
            "-R".into(),
            repo.into(),
            "-t".into(),
            title.into(),
            "-F".into(),
            "-".into(),
        ],
        body.to_string(),
        GH_TIMEOUT,
    )
    .await;
    let output = format!("{}{}", result.stdout, result.stderr)
        .trim()
        .to_string();
    if !result.ok() {
        // 명령 자체를 못 찾은 경우 — TS 는 spawn throw 를 잡아 이 안내로 바꿨다.
        // tokio 러너는 spawn 실패를 stderr 로 접으므로 OS 의 ENOENT 문구로 판별한다.
        if result.stdout.is_empty() && output.contains("os error 2") {
            return CreateIssueOutcome::Failed {
                message: "gh CLI 를 찾을 수 없다 — 설치가 필요하다 (https://cli.github.com)".into(),
            };
        }
        if looks_like_auth_failure(&output) {
            return CreateIssueOutcome::Failed {
                message: format!("{output}\n(먼저: gh auth login)"),
            };
        }
        return CreateIssueOutcome::Failed {
            message: if output.is_empty() {
                "gh issue create 실패".to_string()
            } else {
                output
            },
        };
    }
    // 위치(마지막 줄)를 가정하지 않는다 — stdout 어디서든 이슈 URL 을 찾는다.
    match find_issue_url_in(&result.stdout) {
        Some(url) => CreateIssueOutcome::Ok { url },
        None => CreateIssueOutcome::Failed {
            message: format!(
                "gh 가 이슈 URL 을 돌려주지 않았다: {}",
                if output.is_empty() {
                    "(빈 출력)".to_string()
                } else {
                    output
                }
            ),
        },
    }
}

/// stdout 에서 `https://github.com/<o>/<n>/issues/<num>` 을 찾는다.
fn find_issue_url_in(stdout: &str) -> Option<String> {
    for (at, _) in stdout.match_indices("https://github.com/") {
        let candidate: String = stdout[at..]
            .chars()
            .take_while(|c| !c.is_whitespace())
            .collect();
        // 뒤에 붙은 비-URL 문자를 다듬으며 이슈 URL 인지 확인
        if let Some(issues_at) = candidate.find("/issues/") {
            let digits: String = candidate[issues_at + "/issues/".len()..]
                .chars()
                .take_while(|c| c.is_ascii_digit())
                .collect();
            if !digits.is_empty() {
                let end = issues_at + "/issues/".len() + digits.len();
                return Some(candidate[..end].to_string());
            }
        }
    }
    None
}

/// "이미 이슈가 있다" — 호출자가 **상태 코드로 구분**해야 하는 실패(409). 문구 매칭이
/// 아니라 타입으로 구분한다.
#[derive(Debug, thiserror::Error)]
#[error("todo already has a GitHub issue: {url}")]
pub struct IssueAlreadyExistsError {
    pub url: String,
}

fn no_repo_message(board_key: &str) -> String {
    format!(
        "board has no GitHub repo: {board_key} — 먼저 설정한다 (rocky-todo board repo OWNER/NAME)"
    )
}

/// 보드에 repo 가 설정돼 있는지 **todo 를 만들기 전에** 확인 — MCP 생성 경로의 중복
/// todo 방지.
pub fn assert_board_has_repo(store: &TodoStore, board_key: &str) -> StoreResult<()> {
    let board = store
        .board_id_of(board_key)?
        .and_then(|id| store.board_by_id(&id).transpose())
        .transpose()?;
    match board {
        Some(board) if board.repo.is_some() => Ok(()),
        _ => Err(StoreError::new(no_repo_message(board_key))),
    }
}

pub enum IssueForTodoError {
    AlreadyExists(IssueAlreadyExistsError),
    Other(StoreError),
}

impl From<StoreError> for IssueForTodoError {
    fn from(error: StoreError) -> Self {
        IssueForTodoError::Other(error)
    }
}

pub struct IssueForTodoOptions<'a> {
    pub actor: &'a str,
    pub current_board_id: Option<&'a str>,
    pub repo: Option<&'a str>,
}

/// todo 하나를 GitHub 이슈로 만들고 URL 을 `links` 에 덧붙인다. `options.repo` 는
/// **`gh` 성공 뒤에만** 보드에 영구 반영한다(실패 시 보드는 호출 전 상태 그대로).
pub async fn create_issue_for_todo(
    store: &TodoStore,
    todo_ref: &str,
    options: IssueForTodoOptions<'_>,
    runner: &Runner,
) -> Result<(String, Todo), IssueForTodoError> {
    let todo = store
        .get_todo(todo_ref, options.current_board_id)?
        .ok_or_else(|| StoreError::new(format!("todo not found: {todo_ref}")))?;
    if let Some(existing) = find_issue_link(&todo.links) {
        return Err(IssueForTodoError::AlreadyExists(IssueAlreadyExistsError {
            url: existing.to_string(),
        }));
    }
    let board = store
        .board_by_id(&todo.board_id)?
        .ok_or_else(|| StoreError::new(format!("board not found for todo: {todo_ref}")))?;
    let repo = options
        .repo
        .map(str::to_string)
        .or_else(|| board.repo.clone())
        .ok_or_else(|| StoreError::new(no_repo_message(&board.key)))?;
    let board_ref =
        rocky_todo_core::refs::ref_of(store, Some(&todo.board_id), todo.number, &todo.id)?;
    let result = create_issue(
        &repo,
        &todo.title,
        &issue_body(&todo.description, &board_ref),
        runner,
    )
    .await;
    let url = match result {
        CreateIssueOutcome::Ok { url } => url,
        CreateIssueOutcome::Failed { message } => {
            return Err(IssueForTodoError::Other(StoreError::new(message)))
        }
    };
    if let Some(repo_override) = options.repo {
        store.set_board_repo(&board.key, repo_override, options.actor)?;
    }
    let number = issue_number_from(&url);
    let mut links = todo.links.clone();
    links.push(TodoLink {
        url: url.clone(),
        title: Some(
            number
                .map(|n| format!("#{n}"))
                .unwrap_or_else(|| "issue".to_string()),
        ),
    });
    let updated = store.update_todo(
        &todo.id,
        &rocky_todo_core::types::UpdateTodoPatch {
            links: Some(links),
            ..Default::default()
        },
        options.actor,
        None,
    )?;
    Ok((url, updated))
}
