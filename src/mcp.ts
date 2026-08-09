import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import pkg from '../package.json' with { type: 'json' };
import { assertBoardHasRepo, createIssueForTodo, findIssueLink, type RunCommand } from './github';
import {
  CROSS_SITE_MESSAGE,
  isCrossSiteRequest,
  isLocalRequest,
  NON_LOCAL_ISSUE_MESSAGE,
} from './local-request';
import { refNeedsBoardContext, withRef } from './refs';
import { DETAIL_HISTORY_EXCLUDED, type StatusAction, type TodoStore } from './store';

/**
 * rocky-todo 의 MCP 표면 — 데몬의 `/mcp` (streamable HTTP) 에만 존재한다.
 *
 * 도구는 5개로 압축한다 (세션마다 실리는 스키마 토큰 고정비 최소화):
 * todo_list / todo_write / todo_status / note_list / note_write.
 * 섹션은 todo_write 의 `section` 이 이름 기반 upsert 하므로 별도 도구가 없다.
 * 삭제 도구는 의도적으로 없다 — 아카이브만 존재한다.
 */

export interface TodoMcpOptions {
  store: TodoStore;
  /** 외부 명령 실행자 — 테스트가 fake 를 넣는다. 생략하면 실제 `gh` 를 부른다. */
  run?: RunCommand;
  /**
   * 이 요청이 이슈 생성(= 사용자의 `gh` 인증으로 외부 발행)을 해도 되는 출처인지.
   * `createMcpFetchHandler` 가 요청마다 `isLocalRequest` 로 판정해 넣는다 — MCP 도구
   * 핸들러는 Request 를 볼 수 없어 boolean 으로 미리 접어 내려보낸다.
   * 생략하면 거부다(fail-closed) — 근거 없이 외부 발행을 허용하지 않는다.
   */
  allowIssueCreate?: boolean;
}

function jsonResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

const actorSchema = z
  .string()
  .optional()
  .describe('who is acting (e.g. claude-code / codex / opencode); recorded in history');

const linkSchema = z.object({ url: z.string(), title: z.string().optional() });

/**
 * `board` 인자를 currentBoardId 로 바꾼다. `board` 가 아예 안 왔으면 undefined(전역/현재
 * 컨텍스트 없음) 를 그대로 돌려주지만, `board` 가 왔는데 알려진 보드로 안 풀리면(오타 등),
 * `ref` 가 실제로 board 컨텍스트를 쓰는 맨숫자 꼴(`refNeedsBoardContext`)일 때만 에러를
 * 던진다. 그 경우 폴백을 허용하면 todos 는 우연히 "board context required" 로 에러가
 * 나지만(맨숫자가 전역 번호 공간이 없어서), notes 는 전역 메모 번호 공간으로 조용히
 * 재해석돼(`note_list { id: "3", board: "typo-board" }` 가 board 없이 준 것처럼
 * GLOBAL note 3 을 반환) 엉뚱한 행을 조용히 돌려주게 된다.
 *
 * 반대로 `rocky-12`/raw id/id-prefix 처럼 board 컨텍스트를 아예 안 쓰는 `ref` 에는
 * 안 풀리는 `board` 를 무시한다 — `resolveRef` 의 스코프/id/id-prefix 세 분기가
 * `currentBoardId` 를 참조조차 안 하니, 이 값이 뭐든 결과에 영향이 없다. 안 풀린다고
 * 무조건 던지면(과거 버그) `rocky-12` 를 그대로 넘기면서 무관한 board 오타(또는 CLI 가
 * cwd 로 유추해 붙인, 아직 안 만들어진 보드 key)에 막혀버린다.
 */
function resolveBoardId(
  store: TodoStore,
  board: string | undefined,
  ref: string,
): string | undefined {
  if (!board) {
    return undefined;
  }
  const boardId = store.boardIdOf(board);
  if (!boardId) {
    if (refNeedsBoardContext(ref)) {
      throw new Error(`unknown board: ${board}`);
    }
    return undefined;
  }
  return boardId;
}

/** 5개 도구가 등록된 McpServer 를 만든다 — transport 바인딩은 호출자 몫. */
export function buildTodoMcpServer(options: TodoMcpOptions): McpServer {
  const { store, run, allowIssueCreate = false } = options;
  const server = new McpServer({ name: 'rocky-todo', version: pkg.version });

  server.registerTool(
    'todo_list',
    {
      description:
        '공유 todo 보드 조회. board 로 보드 하나, 생략 시 전체. id 를 주면 해당 todo 상세 + 히스토리, boards:true 면 보드 목록. 필터: status / label / includeArchived. id 는 참조 문법(12, rocky-12, id, id prefix)을 받는다 — 맨숫자 12 로 조회하려면 board 를 함께 줘야 한다. 옛 표기(#12, rocky#12)도 계속 받는다.',
      inputSchema: {
        board: z
          .string()
          .optional()
          .describe(
            'board key (usually the repo name) — also scopes a bare 12 in id when id has no board prefix',
          ),
        id: z
          .string()
          .optional()
          .describe('todo ref — number (12), board-scoped (rocky-12), or raw id'),
        boards: z.boolean().optional().describe('true → list boards instead of todos'),
        status: z.enum(['todo', 'doing', 'done']).optional(),
        label: z.string().optional(),
        includeArchived: z.boolean().optional(),
      },
    },
    async ({ board, id, boards, status, label, includeArchived }) => {
      if (boards) {
        return jsonResult({ boards: store.listBoards(includeArchived ?? false) });
      }
      if (id) {
        const currentBoardId = resolveBoardId(store, board, id);
        const todo = store.getTodo(id, currentBoardId);
        if (!todo) {
          throw new Error(`todo not found: ${id}`);
        }
        return jsonResult({
          todo: withRef(store, todo),
          history: store.listHistory({
            entityId: todo.id,
            excludeActions: DETAIL_HISTORY_EXCLUDED,
          }),
          comments: store.listComments(todo.id, includeArchived ?? false),
        });
      }
      return jsonResult({
        todos: store
          .listTodos({ board, status, label, includeArchived })
          .map((t) => withRef(store, t)),
      });
    },
  );

  server.registerTool(
    'todo_write',
    {
      description:
        'todo 생성/수정. id 없으면 생성(board + title 필수), 있으면 부분 수정. section 은 이름으로 자동 upsert. links 에 GitHub 이슈 / Todoist URL 을 첨부해 맥락을 연결한다. 삭제는 없다 — todo_status 의 archive 를 쓴다. id 는 참조 문법(12, rocky-12, id, id prefix)을 받는다 — 맨숫자 12 로 수정하려면 board 를 함께 줘야 한다. 옛 표기(#12, rocky#12)도 계속 받는다. 진행 상황·중간 보고·사용자에게 묻고 싶은 것은 description 을 덮어쓰지 말고 comment 로 남긴다 — description 은 "이 할 일이 무엇인가"의 자리이고, comment 는 사용자와 주고받는 타임라인이다. createIssue: true 를 주면 이 todo 를 GitHub 이슈로 올리고 그 URL 을 links 에 붙인다 (보드에 repo 가 설정돼 있어야 한다).',
      inputSchema: {
        id: z
          .string()
          .optional()
          .describe(
            'omit to create; todo ref — number (12), board-scoped (rocky-12), or raw id — to patch',
          ),
        board: z
          .string()
          .optional()
          .describe(
            'board key — required when creating; also scopes a bare 12 in id when patching',
          ),
        title: z.string().optional().describe('required when creating'),
        description: z.string().optional().describe('markdown detail'),
        section: z.string().optional().describe('section name (upserted within the board)'),
        parentId: z.string().optional().describe('parent todo id for hierarchy'),
        priority: z.enum(['p1', 'p2', 'p3', 'p4']).optional(),
        due: z.string().optional().describe('ISO date, e.g. 2026-08-01'),
        labels: z.array(z.string()).optional(),
        links: z.array(linkSchema).optional(),
        comment: z
          .string()
          .optional()
          .describe(
            'append a comment to this todo — progress notes, findings, questions to the user. Use this instead of rewriting description',
          ),
        createIssue: z
          .boolean()
          .optional()
          .describe(
            "true → also open a GitHub issue for this todo and attach its URL to links. Requires the board to have a repo set (rocky-todo board repo OWNER/NAME), and only works when this MCP request reaches the daemon locally over loopback — it borrows the daemon user's gh credentials, so exposed surfaces are refused. This is an irreversible external publication, not a local board write: the issue is created immediately with no undo, the target repository may be public, and the todo title and description are published verbatim as the issue title/body. Ask the user for confirmation before setting this to true.",
          ),
        actor: actorSchema,
      },
    },
    async ({ id, board, title, comment, createIssue: wantIssue, actor, ...rest }) => {
      const who = actor ?? 'agent';
      // create/patch 를 먼저 실행하고 나서 comment 검증에 걸리면, 이미 만들어진/바뀐
      // todo 는 그대로 남고 에러만 돌아간다 — 호출자가 재시도하면 중복 생성(create)
      // 이거나 의도치 않은 부분 수정(patch)이 이미 적용된 채 남는다. `store.addComment`
      // 가 던질 조건(trim 후 빈 문자열)을 write 전에 그대로 재현해 all-or-nothing 을
      // 보장한다 — 메시지는 `store.addComment` 와 동일하게 맞춰 REST/MCP 표면 간
      // 에러 문구가 갈리지 않게 한다.
      if (comment !== undefined && comment.trim() === '') {
        throw new Error('comment body is required');
      }
      // 출처 거부는 모든 write 앞이다 — 어차피 발행이 안 될 호출이 patch/create 만
      // 적용해놓고 실패하면, 호출자는 "이슈는 안 만들어졌는데 todo 는 바뀐" 상태를
      // 되짚어야 한다. 인가는 부수효과 전에 끊는다.
      if (wantIssue && !allowIssueCreate) {
        throw new Error(NON_LOCAL_ISSUE_MESSAGE);
      }
      if (id) {
        const currentBoardId = resolveBoardId(store, board, id);
        // 이미 이슈가 있으면 write 전에 끊는다 — 흔한 재시도에서 patch 만 적용되고
        // 에러가 나는 부분 반영을 막는다. gh 실행 자체의 실패는 미리 알 수 없어
        // patch 뒤에 남지만, 그때는 patch 가 정당하게 적용된 상태다.
        if (wantIssue) {
          const current = store.getTodo(id, currentBoardId);
          if (current && findIssueLink(current.links)) {
            throw new Error(`todo already has a GitHub issue: ${findIssueLink(current.links)}`);
          }
        }
        // comment/createIssue 만 온 호출은 updateTodo 를 건너뛴다 — 아무것도 안 바뀐
        // `update` 히스토리 줄이 따라붙어 타임라인을 어지럽히지 않게.
        const hasPatch =
          title !== undefined || Object.values(rest).some((value) => value !== undefined);
        let todo = hasPatch
          ? store.updateTodo(id, { title, ...rest }, who, currentBoardId)
          : store.getTodo(id, currentBoardId);
        if (!todo) {
          throw new Error(`todo not found: ${id}`);
        }
        // undefined 로만 "댓글 없음"을 판단한다 — 빈 문자열/공백은 위 사전 검증에서
        // 이미 에러로 끊긴다. `if (comment)` 였을 때는 `comment: ""` 가 아무 것도 안 쓰고
        // 성공해버려(REST 는 400) 표면마다 동작이 갈렸다.
        if (comment !== undefined) {
          store.addComment(todo.id, comment, who);
        }
        if (wantIssue) {
          todo = createIssueForTodo(store, todo.id, { actor: who, run }).todo;
        }
        return jsonResult(withRef(store, todo));
      }
      if (!board || !title) {
        throw new Error('board and title are required to create a todo');
      }
      // 이슈 생성의 전제(보드 repo)는 createTodo 보다 먼저 검증한다 — 뒤에서 던지면
      // 만들어진 todo 는 남는데 호출자는 그 id 를 못 받아, 재시도가 중복 todo 를 쌓는다.
      // `gh` 실행 자체의 실패는 미리 알 수 없어 여전히 todo 를 남기지만, 그건 "todo 는
      // 정당하게 만들어졌고 발행만 실패" 라 재시도 대상이 이슈 생성뿐이다.
      if (wantIssue) {
        assertBoardHasRepo(store, board);
      }
      let created = store.createTodo({ board, title, ...rest }, who);
      if (comment !== undefined) {
        store.addComment(created.id, comment, who);
      }
      if (wantIssue) {
        created = createIssueForTodo(store, created.id, { actor: who, run }).todo;
      }
      return jsonResult(withRef(store, created));
    },
  );

  server.registerTool(
    'todo_status',
    {
      description:
        'todo 상태 전이. start=처리 시작(누가 작업중인지 웹 UI 에 표시됨 — 작업 착수 시 반드시 호출), stop=중단, done=완료, reopen=재오픈, archive/unarchive=보관/복원. id 는 참조 문법(12, rocky-12, id, id prefix)을 받는다 — 맨숫자 12 로 지정하려면 board 를 함께 줘야 한다. 옛 표기(#12, rocky#12)도 계속 받는다.',
      inputSchema: {
        id: z.string().describe('todo ref — number (12), board-scoped (rocky-12), or raw id'),
        board: z.string().optional().describe('board key that scopes a bare 12 in id'),
        action: z.enum(['start', 'stop', 'done', 'reopen', 'archive', 'unarchive']),
        actor: actorSchema,
      },
    },
    async ({ id, board, action, actor }) => {
      const currentBoardId = resolveBoardId(store, board, id);
      return jsonResult(
        withRef(
          store,
          store.setTodoStatus(id, action as StatusAction, actor ?? 'agent', currentBoardId),
        ),
      );
    },
  );

  server.registerTool(
    'note_list',
    {
      description:
        '스크래치패드/메모 조회. board 로 보드 소속, global:true 로 보드 미소속 메모 목록. id 를 주면 상세 + 히스토리. id 는 참조 문법(note-3, rocky-12, 12, id, id prefix)을 받는다. 전역(보드 미소속) 메모는 note-N 으로 지정하는 것이 가장 안전하다 — 이 접두사는 예약어라 board 인자와 무관하게 늘 전역 메모를 가리킨다. 반면 맨숫자 12 는 board 인자 유무로 완전히 다른 행이 된다: board 를 생략하면 전역 번호 공간, 주면 그 보드의 번호 공간이다. 옛 표기(#12, rocky#12)도 계속 받는다.',
      inputSchema: {
        board: z
          .string()
          .optional()
          .describe(
            "board key — scopes id to that board's number space. A global note ref (note-3) ignores this argument; prefer note-N over a bare number when you mean a global note",
          ),
        global: z.boolean().optional(),
        id: z
          .string()
          .optional()
          .describe(
            "note ref — global note (note-3), board-scoped (rocky-12), bare number (12: GLOBAL note space when board is omitted, that board's space when board is given), or raw id",
          ),
        includeArchived: z.boolean().optional(),
      },
    },
    async ({ board, global: isGlobal, id, includeArchived }) => {
      if (id) {
        const currentBoardId = resolveBoardId(store, board, id);
        const note = store.getNote(id, currentBoardId);
        if (!note) {
          throw new Error(`note not found: ${id}`);
        }
        return jsonResult({
          note: withRef(store, note),
          history: store.listHistory({ entityId: note.id }),
        });
      }
      return jsonResult({
        notes: store
          .listNotes({ board, global: isGlobal, includeArchived })
          .map((n) => withRef(store, n)),
      });
    },
  );

  server.registerTool(
    'note_write',
    {
      description:
        '스크래치패드/메모 작성. id 없으면 생성(title 필수), 있으면 수정. mode: set=content 교체(기본) / append=뒤에 이어붙임 / archive=보관 / unarchive=복원. 삭제는 없다. id 는 참조 문법(note-3, rocky-12, 12, id, id prefix)을 받는다. 전역(보드 미소속) 메모를 수정/보관하려면 note-N 으로 지정한다 — 예약 접두사라 board 인자와 무관하게 늘 전역 메모다. 맨숫자 12 는 board 인자 유무로 완전히 다른 행을 가리킨다: board 를 생략하면 전역 메모, 주면 그 보드의 같은 번호 메모가 대신 수정/보관된다(에러 없이 조용히). 옛 표기(#12, rocky#12)도 계속 받는다.',
      inputSchema: {
        id: z
          .string()
          .optional()
          .describe(
            "omit to create; note ref — global note (note-3), board-scoped (rocky-12), bare number (12: GLOBAL note space when board is omitted, that board's space when board is given), or raw id — to update",
          ),
        board: z
          .string()
          .optional()
          .describe(
            "omit for a global note when creating; when updating, a note-N id already targets the global note space and ignores this — but a bare number needs this OMITTED to mean the global note, otherwise it resolves that board's own N (a different row)",
          ),
        title: z.string().optional(),
        content: z.string().optional(),
        mode: z.enum(['set', 'append', 'archive', 'unarchive']).optional(),
        actor: actorSchema,
      },
    },
    async ({ id, board, title, content, mode, actor }) => {
      const who = actor ?? 'agent';
      if (!id) {
        if (!title) {
          throw new Error('title is required to create a note');
        }
        return jsonResult(withRef(store, store.createNote({ board, title, content }, who)));
      }
      const currentBoardId = resolveBoardId(store, board, id);
      if (mode === 'archive') {
        return jsonResult(withRef(store, store.archiveNote(id, who, currentBoardId)));
      }
      if (mode === 'unarchive') {
        return jsonResult(withRef(store, store.unarchiveNote(id, who, currentBoardId)));
      }
      return jsonResult(
        withRef(
          store,
          store.updateNote(
            id,
            { title, content, mode: mode === 'append' ? 'append' : 'set' },
            who,
            currentBoardId,
          ),
        ),
      );
    },
  );

  return server;
}

/**
 * `/mcp` 용 fetch 핸들러 — stateless 모드로 요청마다 서버+transport 를 새로 만든다.
 * 로컬 단일 사용자 데몬이라 세션 관리가 불필요하고, 요청 간 상태는 전부 store 에 있다.
 *
 * 요청마다 서버를 새로 만드는 성질을 그대로 활용해, 그 요청의 출처 판정을
 * `allowIssueCreate` 로 접어 도구에 내려보낸다 — REST 의 403 가드와 같은 판별
 * (`isLocalRequest`)을 공유하므로 두 표면이 갈리지 않는다.
 *
 * @param peerAddress 요청 소켓의 주소 — `daemon.ts` 가 `server.requestIP(req)` 에서
 *   넘긴다. 생략하면 이슈 생성은 거부된다(fail-closed).
 */
export function createMcpFetchHandler(
  options: TodoMcpOptions,
): (req: Request, peerAddress?: string) => Promise<Response> {
  return async (req: Request, peerAddress?: string): Promise<Response> => {
    // REST 와 같은 cross-site 가드 — 이 표면도 도구 호출로 보드를 고친다. 지금은 전송
    // 규약(JSON content-type + SSE Accept)이 폼 POST 를 이미 걸러내지만, "변경은 라우트
    // 전에 끊는다" 는 규칙의 예외를 남겨두지 않는다.
    if (req.method.toUpperCase() !== 'GET' && isCrossSiteRequest(req)) {
      return new Response(JSON.stringify({ error: CROSS_SITE_MESSAGE }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      });
    }
    const server = buildTodoMcpServer({
      ...options,
      allowIssueCreate: isLocalRequest(req, peerAddress),
    });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(req);
    } finally {
      // 응답 스트림이 닫힌 뒤 리소스 정리 — stateless 라 요청 단위 수명이다.
      void transport.close().catch(() => {});
    }
  };
}
