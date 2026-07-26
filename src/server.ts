import pkg from '../package.json' with { type: 'json' };
import {
  createIssueForTodo,
  findIssueLink,
  IssueAlreadyExistsError,
  isRepoSlug,
  type RunCommand,
} from './github';
import { isLocalRequest, NON_LOCAL_ISSUE_MESSAGE } from './local-request';
import { refNeedsBoardContext, withRef } from './refs';
import {
  DETAIL_HISTORY_EXCLUDED,
  type ListTodosFilter,
  type StatusAction,
  type TodoStore,
} from './store';

/**
 * rocky-todo REST + SSE 표면 — CLI / 웹 UI 가 공유한다.
 *
 * `buildTodoServer` 는 fetch 핸들러만 반환한다 (Bun.serve 바인딩은 daemon.ts 몫)
 * — 테스트에서 Request 를 직접 넣어 계약을 검증할 수 있게 DI 형태를 유지한다.
 * actor 는 `x-rocky-actor` 헤더로 전달된다 (웹 UI 는 localStorage 설정값을 보낸다).
 */

export interface TodoServerOptions {
  store: TodoStore;
  /** 외부 명령 실행자 — 테스트가 fake 를 넣는다. 생략하면 실제 `gh` 를 부른다. */
  run?: RunCommand;
}

// TodoView/NoteView 는 REST·MCP 가 공유하는 './refs' 가 정의한다 — 여기서 재수출해
// CLI(`import type { NoteView, TodoView } from './server'`) 등 기존 import 경로를 보존한다.
export type { NoteView, TodoView } from './refs';

export interface TodoServer {
  /**
   * @param peerAddress 요청을 보낸 소켓의 주소 — `daemon.ts` 가 `server.requestIP(req)`
   *   에서 넘긴다. 이슈 생성 라우트가 출처를 판별하는 데만 쓴다(`isLocalRequest`).
   *   생략하면 루프백이 아닌 것으로 취급된다 — 근거 없음은 거부다(fail-closed).
   */
  fetch: (req: Request, peerAddress?: string) => Promise<Response>;
}

const STATUS_ACTIONS: ReadonlySet<string> = new Set([
  'start',
  'stop',
  'done',
  'reopen',
  'archive',
  'unarchive',
]);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function errorResponse(message: string, status: number): Response {
  return json({ error: message }, status);
}

/**
 * 이슈 중복 응답 — 사전 검사와 orchestrator 경유 두 경로가 **같은 본문**을 내도록 한 곳에 둔다.
 * `url` 을 함께 싣는 건 웹 UI 가 "이미 있음"을 그 이슈로 보내는 데 쓰기 때문이다.
 */
function alreadyHasIssue(url: string): Response {
  return json({ error: `todo already has a GitHub issue: ${url}`, url }, 409);
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = (await req.json()) as unknown;
    if (typeof body !== 'object' || body === null) {
      throw new Error('body must be a JSON object');
    }
    return body as Record<string, unknown>;
  } catch {
    throw new Error('invalid JSON body');
  }
}

/**
 * 몸통이 아예 없어도 되는 라우트용 — CLI/웹 UI 가 `{ repo }` 없이 POST 하는 경우가
 * 흔하다(`src/cli.ts` 의 `issue` 명령 기본 경로, `src/ui/store.ts` 의 `createIssue`).
 * `readBody` 는 빈 본문에서 JSON 파싱이 던지는 걸 그대로 "invalid JSON body" 로
 * 바꿔버려 이 경우를 구분 못 한다 — 빈 문자열이면 undefined 를 돌려주고, 있으면
 * `readBody` 와 같은 파싱/모양 검증을 적용한다.
 */
async function readOptionalBody(req: Request): Promise<Record<string, unknown> | undefined> {
  const text = await req.text();
  if (text.trim() === '') {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('invalid JSON body');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

/** not found 류 스토어 에러를 HTTP status 로 번역한다. */
function toHttpError(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  if (/not found/i.test(message)) {
    return errorResponse(message, 404);
  }
  return errorResponse(message, 400);
}

export function buildTodoServer(options: TodoServerOptions): TodoServer {
  const { store, run } = options;

  /**
   * `?board=` 쿼리스트링(보드 key)을 참조 해석에 쓰는 boardId 로 바꾼다. 쿼리 자체가
   * 없으면 undefined(전역/현재 컨텍스트 없음). 쿼리가 있는데 알려진 보드로 안 풀리면(오타
   * 등), `ref` 가 실제로 board 컨텍스트를 쓰는 맨숫자 꼴(`refNeedsBoardContext`)일
   * 때만 에러를 던진다(→ catch 에서 toHttpError 로 400) — 그 경우 폴백을 허용하면
   * todos 는 우연히 "board context required" 로 에러가 나지만, notes 는 전역 메모
   * 번호 공간으로 조용히 재해석돼 엉뚱한 행을 돌려주게 된다(MCP 쪽과 동일한 wrong-row
   * 위험 — `src/mcp.ts` 의 `resolveBoardId` 참고).
   *
   * 반대로 `rocky#12`/raw id/id-prefix 처럼 board 컨텍스트를 아예 안 쓰는 ref 에는
   * 안 풀리는 `?board=` 를 무시한다 — CLI 가 모든 단건 라우트에 cwd 로 유추한
   * `?board=` 를 무조건 붙이는데, 보드가 지연 생성이라(add/section add/board add
   * 만 만든다) 흔히 존재하지 않는 키가 실려온다. ref 자체가 보드를 특정하는 경우까지
   * 그 무관한 오타로 막으면 안 된다(finding: 이전 웨이브가 이 가드를 ref 를 보기도
   * 전에 걸어 `rocky#12` 조회까지 400 을 내던 회귀).
   */
  const currentBoardIdOf = (url: URL, ref: string): string | undefined => {
    const key = url.searchParams.get('board');
    if (!key) {
      return undefined;
    }
    const boardId = store.boardIdOf(key);
    if (!boardId) {
      if (refNeedsBoardContext(ref)) {
        throw new Error(`unknown board: ${key}`);
      }
      return undefined;
    }
    return boardId;
  };

  // ref 직렬화(withRef)는 './refs' 공유 모듈로 옮겼다 — MCP 도구도 같은 로직을 쓴다
  // (finding: MCP 응답이 number/ref 를 안 실어 REST 와 계약이 갈라졌던 문제).
  // boardId 가 있는데 board 를 못 찾으면 refs.ts 의 refOf 가 던진다 — 아래 catch →
  // toHttpError 경유로 400 이 된다 (조용히 위조 글로벌 참조를 만들지 않기 위함).

  const fetch = async (req: Request, peerAddress?: string): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method.toUpperCase();
    const actor = req.headers.get('x-rocky-actor') ?? 'unknown';
    const local = isLocalRequest(req, peerAddress);

    try {
      // ── health ──
      if (method === 'GET' && path === '/api/health') {
        // version 은 "지금 돌고 있는 코드"의 버전이다 — 플러그인 캐시가 버전 디렉터리라
        // 데몬이 구버전 경로에서 계속 살아있을 수 있어, 호출자가 stale 을 판별할 근거가 된다.
        // issueCreateAllowed 는 이 요청과 같은 출처에서 이슈 생성이 가능한지다 — 웹 UI 가
        // 없는 버튼을 그리지 않도록 미리 보는 힌트일 뿐, 강제는 이슈 라우트 자신이 한다.
        return json({
          ok: true,
          name: 'rocky-todo',
          version: pkg.version,
          pid: process.pid,
          issueCreateAllowed: local,
        });
      }

      // ── SSE ──
      if (method === 'GET' && path === '/api/events') {
        return sseResponse(store);
      }

      // ── boards ──
      if (method === 'GET' && path === '/api/boards') {
        return json(store.listBoards(url.searchParams.get('includeArchived') === 'true'));
      }
      if (method === 'POST' && path === '/api/boards') {
        const body = await readBody(req);
        if (typeof body.key !== 'string' || body.key === '') {
          return errorResponse('key is required', 400);
        }
        return json(
          store.ensureBoard(body.key, {
            title: typeof body.title === 'string' ? body.title : undefined,
            actor,
          }),
          201,
        );
      }

      const boardDetail = path.match(/^\/api\/boards\/([^/]+)$/);
      if (boardDetail?.[1] && method === 'PATCH') {
        const body = await readBody(req);
        if (typeof body.repo !== 'string' || !isRepoSlug(body.repo)) {
          return errorResponse('repo must look like OWNER/NAME', 400);
        }
        return json(
          store.setBoardRepo(decodeURIComponent(boardDetail[1]), body.repo.trim(), actor),
        );
      }

      // ── sections ──
      if (method === 'GET' && path === '/api/sections') {
        const boardKey = url.searchParams.get('board');
        if (!boardKey) {
          return errorResponse('board query parameter is required', 400);
        }
        const boardId = store.boardIdOf(boardKey);
        if (!boardId) {
          return json([]);
        }
        return json(store.listSections(boardId));
      }
      if (method === 'POST' && path === '/api/sections') {
        const body = await readBody(req);
        if (typeof body.board !== 'string' || body.board === '') {
          return errorResponse('board is required', 400);
        }
        const title = typeof body.title === 'string' ? body.title.trim() : '';
        if (title === '') {
          return errorResponse('title is required', 400);
        }
        // 없는 보드를 자동 생성하지 않는다 — 섹션은 이미 있는 보드에 붙이는 것이고,
        // 오타난 board key 로 빈 보드가 생기는 편이 조용한 사고가 된다.
        const boardId = store.boardIdOf(body.board);
        if (!boardId) {
          return errorResponse(`board not found: ${body.board}`, 404);
        }
        return json(store.ensureSection(boardId, title, actor), 201);
      }

      const sectionArchive = path.match(/^\/api\/sections\/([^/]+)\/archive$/);
      if (sectionArchive?.[1] && method === 'POST') {
        // 섹션은 id 로만 지정한다 — 이름은 보드 안에서만 유일해 REST 경로로 쓰기 애매하다.
        store.archiveSection(decodeURIComponent(sectionArchive[1]), actor);
        return json({ ok: true });
      }

      // ── todos ──
      if (method === 'GET' && path === '/api/todos') {
        const filter: ListTodosFilter = {
          board: url.searchParams.get('board') ?? undefined,
          status: (url.searchParams.get('status') as ListTodosFilter['status']) ?? undefined,
          label: url.searchParams.get('label') ?? undefined,
          includeArchived: url.searchParams.get('includeArchived') === 'true',
        };
        return json(store.listTodos(filter).map((todo) => withRef(store, todo)));
      }
      if (method === 'POST' && path === '/api/todos') {
        const body = await readBody(req);
        if (typeof body.title !== 'string' || body.title === '') {
          return errorResponse('title is required', 400);
        }
        if (typeof body.board !== 'string' || body.board === '') {
          return errorResponse('board is required', 400);
        }
        const todo = store.createTodo(
          {
            board: body.board,
            title: body.title,
            description: typeof body.description === 'string' ? body.description : undefined,
            section: typeof body.section === 'string' ? body.section : undefined,
            parentId: typeof body.parentId === 'string' ? body.parentId : undefined,
            priority: body.priority as never,
            due: typeof body.due === 'string' ? body.due : undefined,
            labels: Array.isArray(body.labels) ? (body.labels as string[]) : undefined,
            links: Array.isArray(body.links) ? (body.links as never) : undefined,
          },
          actor,
        );
        return json(withRef(store, todo), 201);
      }

      const todoDetail = path.match(/^\/api\/todos\/([^/]+)$/);
      if (todoDetail?.[1]) {
        const ref = decodeURIComponent(todoDetail[1]);
        const currentBoardId = currentBoardIdOf(url, ref);
        if (method === 'GET') {
          const todo = store.getTodo(ref, currentBoardId);
          if (!todo) {
            return errorResponse(`todo not found: ${ref}`, 404);
          }
          const includeArchived = url.searchParams.get('includeArchived') === 'true';
          return json({
            todo: withRef(store, todo),
            history: store.listHistory({
              entityId: todo.id,
              excludeActions: DETAIL_HISTORY_EXCLUDED,
            }),
            comments: store.listComments(todo.id, includeArchived),
          });
        }
        if (method === 'PATCH') {
          const body = await readBody(req);
          return json(withRef(store, store.updateTodo(ref, body as never, actor, currentBoardId)));
        }
      }

      const todoStatus = path.match(/^\/api\/todos\/([^/]+)\/status$/);
      if (todoStatus?.[1] && method === 'POST') {
        const ref = decodeURIComponent(todoStatus[1]);
        const currentBoardId = currentBoardIdOf(url, ref);
        const body = await readBody(req);
        const action = body.action;
        if (typeof action !== 'string' || !STATUS_ACTIONS.has(action)) {
          return errorResponse(`invalid action: ${String(action)}`, 400);
        }
        return json(
          withRef(store, store.setTodoStatus(ref, action as StatusAction, actor, currentBoardId)),
        );
      }

      const todoIssue = path.match(/^\/api\/todos\/([^/]+)\/issue$/);
      if (todoIssue?.[1] && method === 'POST') {
        // 출처 검사가 가장 먼저다 — 인가 판정이므로 todo 존재 여부보다 앞서야 하고,
        // 그래야 노출된 표면에 어떤 ref 가 있는지도 흘리지 않는다. 노출(`todo.expose`)은
        // 보드에 대한 것이고, 데몬 사용자의 gh 인증까지 노출하는 것이 아니다.
        if (!local) {
          return errorResponse(NON_LOCAL_ISSUE_MESSAGE, 403);
        }
        const ref = decodeURIComponent(todoIssue[1]);
        const currentBoardId = currentBoardIdOf(url, ref);
        const todo = store.getTodo(ref, currentBoardId);
        if (!todo) {
          return errorResponse(`todo not found: ${ref}`, 404);
        }
        // 중복은 409 로 구분한다 — 400(설정/실행 실패)과 원인이 전혀 다르고, 웹 UI 가
        // "이미 있음"을 별도로 다뤄야 한다. 판별은 `findIssueLink` 하나를 공유한다.
        const existing = findIssueLink(todo.links);
        if (existing) {
          return alreadyHasIssue(existing);
        }
        // repo 는 옵션 — 클라이언트가 어느 보드가 todo 를 소유하는지 추측해 PATCH 하던
        // 옛 경로(findings A/C)를 없앤 자리다. body 자체가 없을 수도 있어(CLI 기본 경로,
        // 웹 UI 의 board.repo 이미 설정된 경로) `readOptionalBody` 로 받는다.
        const body = await readOptionalBody(req);
        let repo: string | undefined;
        if (body && 'repo' in body) {
          if (typeof body.repo !== 'string' || !isRepoSlug(body.repo)) {
            return errorResponse('repo must look like OWNER/NAME', 400);
          }
          repo = body.repo.trim();
        }
        try {
          const result = createIssueForTodo(store, ref, { actor, currentBoardId, run, repo });
          return json({ url: result.url, todo: withRef(store, result.todo) }, 201);
        } catch (error) {
          // 위 사전 검사와 orchestrator 의 재검사 사이에는 `readOptionalBody` 의 await 이
          // 있다 — 같은 todo 로 두 요청이 겹치면 둘 다 사전 검사를 통과하고, 먼저 끝난
          // 쪽이 링크를 붙인 뒤 나중 쪽이 orchestrator 안에서 걸린다. 같은 "이미 있음"이
          // 타이밍에 따라 409/400 으로 갈리지 않게 여기서도 409 로 매핑한다.
          if (error instanceof IssueAlreadyExistsError) {
            return alreadyHasIssue(error.url);
          }
          // 그 밖의 실패(repo 미설정, `gh` 실패 등)는 항상 400 이다 — `toHttpError` 로
          // 흘려보내면 `gh` 의 "HTTP 404: Not Found (api.github.com/...)" 같은 메시지가
          // `/not found/i` 에 걸려, 이 라우트에서 404 는 "todo not found" 라는 계약을
          // 깬다(finding F).
          const message = error instanceof Error ? error.message : String(error);
          return errorResponse(message, 400);
        }
      }

      // ── comments ──
      const todoComments = path.match(/^\/api\/todos\/([^/]+)\/comments$/);
      if (todoComments?.[1] && method === 'POST') {
        const ref = decodeURIComponent(todoComments[1]);
        const currentBoardId = currentBoardIdOf(url, ref);
        const body = await readBody(req);
        if (typeof body.body !== 'string') {
          return errorResponse('body is required', 400);
        }
        return json(store.addComment(ref, body.body, actor, currentBoardId), 201);
      }

      // 보관/복원 경로가 세그먼트를 하나 더 갖기 때문에 이 정확 일치 패턴과 겹치지 않는다.
      const commentDetail = path.match(/^\/api\/comments\/([^/]+)$/);
      if (commentDetail?.[1] && method === 'PATCH') {
        const body = await readBody(req);
        if (typeof body.body !== 'string') {
          return errorResponse('body is required', 400);
        }
        return json(store.updateComment(decodeURIComponent(commentDetail[1]), body.body, actor));
      }

      const commentArchive = path.match(/^\/api\/comments\/([^/]+)\/(archive|unarchive)$/);
      if (commentArchive?.[1] && commentArchive[2] && method === 'POST') {
        return json(
          store.setCommentArchived(
            decodeURIComponent(commentArchive[1]),
            commentArchive[2] === 'archive',
            actor,
          ),
        );
      }

      // ── notes ──
      if (method === 'GET' && path === '/api/notes') {
        return json(
          store
            .listNotes({
              board: url.searchParams.get('board') ?? undefined,
              global: url.searchParams.get('global') === 'true',
              includeArchived: url.searchParams.get('includeArchived') === 'true',
            })
            .map((note) => withRef(store, note)),
        );
      }
      if (method === 'POST' && path === '/api/notes') {
        const body = await readBody(req);
        if (typeof body.title !== 'string' || body.title === '') {
          return errorResponse('title is required', 400);
        }
        const note = store.createNote(
          {
            board: typeof body.board === 'string' ? body.board : undefined,
            title: body.title,
            content: typeof body.content === 'string' ? body.content : undefined,
          },
          actor,
        );
        return json(withRef(store, note), 201);
      }

      const noteDetail = path.match(/^\/api\/notes\/([^/]+)$/);
      if (noteDetail?.[1]) {
        const ref = decodeURIComponent(noteDetail[1]);
        const currentBoardId = currentBoardIdOf(url, ref);
        if (method === 'GET') {
          const note = store.getNote(ref, currentBoardId);
          if (!note) {
            return errorResponse(`note not found: ${ref}`, 404);
          }
          return json({
            note: withRef(store, note),
            history: store.listHistory({ entityId: note.id }),
          });
        }
        if (method === 'PATCH') {
          const body = await readBody(req);
          return json(withRef(store, store.updateNote(ref, body as never, actor, currentBoardId)));
        }
      }

      const noteArchive = path.match(/^\/api\/notes\/([^/]+)\/(archive|unarchive)$/);
      if (noteArchive?.[1] && noteArchive[2] && method === 'POST') {
        const ref = decodeURIComponent(noteArchive[1]);
        const currentBoardId = currentBoardIdOf(url, ref);
        return json(
          withRef(
            store,
            noteArchive[2] === 'archive'
              ? store.archiveNote(ref, actor, currentBoardId)
              : store.unarchiveNote(ref, actor, currentBoardId),
          ),
        );
      }

      // ── changes feed (훅 주입용) ──
      if (method === 'GET' && path === '/api/changes') {
        const sinceId = Number(url.searchParams.get('sinceId') ?? '0');
        if (!Number.isInteger(sinceId) || sinceId < 0) {
          return errorResponse('sinceId must be a non-negative integer', 400);
        }
        const limit = url.searchParams.has('limit')
          ? Number(url.searchParams.get('limit'))
          : undefined;
        return json(store.listChangesSince(sinceId, limit));
      }

      // ── history ──
      if (method === 'GET' && path === '/api/history') {
        return json(
          store.listHistory({
            entityId: url.searchParams.get('entityId') ?? undefined,
            entity: (url.searchParams.get('entity') as never) ?? undefined,
            limit: url.searchParams.has('limit')
              ? Number(url.searchParams.get('limit'))
              : undefined,
          }),
        );
      }

      return errorResponse(`not found: ${method} ${path}`, 404);
    } catch (error) {
      return toHttpError(error);
    }
  };

  return { fetch };
}

/** store change 이벤트를 SSE 로 흘린다 — 웹 UI 실시간 갱신 경로. */
function sseResponse(store: TodoStore): Response {
  let unsubscribe: (() => void) | undefined;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(': connected\n\n'));
      unsubscribe = store.subscribe((event) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          // 스트림이 이미 닫힌 경우 — cancel 경로에서 구독 해제된다.
        }
      });
    },
    cancel() {
      unsubscribe?.();
    },
  });
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    },
  });
}
