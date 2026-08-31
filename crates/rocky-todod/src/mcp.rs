//! rocky-todo 의 MCP 표면 — 데몬의 `/mcp` (streamable HTTP). TS 원본 `src/mcp.ts`.
//!
//! 도구는 5개로 압축한다(세션마다 실리는 스키마 토큰 고정비 최소화):
//! todo_list / todo_write / todo_status / note_list / note_write. 삭제 도구는 없다.
//!
//! **stateless**: `legacy_session_mode=false` + `NeverSessionManager` — 요청 간 상태는
//! 전부 store 에 있다. TS 가 요청마다 서버를 새로 만들어 `allowIssueCreate` 를 접어
//! 내려보낸 것은, 여기서는 allow 값이 다른 **서비스 두 벌**을 만들어 요청의
//! `isLocalRequest` 판정으로 고르는 것으로 대응한다.

use std::sync::Arc;

use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, ContentBlock, ServerCapabilities, ServerInfo};
use rmcp::transport::streamable_http_server::session::never::NeverSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use rmcp::{tool, tool_handler, tool_router, ServerHandler};
use rocky_todo_core::local_request::NON_LOCAL_ISSUE_MESSAGE;
use rocky_todo_core::refs::{ref_needs_board_context, with_ref_note, with_ref_todo};
use rocky_todo_core::store::{StoreError, StoreResult, TodoStore};
use rocky_todo_core::types::*;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::json;

use crate::github::{
    assert_board_has_repo, create_issue_for_todo, find_issue_link, IssueForTodoError,
    IssueForTodoOptions,
};
use crate::server::ServerState;

/// TS `jsonResult` — `{content:[{type:'text', text: JSON.stringify(값)}]}`.
fn json_result(value: &impl serde::Serialize) -> Result<CallToolResult, StoreError> {
    let text = serde_json::to_string(value).map_err(|error| StoreError::new(error.to_string()))?;
    Ok(CallToolResult::success(vec![ContentBlock::text(text)]))
}

/// TS 의 throw → MCP SDK 가 isError 결과로 접는 것과 동일하게, 에러 메시지를 도구
/// 에러 결과로 돌려준다.
fn tool_outcome(result: Result<CallToolResult, StoreError>) -> CallToolResult {
    match result {
        Ok(out) => out,
        Err(error) => CallToolResult::error(vec![ContentBlock::text(error.to_string())]),
    }
}

/// `board` 인자 → currentBoardId. 안 풀리면 ref 가 맨숫자 꼴일 때만 에러 — REST 의
/// `current_board_id_of` 와 동일 규칙(`src/mcp.ts` 의 `resolveBoardId`).
fn resolve_board_id(
    store: &TodoStore,
    board: Option<&str>,
    r: &str,
) -> StoreResult<Option<String>> {
    let Some(board) = board.filter(|b| !b.is_empty()) else {
        return Ok(None);
    };
    match store.board_id_of(board)? {
        Some(board_id) => Ok(Some(board_id)),
        None => {
            if ref_needs_board_context(r) {
                Err(StoreError::new(format!("unknown board: {board}")))
            } else {
                Ok(None)
            }
        }
    }
}

#[derive(Deserialize, JsonSchema)]
pub struct TodoListArgs {
    /// board key (usually the repo name) — also scopes a bare 12 in id when id has no board prefix
    pub board: Option<String>,
    /// todo ref — number (12), board-scoped (rocky-12), or raw id
    pub id: Option<String>,
    /// true → list boards instead of todos
    pub boards: Option<bool>,
    pub status: Option<TodoStatus>,
    pub label: Option<String>,
    #[serde(rename = "includeArchived")]
    #[schemars(rename = "includeArchived")]
    pub include_archived: Option<bool>,
}

#[derive(Deserialize, JsonSchema)]
pub struct TodoLinkArg {
    pub url: String,
    pub title: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
pub struct TodoWriteArgs {
    /// omit to create; todo ref — number (12), board-scoped (rocky-12), or raw id — to patch
    pub id: Option<String>,
    /// board key — required when creating; also scopes a bare 12 in id when patching
    pub board: Option<String>,
    /// required when creating
    pub title: Option<String>,
    /// markdown detail
    pub description: Option<String>,
    /// section name (upserted within the board)
    pub section: Option<String>,
    /// parent todo id for hierarchy
    #[serde(rename = "parentId")]
    #[schemars(rename = "parentId")]
    pub parent_id: Option<String>,
    pub priority: Option<TodoPriority>,
    /// ISO date, e.g. 2026-08-01
    pub due: Option<String>,
    pub labels: Option<Vec<String>>,
    pub links: Option<Vec<TodoLinkArg>>,
    /// append a comment to this todo — progress notes, findings, questions to the user. Use this instead of rewriting description
    pub comment: Option<String>,
    /// true → also open a GitHub issue for this todo and attach its URL to links. Requires the board to have a repo set (rocky-todo board repo OWNER/NAME), and only works when this MCP request reaches the daemon locally over loopback — it borrows the daemon user's gh credentials, so exposed surfaces are refused. This is an irreversible external publication, not a local board write: the issue is created immediately with no undo, the target repository may be public, and the todo title and description are published verbatim as the issue title/body. Ask the user for confirmation before setting this to true.
    #[serde(rename = "createIssue")]
    #[schemars(rename = "createIssue")]
    pub create_issue: Option<bool>,
    /// who is acting (e.g. claude-code / codex / opencode); recorded in history
    pub actor: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
pub struct TodoStatusArgs {
    /// todo ref — number (12), board-scoped (rocky-12), or raw id
    pub id: String,
    /// board key that scopes a bare 12 in id
    pub board: Option<String>,
    pub action: StatusAction,
    /// who is acting (e.g. claude-code / codex / opencode); recorded in history
    pub actor: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
pub struct NoteListArgs {
    /// board key — scopes id to that board's number space. A global note ref (note-3) ignores this argument; prefer note-N over a bare number when you mean a global note
    pub board: Option<String>,
    pub global: Option<bool>,
    /// note ref — global note (note-3), board-scoped (rocky-12), bare number (12: GLOBAL note space when board is omitted, that board's space when board is given), or raw id
    pub id: Option<String>,
    #[serde(rename = "includeArchived")]
    #[schemars(rename = "includeArchived")]
    pub include_archived: Option<bool>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum NoteWriteMode {
    Set,
    Append,
    Archive,
    Unarchive,
}

#[derive(Deserialize, JsonSchema)]
pub struct NoteWriteArgs {
    /// omit to create; note ref — global note (note-3), board-scoped (rocky-12), bare number (12: GLOBAL note space when board is omitted, that board's space when board is given), or raw id — to update
    pub id: Option<String>,
    /// omit for a global note when creating; when updating, a note-N id already targets the global note space and ignores this — but a bare number needs this OMITTED to mean the global note, otherwise it resolves that board's own N (a different row)
    pub board: Option<String>,
    pub title: Option<String>,
    pub content: Option<String>,
    pub mode: Option<NoteWriteMode>,
    /// who is acting (e.g. claude-code / codex / opencode); recorded in history
    pub actor: Option<String>,
}

#[derive(Clone)]
pub struct TodoMcp {
    state: Arc<ServerState>,
    allow_issue_create: bool,
    tool_router: ToolRouter<Self>,
}

impl TodoMcp {
    pub fn new(state: Arc<ServerState>, allow_issue_create: bool) -> Self {
        TodoMcp {
            state,
            allow_issue_create,
            tool_router: Self::tool_router(),
        }
    }
}

#[tool_router(router = tool_router)]
impl TodoMcp {
    #[tool(
        name = "todo_list",
        description = "공유 todo 보드 조회. board 로 보드 하나, 생략 시 전체. id 를 주면 해당 todo 상세 + 히스토리, boards:true 면 보드 목록. 필터: status / label / includeArchived. id 는 참조 문법(12, rocky-12, id, id prefix)을 받는다 — 맨숫자 12 로 조회하려면 board 를 함께 줘야 한다. 옛 표기(#12, rocky#12)도 계속 받는다."
    )]
    async fn todo_list(&self, Parameters(args): Parameters<TodoListArgs>) -> CallToolResult {
        tool_outcome(self.todo_list_inner(args))
    }

    #[tool(
        name = "todo_write",
        description = "todo 생성/수정. id 없으면 생성(board + title 필수), 있으면 부분 수정. section 은 이름으로 자동 upsert. links 에 GitHub 이슈 / Todoist URL 을 첨부해 맥락을 연결한다. 삭제는 없다 — todo_status 의 archive 를 쓴다. id 는 참조 문법(12, rocky-12, id, id prefix)을 받는다 — 맨숫자 12 로 수정하려면 board 를 함께 줘야 한다. 옛 표기(#12, rocky#12)도 계속 받는다. 진행 상황·중간 보고·사용자에게 묻고 싶은 것은 description 을 덮어쓰지 말고 comment 로 남긴다 — description 은 \"이 할 일이 무엇인가\"의 자리이고, comment 는 사용자와 주고받는 타임라인이다. createIssue: true 를 주면 이 todo 를 GitHub 이슈로 올리고 그 URL 을 links 에 붙인다 (보드에 repo 가 설정돼 있어야 한다)."
    )]
    async fn todo_write(&self, Parameters(args): Parameters<TodoWriteArgs>) -> CallToolResult {
        tool_outcome(self.todo_write_inner(args).await)
    }

    #[tool(
        name = "todo_status",
        description = "todo 상태 전이. start=처리 시작(누가 작업중인지 웹 UI 에 표시됨 — 작업 착수 시 반드시 호출), stop=중단, done=완료, reopen=재오픈, archive/unarchive=보관/복원. id 는 참조 문법(12, rocky-12, id, id prefix)을 받는다 — 맨숫자 12 로 지정하려면 board 를 함께 줘야 한다. 옛 표기(#12, rocky#12)도 계속 받는다."
    )]
    async fn todo_status(&self, Parameters(args): Parameters<TodoStatusArgs>) -> CallToolResult {
        tool_outcome(self.todo_status_inner(args))
    }

    #[tool(
        name = "note_list",
        description = "스크래치패드/메모 조회. board 로 보드 소속, global:true 로 보드 미소속 메모 목록. id 를 주면 상세 + 히스토리. id 는 참조 문법(note-3, rocky-12, 12, id, id prefix)을 받는다. 전역(보드 미소속) 메모는 note-N 으로 지정하는 것이 가장 안전하다 — 이 접두사는 예약어라 board 인자와 무관하게 늘 전역 메모를 가리킨다. 반면 맨숫자 12 는 board 인자 유무로 완전히 다른 행이 된다: board 를 생략하면 전역 번호 공간, 주면 그 보드의 번호 공간이다. 옛 표기(#12, rocky#12)도 계속 받는다."
    )]
    async fn note_list(&self, Parameters(args): Parameters<NoteListArgs>) -> CallToolResult {
        tool_outcome(self.note_list_inner(args))
    }

    #[tool(
        name = "note_write",
        description = "스크래치패드/메모 작성. id 없으면 생성(title 필수), 있으면 수정. mode: set=content 교체(기본) / append=뒤에 이어붙임 / archive=보관 / unarchive=복원. 삭제는 없다. id 는 참조 문법(note-3, rocky-12, 12, id, id prefix)을 받는다. 전역(보드 미소속) 메모를 수정/보관하려면 note-N 으로 지정한다 — 예약 접두사라 board 인자와 무관하게 늘 전역 메모다. 맨숫자 12 는 board 인자 유무로 완전히 다른 행을 가리킨다: board 를 생략하면 전역 메모, 주면 그 보드의 같은 번호 메모가 대신 수정/보관된다(에러 없이 조용히). 옛 표기(#12, rocky#12)도 계속 받는다."
    )]
    async fn note_write(&self, Parameters(args): Parameters<NoteWriteArgs>) -> CallToolResult {
        tool_outcome(self.note_write_inner(args).await)
    }
}

impl TodoMcp {
    fn todo_list_inner(&self, args: TodoListArgs) -> Result<CallToolResult, StoreError> {
        let store = &self.state.store;
        if args.boards == Some(true) {
            return json_result(
                &json!({ "boards": store.list_boards(args.include_archived.unwrap_or(false))? }),
            );
        }
        if let Some(id) = &args.id {
            let current_board_id = resolve_board_id(store, args.board.as_deref(), id)?;
            let Some(todo) = store.get_todo(id, current_board_id.as_deref())? else {
                return Err(StoreError::new(format!("todo not found: {id}")));
            };
            let history = store.list_history(&ListHistoryFilter {
                entity_id: Some(todo.id.clone()),
                exclude_actions: DETAIL_HISTORY_EXCLUDED
                    .iter()
                    .map(|s| s.to_string())
                    .collect(),
                ..Default::default()
            })?;
            let comments = store.list_comments(&todo.id, args.include_archived.unwrap_or(false))?;
            return json_result(&json!({
                "todo": with_ref_todo(store, todo)?,
                "history": history,
                "comments": comments,
            }));
        }
        let todos = store.list_todos(&ListTodosFilter {
            board: args.board,
            status: args.status,
            label: args.label,
            include_archived: args.include_archived.unwrap_or(false),
        })?;
        let views = todos
            .into_iter()
            .map(|t| with_ref_todo(store, t))
            .collect::<StoreResult<Vec<_>>>()?;
        json_result(&json!({ "todos": views }))
    }

    async fn todo_write_inner(&self, args: TodoWriteArgs) -> Result<CallToolResult, StoreError> {
        let store = &self.state.store;
        let who = args.actor.as_deref().unwrap_or("agent");
        let want_issue = args.create_issue == Some(true);
        // comment 검증은 **모든 write 전에** — all-or-nothing (재시도 시 중복 생성 방지).
        if let Some(comment) = &args.comment {
            if comment.trim().is_empty() {
                return Err(StoreError::new("comment body is required"));
            }
        }
        // 출처 거부도 모든 write 앞 — 인가는 부수효과 전에 끊는다.
        if want_issue && !self.allow_issue_create {
            return Err(StoreError::new(NON_LOCAL_ISSUE_MESSAGE));
        }
        let links: Option<Vec<TodoLink>> = args.links.map(|links| {
            links
                .into_iter()
                .map(|l| TodoLink {
                    url: l.url,
                    title: l.title,
                })
                .collect()
        });

        if let Some(id) = &args.id {
            let current_board_id = resolve_board_id(store, args.board.as_deref(), id)?;
            // 이미 이슈가 있으면 write 전에 끊는다 — patch 만 적용되는 부분 반영 방지.
            if want_issue {
                if let Some(current) = store.get_todo(id, current_board_id.as_deref())? {
                    if let Some(existing) = find_issue_link(&current.links) {
                        return Err(StoreError::new(format!(
                            "todo already has a GitHub issue: {existing}"
                        )));
                    }
                }
            }
            let patch = UpdateTodoPatch {
                title: args.title.clone(),
                description: args.description.clone(),
                priority: args.priority,
                due: args.due.clone().map(Some),
                labels: args.labels.clone(),
                links,
                section: args.section.clone().map(Some),
                parent_id: args.parent_id.clone().map(Some),
            };
            // comment/createIssue 만 온 호출은 updateTodo 를 건너뛴다(빈 update 히스토리 방지).
            let has_patch = patch.title.is_some()
                || patch.description.is_some()
                || patch.priority.is_some()
                || patch.due.is_some()
                || patch.labels.is_some()
                || patch.links.is_some()
                || patch.section.is_some()
                || patch.parent_id.is_some();
            let mut todo = if has_patch {
                Some(store.update_todo(id, &patch, who, current_board_id.as_deref())?)
            } else {
                store.get_todo(id, current_board_id.as_deref())?
            };
            let Some(current) = todo.take() else {
                return Err(StoreError::new(format!("todo not found: {id}")));
            };
            if let Some(comment) = &args.comment {
                store.add_comment(&current.id, comment, who, None)?;
            }
            let final_todo = if want_issue {
                match create_issue_for_todo(
                    store,
                    &current.id,
                    IssueForTodoOptions {
                        actor: who,
                        current_board_id: None,
                        repo: None,
                    },
                    &self.state.mcp_gh_runner(),
                )
                .await
                {
                    Ok((_, todo)) => todo,
                    Err(IssueForTodoError::AlreadyExists(error)) => {
                        return Err(StoreError::new(error.to_string()))
                    }
                    Err(IssueForTodoError::Other(error)) => return Err(error),
                }
            } else {
                current
            };
            return json_result(&with_ref_todo(store, final_todo)?);
        }

        let (Some(board), Some(title)) = (args.board.as_deref(), args.title.as_deref()) else {
            return Err(StoreError::new(
                "board and title are required to create a todo",
            ));
        };
        // 이슈 생성의 전제(보드 repo)는 createTodo 보다 먼저 — 재시도가 중복 todo 를 안 쌓게.
        if want_issue {
            assert_board_has_repo(store, board)?;
        }
        let created = store.create_todo(
            &CreateTodoInput {
                board: board.to_string(),
                title: title.to_string(),
                description: args.description,
                section: args.section,
                parent_id: args.parent_id,
                priority: args.priority,
                due: args.due,
                labels: args.labels,
                links,
            },
            who,
        )?;
        if let Some(comment) = &args.comment {
            store.add_comment(&created.id, comment, who, None)?;
        }
        let final_todo = if want_issue {
            match create_issue_for_todo(
                store,
                &created.id,
                IssueForTodoOptions {
                    actor: who,
                    current_board_id: None,
                    repo: None,
                },
                &self.state.mcp_gh_runner(),
            )
            .await
            {
                Ok((_, todo)) => todo,
                Err(IssueForTodoError::AlreadyExists(error)) => {
                    return Err(StoreError::new(error.to_string()))
                }
                Err(IssueForTodoError::Other(error)) => return Err(error),
            }
        } else {
            created
        };
        json_result(&with_ref_todo(store, final_todo)?)
    }

    fn todo_status_inner(&self, args: TodoStatusArgs) -> Result<CallToolResult, StoreError> {
        let store = &self.state.store;
        let current_board_id = resolve_board_id(store, args.board.as_deref(), &args.id)?;
        let updated = store.set_todo_status(
            &args.id,
            args.action,
            args.actor.as_deref().unwrap_or("agent"),
            current_board_id.as_deref(),
        )?;
        json_result(&with_ref_todo(store, updated)?)
    }

    fn note_list_inner(&self, args: NoteListArgs) -> Result<CallToolResult, StoreError> {
        let store = &self.state.store;
        if let Some(id) = &args.id {
            let current_board_id = resolve_board_id(store, args.board.as_deref(), id)?;
            let Some(note) = store.get_note(id, current_board_id.as_deref())? else {
                return Err(StoreError::new(format!("note not found: {id}")));
            };
            let history = store.list_history(&ListHistoryFilter {
                entity_id: Some(note.id.clone()),
                ..Default::default()
            })?;
            return json_result(&json!({
                "note": with_ref_note(store, note)?,
                "history": history,
            }));
        }
        let notes = store.list_notes(&ListNotesFilter {
            board: args.board,
            global: args.global.unwrap_or(false),
            include_archived: args.include_archived.unwrap_or(false),
        })?;
        let views = notes
            .into_iter()
            .map(|n| with_ref_note(store, n))
            .collect::<StoreResult<Vec<_>>>()?;
        json_result(&json!({ "notes": views }))
    }

    async fn note_write_inner(&self, args: NoteWriteArgs) -> Result<CallToolResult, StoreError> {
        let store = &self.state.store;
        let who = args.actor.as_deref().unwrap_or("agent");
        let Some(id) = &args.id else {
            let Some(title) = args.title.as_deref() else {
                return Err(StoreError::new("title is required to create a note"));
            };
            let note = store.create_note(
                &CreateNoteInput {
                    board: args.board,
                    title: title.to_string(),
                    content: args.content,
                },
                who,
            )?;
            return json_result(&with_ref_note(store, note)?);
        };
        let current_board_id = resolve_board_id(store, args.board.as_deref(), id)?;
        match args.mode {
            Some(NoteWriteMode::Archive) => {
                let note = store.archive_note(id, who, current_board_id.as_deref())?;
                json_result(&with_ref_note(store, note)?)
            }
            Some(NoteWriteMode::Unarchive) => {
                let note = store.unarchive_note(id, who, current_board_id.as_deref())?;
                json_result(&with_ref_note(store, note)?)
            }
            mode => {
                let note = store.update_note(
                    id,
                    &UpdateNotePatch {
                        title: args.title,
                        content: args.content,
                        mode: if matches!(mode, Some(NoteWriteMode::Append)) {
                            NoteContentMode::Append
                        } else {
                            NoteContentMode::Set
                        },
                    },
                    who,
                    current_board_id.as_deref(),
                )?;
                json_result(&with_ref_note(store, note)?)
            }
        }
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for TodoMcp {
    fn get_info(&self) -> ServerInfo {
        let mut info = ServerInfo::default();
        info.server_info.name = "rocky-todo".into();
        info.server_info.version = env!("CARGO_PKG_VERSION").into();
        info.capabilities = ServerCapabilities::builder().enable_tools().build();
        info
    }
}

/// `/mcp` 서비스 — stateless. `allowed_hosts` 는 비운다(tailscale serve 경유 Host 가
/// `*.ts.net` — DNS rebinding 은 우리 cross-site 가드가 라우팅 전에 막는다).
pub fn mcp_service(
    state: Arc<ServerState>,
    allow_issue_create: bool,
) -> StreamableHttpService<TodoMcp, NeverSessionManager> {
    let config = StreamableHttpServerConfig::default()
        .with_legacy_session_mode(false)
        .with_json_response(true)
        .disable_allowed_hosts();
    StreamableHttpService::new(
        move || Ok(TodoMcp::new(state.clone(), allow_issue_create)),
        Arc::new(NeverSessionManager::default()),
        config,
    )
}
