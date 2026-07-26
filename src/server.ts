import pkg from '../package.json' with { type: 'json' };
import { refNeedsBoardContext, withRef } from './refs';
import { createCachedListSessions, matchBoard, type SessionsResult } from './sessions';
import {
  DETAIL_HISTORY_EXCLUDED,
  type HandoffStatus,
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
  /**
   * 활성 세션 조회 — 테스트에서 주입한다. 기본은 `claude agents --json` 을 TTL 3초로
   * 메모이즈한 버전(`createCachedListSessions`) — 주입된 함수는 캐시를 거치지 않는다
   * (테스트가 호출 횟수에 의존할 수 있고, 주입의 목적 자체가 결정론이다).
   */
  sessions?: () => SessionsResult;
  /**
   * 이 요청이 루프백(127.0.0.1/::1)에서 왔는가. 기본은 항상 true(루프백으로 간주) —
   * `Request` 객체만으로는 원격 주소를 알 수 없어(정보는 `Bun.serve` 가 반환하는
   * `server.requestIP(req)` 에만 있다) 데몬 조립 지점(`daemon.ts`)이 실제 판별해
   * 주입한다. 기본값을 true 로 둬야 이 옵션을 안 넘기는 기존 테스트/DI 가 그대로 돈다.
   * `POST /api/handoffs/claim` 전용 가드 — 훅은 항상 127.0.0.1 로 붙으므로 이 판정에
   * 기능 손실이 없다.
   */
  isLoopback?: (req: Request) => boolean;
}

// TodoView/NoteView 는 REST·MCP 가 공유하는 './refs' 가 정의한다 — 여기서 재수출해
// CLI(`import type { NoteView, TodoView } from './server'`) 등 기존 import 경로를 보존한다.
export type { NoteView, TodoView } from './refs';

export interface TodoServer {
  fetch: (req: Request) => Promise<Response>;
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

/** not found 류 스토어 에러를 HTTP status 로 번역한다. */
function toHttpError(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  if (/not found/i.test(message)) {
    return errorResponse(message, 404);
  }
  return errorResponse(message, 400);
}

export function buildTodoServer(options: TodoServerOptions): TodoServer {
  const { store } = options;
  const sessionsOf = options.sessions ?? createCachedListSessions();
  const isLoopbackOf = options.isLoopback ?? (() => true);

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

  const fetch = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method.toUpperCase();
    const actor = req.headers.get('x-rocky-actor') ?? 'unknown';

    try {
      // ── health ──
      if (method === 'GET' && path === '/api/health') {
        // version 은 "지금 돌고 있는 코드"의 버전이다 — 플러그인 캐시가 버전 디렉터리라
        // 데몬이 구버전 경로에서 계속 살아있을 수 있어, 호출자가 stale 을 판별할 근거가 된다.
        return json({ ok: true, name: 'rocky-todo', version: pkg.version, pid: process.pid });
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

      const todoHandoff = /^\/api\/todos\/([^/]+)\/handoff$/.exec(path);
      if (todoHandoff?.[1] && method === 'POST') {
        const ref = decodeURIComponent(todoHandoff[1]);
        const body = await readBody(req);
        const note = typeof body.note === 'string' ? body.note : undefined;
        const currentBoardId = currentBoardIdOf(url, ref);
        const todo = store.getTodo(ref, currentBoardId);
        if (!todo) {
          return errorResponse(`todo not found: ${ref}`, 404);
        }
        if (store.pendingHandoffOf(todo.id)) {
          return errorResponse(`이 항목은 이미 다른 세션 앞에 대기 중이다: ${ref}`, 409);
        }

        const result = sessionsOf();
        if (!result.available) {
          return errorResponse(result.reason ?? '활성 세션 목록을 가져올 수 없다', 409);
        }

        let target = result.sessions.find((s) => s.sessionId === body.sessionId);
        if (typeof body.sessionId === 'string' && !target) {
          return errorResponse(`활성 세션이 아니다: ${body.sessionId}`, 400);
        }
        if (!target) {
          // 자동 매칭 — 후보가 정확히 하나일 때만 보낸다. 애매하면 사용자에게 되묻는다.
          const boardKey = store.listBoards(true).find((b) => b.id === todo.boardId)?.key ?? '';
          const candidates = matchBoard(result.sessions, boardKey);
          const [only, ...rest] = candidates;
          if (!only || rest.length > 0) {
            return json(
              {
                error:
                  candidates.length === 0
                    ? `"${boardKey}" 에 해당하는 활성 세션이 없다 — 대상을 직접 고르라`
                    : `"${boardKey}" 후보가 ${candidates.length}개다 — 대상을 직접 고르라`,
                candidates: candidates.length > 0 ? candidates : result.sessions,
              },
              409,
            );
          }
          target = only;
        }

        const handoff = store.createHandoff({
          ref,
          sessionId: target.sessionId,
          sessionName: target.name,
          sessionCwd: target.cwd,
          note,
          actor,
          currentBoardId,
        });
        return json(handoff, 201);
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

      // ── sessions ──
      if (method === 'GET' && path === '/api/sessions') {
        const result = sessionsOf();
        const boardKey = url.searchParams.get('board');
        const matched = boardKey
          ? new Set(matchBoard(result.sessions, boardKey).map((s) => s.sessionId))
          : null;
        return json({
          available: result.available,
          reason: result.reason,
          sessions: result.sessions.map((session) => ({
            ...session,
            matched: matched ? matched.has(session.sessionId) : false,
          })),
        });
      }

      // ── handoffs ──
      if (method === 'POST' && path === '/api/handoffs/claim') {
        // 훅(Stop/UserPromptSubmit)만 이 라우트를 부르고, 훅은 항상 127.0.0.1 로 붙는다
        // — 루프백 제한에 기능 손실이 0 이다. `todo.expose` 로 lan/tailscale-serve 를
        // 열어도 "보내기"·세션 목록은 그대로 원격에서 되지만, claim 을 열어두면 남의
        // 큐를 조용히 소진(delivered 처리)해 배달을 무력화하는 경로가 된다. 404 로 막는
        // 이유: 이 라우트의 존재 자체를 원격 관찰자에게 드러내지 않기 위해서다 — 아래
        // catch-all(`not found: METHOD path`)과 구분이 안 가게 해, 있는 걸 알고 두드리는
        // 시나리오를 403(있는데 막혔다)보다 덜 흥미롭게 만든다.
        if (!isLoopbackOf(req)) {
          return errorResponse(`not found: ${method} ${path}`, 404);
        }
        const body = await readBody(req);
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
        const via = body.via === 'prompt' ? 'prompt' : 'stop';
        if (sessionId === '') {
          return errorResponse('sessionId is required', 400);
        }
        const claimed = store.claimHandoff(sessionId, via);
        return claimed ? json(claimed) : new Response(null, { status: 204 });
      }

      if (method === 'GET' && path === '/api/handoffs') {
        const boardKey = url.searchParams.get('board');
        const boardId = boardKey ? store.boardIdOf(boardKey) : undefined;
        const status = url.searchParams.get('status') as HandoffStatus | null;
        const handoffs = store.listHandoffs({
          boardId,
          status: status ?? undefined,
        });
        // 대상 세션이 사라진 pending 은 stale 로 표시만 한다 — 자동 만료는 "보냈는데
        // 조용히 사라졌다"를 만들고, 그게 이 기능에서 가장 나쁜 실패다.
        // stale 판정은 pending 건에만 의미가 있다 — pending 이 하나도 없으면 세션 조회
        // (기본 구현은 `claude agents --json` spawn, 실측 ~220ms, 최악 timeout 5s) 를
        // 아예 건너뛴다. 이 라우트는 웹 UI `refetch` 가 SSE 이벤트·60초 tick·모든
        // mutation 뒤에 부르므로, pending 이 없는 대다수 호출에서 그 비용을 없앤다.
        const hasPending = handoffs.some((handoff) => handoff.status === 'pending');
        const live = hasPending
          ? new Set(sessionsOf().sessions.map((s) => s.sessionId))
          : new Set<string>();
        return json(
          handoffs.map((handoff) => ({
            ...handoff,
            stale: handoff.status === 'pending' && !live.has(handoff.sessionId),
          })),
        );
      }

      const handoffCancel = /^\/api\/handoffs\/([^/]+)\/cancel$/.exec(path);
      if (handoffCancel?.[1] && method === 'POST') {
        return json(store.cancelHandoff(handoffCancel[1], actor));
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
