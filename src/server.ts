import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import pkg from '../package.json' with { type: 'json' };
import {
  createIssueForTodo,
  findIssueLink,
  IssueAlreadyExistsError,
  isRepoSlug,
  type RunCommand,
} from './github';
import { buildHandoffPromptFrom } from './handoff';
import { isLocalRequest, NON_LOCAL_ISSUE_MESSAGE, NON_LOCAL_SPAWN_MESSAGE } from './local-request';
import { refNeedsBoardContext, refOf, withRef } from './refs';
import {
  createCachedListSessions,
  listSessions,
  matchBoard,
  type SessionsResult,
} from './sessions';
import {
  createRecentSpawns,
  findLiveSessionAt,
  type RecentSpawns,
  type SpawnInput,
  spawnBackgroundSession,
  SpawnFailedError,
  worktreeNameFor,
  worktreePathFor,
} from './spawn';
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
  /** 외부 명령 실행자 — 테스트가 fake 를 넣는다. 생략하면 실제 `gh` 를 부른다. */
  run?: RunCommand;
  /**
   * 활성 세션 조회 — 테스트에서 주입한다. 기본은 `claude agents --json` 을 TTL 3초로
   * 메모이즈한 버전(`createCachedListSessions`) — 주입된 함수는 캐시를 거치지 않는다
   * (테스트가 호출 횟수에 의존할 수 있고, 주입의 목적 자체가 결정론이다).
   */
  sessions?: () => SessionsResult;
  /**
   * spawn 라우트 전용 세션 조회 — 기본은 **캐시 없는** `listSessions` 다.
   *
   * 동시 실행 가드는 이 설계의 유일한 안전 속성인데, TTL 3초 캐시로 보면 spawn 직전
   * 3초 안의 다른 요청이 채워둔 **spawn 이전 스냅샷**으로 판정하게 된다. spawn 은 사람이
   * 버튼을 누를 때만 도는 드문 경로라 실측 ~220ms 를 매번 무는 편이 낫다.
   *
   * 생략하면 `sessions` 주입값을 그대로 쓴다 — 테스트가 `sessions` 만 넣었을 때 spawn
   * 라우트도 그 결정론적 목록을 보게 하려는 것이다.
   */
  spawnSessions?: () => SessionsResult;
  /**
   * 백그라운드 세션 기동 — 테스트 주입용. 기본은 실제 `claude --bg` 를 띄운다.
   * 짧은 id 를 돌려주고, 실패하면 던진다(reject).
   */
  spawn?: (input: SpawnInput) => Promise<string>;
  /**
   * 경로 존재 검사 — 테스트 주입용. 기본은 `existsSync`.
   * spawn 라우트가 `boards.path` 가 실재하는 git 워크트리인지 보는 데만 쓴다.
   */
  pathExists?: (path: string) => boolean;
  /**
   * 경로 정규화 — 테스트 주입용. 기본은 `realpathSync`(없는 경로면 던진다).
   *
   * 심볼릭 링크나 `..` 이 섞인 `boards.path` 를 그대로 두면 `agents --json` 이 보고하는
   * 실경로와 문자열이 달라 동시 실행 가드(`findLiveSessionAt` 의 정확 일치 비교)가
   * 조용히 무력화된다.
   */
  realPath?: (path: string) => string;
  /**
   * 방금 띄운 워크트리 기억 — 테스트 주입용(시계를 통제하려면 `createRecentSpawns` 참고).
   * 기본은 데몬 수명 동안만 사는 TTL 60초 창.
   */
  recentSpawns?: RecentSpawns;
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

/**
 * spawn 라우트가 볼 세션 조회기를 고른다 — 이 배선 규칙이 사는 유일한 자리다.
 *
 * 주입이 하나도 없으면 **캐시 없는** `listSessions` 다. `daemon.ts` 가 나중에
 * `sessions: createCachedListSessions()` 를 넘기더라도 spawn 라우트가 조용히 캐시된
 * (= spawn 이전) 스냅샷으로 판정하는 일이 없게, 기본값을 `sessions` 와 분리해 둔다.
 *
 * @param list 기본 조회기 — 테스트가 호출 횟수를 세려고 주입한다. 기본은 매 호출
 *   `claude agents --json` 을 새로 부르는 `listSessions`.
 */
export function resolveSpawnSessions(
  options: Pick<TodoServerOptions, 'sessions' | 'spawnSessions'>,
  list: () => SessionsResult = () => listSessions(),
): () => SessionsResult {
  return options.spawnSessions ?? options.sessions ?? list;
}

export function buildTodoServer(options: TodoServerOptions): TodoServer {
  const { store, run } = options;
  const sessionsOf = options.sessions ?? createCachedListSessions();
  // spawn 라우트만 캐시를 우회한다 — 가드가 spawn 이전 스냅샷을 보면 안 된다.
  const spawnSessionsOf = resolveSpawnSessions(options);
  const spawnSession = options.spawn ?? ((input: SpawnInput) => spawnBackgroundSession(input));
  const pathExists = options.pathExists ?? existsSync;
  const realPath = options.realPath ?? realpathSync;
  const recentSpawns = options.recentSpawns ?? createRecentSpawns();

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
          // spawn 도 이슈 생성과 같은 등급의 로컬 전용 게이트다 — UI 가 없는 버튼을
          // 그리지 않도록 미리 보는 힌트일 뿐, 강제는 spawn 라우트 자신이 한다.
          spawnAllowed: local,
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
        const key = decodeURIComponent(boardDetail[1]);
        // 두 필드는 서로 독립이다 — 하나만 보내는 것이 정상이고, 둘 다 없으면 400.
        if (typeof body.path === 'string') {
          if (body.path.trim() === '') {
            return errorResponse('path must not be empty', 400);
          }
          return json(store.setBoardPath(key, body.path.trim(), actor));
        }
        if (typeof body.repo !== 'string' || !isRepoSlug(body.repo)) {
          return errorResponse('repo must look like OWNER/NAME', 400);
        }
        return json(store.setBoardRepo(key, body.repo.trim(), actor));
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

        // sessionId 를 보냈으면 문자열이어야 한다. 타입만 틀렸을 때 조용히 자동 매칭으로
        // 떨어뜨리면, 특정 세션을 지정했다고 믿는 호출자의 요청이 **다른 세션**으로 간다.
        if (body.sessionId !== undefined && typeof body.sessionId !== 'string') {
          return errorResponse('sessionId must be a string', 400);
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

      const todoSpawn = /^\/api\/todos\/([^/]+)\/spawn$/.exec(path);
      if (todoSpawn?.[1] && method === 'POST') {
        // 이슈 생성과 같은 등급의 게이트다 — 보드 쓰기 권한이 "이 기계에서 파일을 고치는
        // 프로세스를 띄우는 권한" 으로 확대되는 지점이라 `todo.expose` 와 무관하게 막는다.
        if (!local) {
          return errorResponse(NON_LOCAL_SPAWN_MESSAGE, 403);
        }
        const ref = decodeURIComponent(todoSpawn[1]);
        const body = await readOptionalBody(req);
        const note = typeof body?.note === 'string' ? body.note : undefined;
        const currentBoardId = currentBoardIdOf(url, ref);
        const todo = store.getTodo(ref, currentBoardId);
        if (!todo) {
          return errorResponse(`todo not found: ${ref}`, 404);
        }
        if (todo.archivedAt) {
          return errorResponse(`todo is archived: ${ref}`, 400);
        }
        if (store.pendingHandoffOf(todo.id)) {
          return errorResponse(`이 항목은 이미 다른 세션 앞에 대기 중이다: ${ref}`, 409);
        }

        // path 는 선택 — 주면 이번 spawn 에 한해 boards.path 를 덮어쓰고, **spawn 이
        // 성공한 뒤에만** 영구 저장한다(아래 persistPathIfGiven). `IssueAction`/
        // `createIssueForTodo` 와 같은 모양이다 — 저장을 먼저 하면 오타난 경로가 spawn
        // 실패와 무관하게 보드에 눌어붙어 다른 todo·다른 탭까지 같은 실패를 물려받는다.
        let pathOverride: string | undefined;
        if (body && 'path' in body) {
          if (typeof body.path !== 'string' || body.path.trim() === '') {
            return errorResponse('path must be a non-empty string', 400);
          }
          pathOverride = body.path.trim();
        }

        const board = store.listBoards(true).find((b) => b.id === todo.boardId);
        const rawBoardPath = pathOverride ?? board?.path ?? '';
        if (rawBoardPath === '') {
          return errorResponse(
            `보드 "${board?.key ?? ''}" 에 메인 레포 경로가 없다 — rocky-todo board path <절대경로> 로 설정하라`,
            400,
          );
        }
        // 상대경로는 데몬 프로세스의 cwd 기준으로 풀린다 — 데몬은 launchd/훅이 임의의
        // 자리에서 띄우므로 사용자가 의도하지 않은 레포에서 세션이 뜬다. 막는다.
        if (!isAbsolute(rawBoardPath)) {
          return errorResponse(
            `보드 경로는 절대경로여야 한다 — 데몬의 cwd 는 예측할 수 없다: ${rawBoardPath}`,
            400,
          );
        }
        // 심볼릭 링크·`..` 을 여기서 걷어낸다. 이 값 하나가 워크트리 경로 계산·spawn 실행
        // cwd·보드 저장에 전부 쓰여야 `agents --json` 의 실경로와 문자열 비교가 성립한다.
        // 워크트리는 아직 없을 수 있으므로 realpath 는 보드 경로에만 적용한다.
        let boardPath: string;
        try {
          boardPath = realPath(rawBoardPath.replace(/\/+$/, ''));
        } catch {
          return errorResponse(`경로를 찾을 수 없다: ${rawBoardPath}`, 400);
        }
        if (!pathExists(`${boardPath.replace(/\/+$/, '')}/.git`)) {
          return errorResponse(`git 워크트리가 아니다: ${boardPath}`, 400);
        }

        const worktreePath = worktreePathFor(boardPath, todo.number);

        // 캐시를 우회해도 "새 세션이 `agents --json` 에 등록되기까지의 지연" 은 남는다.
        // 그 창에서의 재요청은 409 로 끊는다 — 재사용 분기로 보내면 짧은 id 로 pending 이
        // 만들어져 영영 배달되지 않는다(claim 은 full UUID 로 한다).
        if (recentSpawns.isRecent(worktreePath)) {
          return errorResponse(
            `방금 이 워크트리에 세션을 띄웠다 — 잠시 후 다시 시도하라: ${worktreePath}`,
            409,
          );
        }

        // handoff 라우트와 같은 코드로 답한다 — 두 엔드포인트를 함께 쓰는 호출자가 같은
        // 실패에 두 가지 코드를 다루지 않게.
        const sessions = spawnSessionsOf();
        if (!sessions.available) {
          return errorResponse(sessions.reason ?? '활성 세션 목록을 가져올 수 없다', 409);
        }

        const todoRef = refOf(store, todo.boardId, todo.number, todo.id);

        // pathOverride 가 주어졌고 여기까지 왔다는 건 그 값으로 워크트리 경로를 구성해
        // 존재 검사까지 통과했다는 뜻이다 — 유효함이 입증됐으니 저장한다. 저장하는 값은
        // 정규화된 쪽이다(보드에 남는 경로가 가드가 비교하는 경로와 같아야 한다). 재사용
        // 분기도 예외가 아니다(그 경로로 워크트리를 찾아 살아있는 세션을 판정했으니 옳다).
        const persistPathIfGiven = (): void => {
          if (pathOverride !== undefined && board) {
            store.setBoardPath(board.key, boardPath, actor);
          }
        };

        // 그 워크트리에서 이미 도는 세션이 있으면 새로 띄우지 않는다 — 두 에이전트가 한
        // 워크트리를 같이 고치는 것을 막는 가드이자, 곧 "세션 재사용" 이다. 이때는 평범한
        // pending 핸드오프를 만들어 그 세션의 다음 Stop 훅이 집게 한다.
        const live = findLiveSessionAt(sessions.sessions, worktreePath);
        if (live) {
          const handoff = store.createHandoff({
            ref,
            sessionId: live.sessionId,
            sessionName: live.name,
            sessionCwd: live.cwd,
            note,
            actor,
            currentBoardId,
          });
          persistPathIfGiven();
          return json({ handoff, reused: true, worktreePath }, 201);
        }

        const sessionName = `${board?.key ?? 'todo'}-${todo.number}`;
        // 예약은 실행 **전에**, 이 동기 구간에서 잡는다. `await spawnSession` 뒤로 미루면
        // 그 창에 겹쳐 들어온 두 요청이 위 게이트를 나란히 통과해 한 워크트리에 두
        // 에이전트가 붙는다 — 이 설계의 유일한 안전 속성이 거기서 무너진다.
        recentSpawns.remember(worktreePath);
        let shortId: string;
        try {
          shortId = await spawnSession({
            boardPath,
            worktreeName: worktreeNameFor(todo.number),
            sessionName,
            prompt: buildHandoffPromptFrom({
              actor,
              note: (note ?? '').trim(),
              todoRef,
              todoTitle: todo.title,
              remaining: 0,
            }),
          });
        } catch (error) {
          // 예약은 **확실히 안 떴을 때만** 되돌린다. "떴는지 모른다"(마감 초과·출력 형식
          // 변화)에서 풀면, 세션은 떴는데 `agents --json` 에는 아직 안 보이는 창에 사용자가
          // 다시 눌러 한 워크트리에 두 에이전트가 붙는다 — 예약이 있는 이유가 그 지연이다.
          // 분류가 없는 에러(예기치 못한 버그)도 모르는 쪽으로 둔다: 헛되이 60초 기다리는
          // 비용보다 동시 실행의 비용이 훨씬 크다.
          if (error instanceof SpawnFailedError && error.started === false) {
            recentSpawns.forget(worktreePath);
          }
          return errorResponse(error instanceof Error ? error.message : String(error), 400);
        }

        // 배달 기록·경로 저장은 spawn 이 성공한 뒤에만 남긴다 — 실패한 spawn 이 배달 기록을
        // 남기면 보드가 "보냈다"고 말하는데 아무도 받지 않은 상태가 된다.
        persistPathIfGiven();
        const handoff = store.createSpawnedHandoff({
          ref,
          sessionId: shortId,
          sessionName,
          sessionCwd: worktreePath,
          note,
          actor,
          currentBoardId,
        });
        return json({ handoff, reused: false, worktreePath, sessionShortId: shortId }, 201);
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
        //
        // 판별은 이슈 라우트와 같은 `isLocalRequest` 를 쓴다 — 주소만 보면 부족하다.
        // `lan` 은 데몬이 `0.0.0.0` 에 직접 바인딩해 원격 소스 주소가 진짜 LAN IP 로
        // 찍히지만, `tailscale-serve` 는 데몬을 127.0.0.1 에 두고 tailscaled 가 테일넷
        // 요청을 루프백으로 재다이얼하므로(`src/tailscale.ts` 상단 주석) 주소만으로는
        // 원격과 로컬이 구분되지 않는다. `isLocalRequest` 는 루프백 **그리고** 중계
        // 헤더(`Tailscale-User-*` / `X-Forwarded-*`) 부재를 함께 보므로 두 채널 모두
        // 막는다. 헤더는 위조로 "있게" 만들 수는 있어도 "없게" 만들 수는 없어, 위조는
        // 요청을 덜 신뢰하는 방향으로만 작용한다.
        if (!local) {
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
        // `board` 를 명시했는데 그 키가 스토어에 없으면 **빈 목록**이다 — 필터 생략으로
        // 떨어뜨리면 오타나 지워진 보드 URL 로 다른 보드의 큐까지 보게 된다. 400/404 이
        // 아니라 빈 목록인 이유: 보드는 지연 생성이라(add/board add 만 만든다) CLI 가
        // cwd 로 유추한, 아직 존재하지 않는 키를 흔히 붙인다. 그런 보드에 핸드오프가
        // 있을 수 없으므로 빈 목록이 사실이기도 하다.
        if (boardKey && !boardId) {
          return json([]);
        }
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
        //
        // 세션 목록을 **신뢰할 수 있을 때만** stale 을 판정한다. `claude` 를 못 쓰는
        // 환경(미설치, launchd PATH 누락 등)에서는 `available:false` + 빈 목록이 오는데,
        // 그걸 그대로 대조하면 멀쩡히 살아 있는 세션 앞의 요청까지 전부 "세션 없음" 으로
        // 보인다 — 모른다는 것과 없다는 것은 다르다. 판별할 수 없으면 stale 을 붙이지 않는다.
        const hasPending = handoffs.some((handoff) => handoff.status === 'pending');
        const sessions = hasPending ? sessionsOf() : undefined;
        const live = sessions?.available
          ? new Set(sessions.sessions.map((s) => s.sessionId))
          : undefined;
        return json(
          handoffs.map((handoff) => ({
            ...handoff,
            stale:
              handoff.status === 'pending' && live !== undefined && !live.has(handoff.sessionId),
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
