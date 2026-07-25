import pkg from '../package.json' with { type: 'json' };
import type { ListTodosFilter, Note, StatusAction, Todo, TodoStore } from './store';

/**
 * rocky-todo REST + SSE 표면 — CLI / 웹 UI 가 공유한다.
 *
 * `buildTodoServer` 는 fetch 핸들러만 반환한다 (Bun.serve 바인딩은 daemon.ts 몫)
 * — 테스트에서 Request 를 직접 넣어 계약을 검증할 수 있게 DI 형태를 유지한다.
 * actor 는 `x-rocky-actor` 헤더로 전달된다 (웹 UI 는 localStorage 설정값을 보낸다).
 */

export interface TodoServerOptions {
  store: TodoStore;
}

/** 응답 전용 todo — 저장 모델에 사람이 쓰는 참조(ref)를 얹은 형태. */
export interface TodoView extends Todo {
  /** `rocky#12` — 보드 접두사를 포함한 완전 참조. */
  ref: string;
}

/** 응답 전용 note. 글로벌 메모는 보드 접두사가 없어 `#3` 이 된다. */
export interface NoteView extends Note {
  ref: string;
}

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

  const boardIdByKey = (key: string): string | undefined =>
    store.listBoards(true).find((b) => b.key === key)?.id;

  /** `?board=` 쿼리스트링(보드 key)을 참조 해석에 쓰는 boardId 로 바꾼다. 없으면 undefined. */
  const currentBoardIdOf = (url: URL): string | undefined => {
    const key = url.searchParams.get('board');
    return key ? boardIdByKey(key) : undefined;
  };

  const refOf = (boardId: string | undefined, number: number): string => {
    if (!boardId) {
      return `#${number}`;
    }
    const key = store.boardKeyOf(boardId);
    if (!key) {
      // boardId 는 있는데 boardKeyOf 가 빈 문자열이면 board FK 가 깨진 상태다.
      // 조용히 "#12" 같은 위조 글로벌 참조를 만들면 다른(진짜 글로벌) 엔티티를
      // 가리키는 것과 구분이 안 돼 사고를 부른다 — 명시적으로 실패시킨다
      // (호출자는 아래 catch → toHttpError 경유로 400 을 받는다).
      throw new Error(`cannot build ref: board not found for boardId ${boardId}`);
    }
    return `${key}#${number}`;
  };

  /** 응답용 직렬화 — 저장 모델에 ref 를 얹는다. */
  const withRef = <T extends Todo | Note>(entity: T): T & { ref: string } => ({
    ...entity,
    ref: refOf(entity.boardId, entity.number),
  });

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
        const board = store.listBoards(true).find((b) => b.key === boardKey);
        if (!board) {
          return json([]);
        }
        return json(store.listSections(board.id));
      }

      // ── todos ──
      if (method === 'GET' && path === '/api/todos') {
        const filter: ListTodosFilter = {
          board: url.searchParams.get('board') ?? undefined,
          status: (url.searchParams.get('status') as ListTodosFilter['status']) ?? undefined,
          label: url.searchParams.get('label') ?? undefined,
          includeArchived: url.searchParams.get('includeArchived') === 'true',
        };
        return json(store.listTodos(filter).map(withRef));
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
        return json(withRef(todo), 201);
      }

      const todoDetail = path.match(/^\/api\/todos\/([^/]+)$/);
      if (todoDetail?.[1]) {
        const ref = decodeURIComponent(todoDetail[1]);
        const currentBoardId = currentBoardIdOf(url);
        if (method === 'GET') {
          const todo = store.getTodo(ref, currentBoardId);
          if (!todo) {
            return errorResponse(`todo not found: ${ref}`, 404);
          }
          return json({ todo: withRef(todo), history: store.listHistory({ entityId: todo.id }) });
        }
        if (method === 'PATCH') {
          const body = await readBody(req);
          return json(withRef(store.updateTodo(ref, body as never, actor, currentBoardId)));
        }
      }

      const todoStatus = path.match(/^\/api\/todos\/([^/]+)\/status$/);
      if (todoStatus?.[1] && method === 'POST') {
        const ref = decodeURIComponent(todoStatus[1]);
        const currentBoardId = currentBoardIdOf(url);
        const body = await readBody(req);
        const action = body.action;
        if (typeof action !== 'string' || !STATUS_ACTIONS.has(action)) {
          return errorResponse(`invalid action: ${String(action)}`, 400);
        }
        return json(
          withRef(store.setTodoStatus(ref, action as StatusAction, actor, currentBoardId)),
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
            .map(withRef),
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
        return json(withRef(note), 201);
      }

      const noteDetail = path.match(/^\/api\/notes\/([^/]+)$/);
      if (noteDetail?.[1]) {
        const ref = decodeURIComponent(noteDetail[1]);
        const currentBoardId = currentBoardIdOf(url);
        if (method === 'GET') {
          const note = store.getNote(ref, currentBoardId);
          if (!note) {
            return errorResponse(`note not found: ${ref}`, 404);
          }
          return json({ note: withRef(note), history: store.listHistory({ entityId: note.id }) });
        }
        if (method === 'PATCH') {
          const body = await readBody(req);
          return json(withRef(store.updateNote(ref, body as never, actor, currentBoardId)));
        }
      }

      const noteArchive = path.match(/^\/api\/notes\/([^/]+)\/(archive|unarchive)$/);
      if (noteArchive?.[1] && noteArchive[2] && method === 'POST') {
        const ref = decodeURIComponent(noteArchive[1]);
        const currentBoardId = currentBoardIdOf(url);
        return json(
          withRef(
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
