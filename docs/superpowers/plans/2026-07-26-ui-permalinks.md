# 보드·작업 퍼머링크 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 웹 UI 가 보고 있는 화면(보드 선택 + 열린 todo 상세)을 주소에 담아, 새로고침해도 유지되고 링크로 건넬 수 있게 한다.

**Architecture:** `/{board}/{number}` 경로 문법을 쓴다. 데몬에 `'/*': ui` fallback 라우트를 더해 새로고침이 404 로 끝나지 않게 하고, 보드 키 `api`/`mcp` 를 예약어로 막는다. 라우터 라이브러리는 넣지 않는다 — History API 를 직접 쓰되 파싱·조립·번호해석을 `src/ui/route.ts` 의 순수 함수로 빼서 단위 테스트한다.

**Tech Stack:** Bun + TypeScript(ESM) · `bun:sqlite` · `bun:test` · React 19 + zustand(웹 UI) · Biome. 새 의존성 없음.

## Global Constraints

- 설계 문서: `docs/superpowers/specs/2026-07-26-ui-permalinks-design.md` (승인됨). 이탈 시 문서를 먼저 고친다.
- import 는 전부 상대경로, 확장자 없음. `__dirname` 금지 — `import.meta.dir`/`import.meta.url`.
- **새 런타임 의존성 추가 금지.** 테스트용 dep 도 금지 — 이 레포에는 React 컴포넌트 테스트 하네스가 없다.
- **삭제는 없다** — 아카이브만 존재한다.
- exported 함수/클래스/타입에 JSDoc. 한국어 주석 OK, 코드 식별자·경로·명령·URL 은 영어 원형.
- 게이트: `bun run check` · `bun run typecheck` · `bun test` 세 개가 모두 통과해야 태스크 완료다.
- 커밋 메시지는 Conventional Commits + 한국어 요약 (`feat(ui): …`).
- 작업 브랜치는 `feat/ui-permalinks` (main 기반, 이미 생성됨). `feat/todo-comments`(PR #8)는 건드리지 않는다.
- URL 문법은 정확히 `/` · `/{board}` · `/{board}/{number}` 다. 노트 상세와 뷰 필터(`showArchived`)는 URL 에 싣지 않는다.

## File Structure

| 파일 | 역할 | 태스크 |
| --- | --- | --- |
| `src/ui/route.ts` | **신규.** URL ↔ 화면 상태 변환의 단일 소유자. 순수·DOM 무의존이라 단위 테스트된다 | 1 |
| `src/ui/route.test.ts` | **신규.** route.ts 계약 테스트 | 1 |
| `src/store.ts` | `ensureBoard` 의 예약어 거부 | 2 |
| `src/store.test.ts` | 예약어 거부 테스트 | 2 |
| `src/daemon.ts` | `'/*': ui` fallback 라우트 | 3 |
| `src/ui/store.ts` | URL 쓰기(pushState/replaceState) + `applyRoute` | 4 |
| `src/ui/main.tsx` | `popstate` 구독 + 부팅 시 초기 라우트 적용 | 4 |
| `FEATURES.md` · `docs/rocky-todo.md` | 퍼머링크 문법 문서화 | 5 |

**Task 4 에는 자동 테스트가 없다** — 이 레포에는 React 컴포넌트 테스트 하네스가 없고 테스트용 dep 추가는 금지다. 그래서 로직을 Task 1 의 순수 함수로 최대한 밀어내고, Task 4 는 게이트 + 격리 데몬 런타임 확인 + 브라우저 육안 확인으로 검증한다.

---

### Task 1: `src/ui/route.ts` — URL ↔ 화면 상태 순수 변환

**Files:**
- Create: `src/ui/route.ts`
- Test: `src/ui/route.test.ts`

**Interfaces:**
- Consumes: 없음 (이 태스크가 의존성의 뿌리다)
- Produces:
  - `export type BoardSelection = 'all' | string`
  - `export interface Route { board: BoardSelection; todoNumber?: number }`
  - `export const RESERVED_BOARD_KEYS: readonly string[]` — `['api', 'mcp']`
  - `export function parseRoute(pathname: string): Route`
  - `export function buildPath(route: Route): string`
  - `export function routeForTodo(todo: { boardId: string; number: number }, boards: readonly { id: string; key: string }[]): Route`
  - `export function findTodoIdByNumber(todos: readonly { id: string; boardId: string; number: number }[], boards: readonly { id: string; key: string }[], board: BoardSelection, todoNumber: number): string | undefined`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src/ui/route.test.ts` 를 새로 만든다:

```ts
import { describe, expect, test } from 'bun:test';
import {
  buildPath,
  findTodoIdByNumber,
  parseRoute,
  RESERVED_BOARD_KEYS,
  routeForTodo,
} from './route';

const BOARDS = [
  { id: 'b1', key: 'rocky' },
  { id: 'b2', key: 'rocky-todo' },
];

const TODOS = [
  { id: 't1', boardId: 'b1', number: 12 },
  { id: 't2', boardId: 'b2', number: 12 },
  { id: 't3', boardId: 'b1', number: 3 },
];

describe('parseRoute', () => {
  test('root and empty mean the all-boards view', () => {
    expect(parseRoute('/')).toEqual({ board: 'all' });
    expect(parseRoute('')).toEqual({ board: 'all' });
  });

  test('one segment is a board', () => {
    expect(parseRoute('/rocky')).toEqual({ board: 'rocky' });
  });

  test('a trailing slash changes nothing', () => {
    expect(parseRoute('/rocky/')).toEqual({ board: 'rocky' });
    expect(parseRoute('/rocky/12/')).toEqual({ board: 'rocky', todoNumber: 12 });
  });

  test('a numeric second segment is the todo number', () => {
    expect(parseRoute('/rocky/12')).toEqual({ board: 'rocky', todoNumber: 12 });
  });

  test('a non-numeric second segment is ignored', () => {
    expect(parseRoute('/rocky/abc')).toEqual({ board: 'rocky' });
    expect(parseRoute('/rocky/12abc')).toEqual({ board: 'rocky' });
    expect(parseRoute('/rocky/-1')).toEqual({ board: 'rocky' });
    expect(parseRoute('/rocky/0')).toEqual({ board: 'rocky' });
  });

  test('extra segments are ignored', () => {
    expect(parseRoute('/rocky/12/anything/else')).toEqual({ board: 'rocky', todoNumber: 12 });
  });

  test('segments are percent-decoded', () => {
    expect(parseRoute('/my%20board')).toEqual({ board: 'my board' });
  });

  test('a malformed percent escape falls back to the all view rather than throwing', () => {
    expect(parseRoute('/%E0%A4%A')).toEqual({ board: 'all' });
  });
});

describe('buildPath', () => {
  test('the all view is the root path', () => {
    expect(buildPath({ board: 'all' })).toBe('/');
    expect(buildPath({ board: 'all', todoNumber: 12 })).toBe('/');
  });

  test('a board becomes one segment', () => {
    expect(buildPath({ board: 'rocky' })).toBe('/rocky');
  });

  test('a board and number become two segments', () => {
    expect(buildPath({ board: 'rocky', todoNumber: 12 })).toBe('/rocky/12');
  });

  test('board keys are percent-encoded', () => {
    expect(buildPath({ board: 'my board' })).toBe('/my%20board');
  });

  test('reserved keys collapse to the root so no link collides with a REST route', () => {
    for (const key of RESERVED_BOARD_KEYS) {
      expect(buildPath({ board: key })).toBe('/');
      expect(buildPath({ board: key, todoNumber: 12 })).toBe('/');
    }
  });

  test('round-trips with parseRoute', () => {
    for (const route of [
      { board: 'all' as const },
      { board: 'rocky' },
      { board: 'rocky', todoNumber: 12 },
      { board: 'my board', todoNumber: 3 },
    ]) {
      expect(parseRoute(buildPath(route))).toEqual(route);
    }
  });
});

describe('routeForTodo', () => {
  test('resolves the board key from the todo boardId', () => {
    expect(routeForTodo({ boardId: 'b1', number: 12 }, BOARDS)).toEqual({
      board: 'rocky',
      todoNumber: 12,
    });
  });

  test('an unknown boardId falls back to the all view', () => {
    expect(routeForTodo({ boardId: 'nope', number: 12 }, BOARDS)).toEqual({ board: 'all' });
  });
});

describe('findTodoIdByNumber', () => {
  test('scopes the number to the selected board', () => {
    expect(findTodoIdByNumber(TODOS, BOARDS, 'rocky', 12)).toBe('t1');
    expect(findTodoIdByNumber(TODOS, BOARDS, 'rocky-todo', 12)).toBe('t2');
  });

  test('returns undefined for a number that is not on that board', () => {
    expect(findTodoIdByNumber(TODOS, BOARDS, 'rocky', 999)).toBeUndefined();
  });

  test('returns undefined for an unknown board', () => {
    expect(findTodoIdByNumber(TODOS, BOARDS, 'nope', 12)).toBeUndefined();
  });

  test('the all view has no board scope, so a bare number is not resolvable', () => {
    expect(findTodoIdByNumber(TODOS, BOARDS, 'all', 12)).toBeUndefined();
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `bun test src/ui/route.test.ts`
Expected: FAIL — `Cannot find module './route'`

- [ ] **Step 3: 구현한다**

`src/ui/route.ts` 를 새로 만든다:

```ts
/**
 * URL ↔ 화면 상태 변환 — 웹 UI 퍼머링크의 단일 소유자.
 *
 * 라우터 라이브러리를 쓰지 않는다(레포 원칙: 신규 런타임 dep 은 별도 논의). 대신
 * History API 호출은 `src/ui/store.ts` 가 하고, 이 파일은 **순수 변환만** 맡아
 * 단위 테스트된다 — `src/ui/lib.ts` 가 `mdTokens`/`formatElapsed` 를 두는 것과 같은 이유다.
 *
 * URL 문법: `/`(전체) · `/{board}` · `/{board}/{number}`
 */

/**
 * 보드 선택 — `'all'`(전체 보기) 또는 board key.
 *
 * 이 타입이 `src/ui/store.ts` 가 아니라 여기 있는 이유: store 가 route 를 import 하므로
 * 반대 방향 import 는 순환이 된다. store 는 기존 import 경로 보존용으로 재수출한다.
 */
export type BoardSelection = 'all' | string;

/** URL 이 담는 화면 상태. `todoNumber` 가 있으면 그 todo 의 상세가 열린 상태다. */
export interface Route {
  board: BoardSelection;
  todoNumber?: number;
}

/**
 * 경로 첫 세그먼트로 쓸 수 없는 board key — 데몬의 REST/MCP 라우트와 충돌한다.
 * `src/store.ts` 의 `ensureBoard` 가 같은 목록으로 새 보드 생성을 막는다.
 */
export const RESERVED_BOARD_KEYS: readonly string[] = ['api', 'mcp'];

/**
 * `/rocky/12` → `{ board: 'rocky', todoNumber: 12 }`.
 *
 * 둘째 세그먼트는 **양의 정수일 때만** 번호로 읽는다 — 번호는 `MAX(number)+1` 로 발급되어
 * 1부터 시작하므로 `0`/음수/`12abc` 는 번호가 아니다. 셋째 이후 세그먼트는 무시한다.
 * 퍼센트 디코딩이 실패하는 경로(`/%E0%A4%A`)는 전체 보기로 떨어뜨린다 — 주소창에 손으로
 * 친 문자열이 앱을 죽이면 안 된다.
 */
export function parseRoute(pathname: string): Route {
  const segments = pathname.split('/').filter((s) => s !== '');
  const rawBoard = segments[0];
  if (rawBoard === undefined) {
    return { board: 'all' };
  }
  let board: string;
  try {
    board = decodeURIComponent(rawBoard);
  } catch {
    return { board: 'all' };
  }
  const rawNumber = segments[1];
  if (rawNumber === undefined || !/^[1-9]\d*$/.test(rawNumber)) {
    return { board };
  }
  return { board, todoNumber: Number(rawNumber) };
}

/**
 * `{ board: 'rocky', todoNumber: 12 }` → `/rocky/12`.
 *
 * 전체 보기와 예약어 board key 는 `/` 를 낸다. 예약어 폴백은 검증 도입 전에 만들어진
 * `api` 보드를 위한 것이다 — 그런 보드도 선택은 되지만, 되읽을 수 없는(REST 라우트와
 * 충돌하는) 주소를 내보내느니 덜 정확한 `/` 를 택한다.
 */
export function buildPath(route: Route): string {
  if (route.board === 'all' || RESERVED_BOARD_KEYS.includes(route.board)) {
    return '/';
  }
  const board = `/${encodeURIComponent(route.board)}`;
  return route.todoNumber === undefined ? board : `${board}/${route.todoNumber}`;
}

/** todo 하나를 가리키는 라우트. 보드를 못 찾으면(FK 가 깨진 상태) 전체 보기로 떨어진다. */
export function routeForTodo(
  todo: { boardId: string; number: number },
  boards: readonly { id: string; key: string }[],
): Route {
  const board = boards.find((b) => b.id === todo.boardId);
  if (!board) {
    return { board: 'all' };
  }
  return { board: board.key, todoNumber: todo.number };
}

/**
 * URL 의 번호를 todo id 로 되돌린다 — 이미 로드된 목록에서 찾으므로 새 REST 호출이 없다.
 *
 * 번호는 보드 안에서만 유일하므로 board 스코프가 반드시 필요하다. 전체 보기(`'all'`)에는
 * 스코프가 없어 항상 `undefined` 다 — `buildPath` 도 전체 보기에 번호를 싣지 않으므로
 * 이 조합은 URL 에서 나올 수 없고, 방어적으로만 처리한다.
 */
export function findTodoIdByNumber(
  todos: readonly { id: string; boardId: string; number: number }[],
  boards: readonly { id: string; key: string }[],
  board: BoardSelection,
  todoNumber: number,
): string | undefined {
  if (board === 'all') {
    return undefined;
  }
  const boardId = boards.find((b) => b.key === board)?.id;
  if (boardId === undefined) {
    return undefined;
  }
  return todos.find((t) => t.boardId === boardId && t.number === todoNumber)?.id;
}
```

- [ ] **Step 4: 테스트 통과를 확인한다**

Run: `bun test src/ui/route.test.ts`
Expected: PASS — 전부 통과

- [ ] **Step 5: 게이트를 돌린다**

Run: `bun run check && bun run typecheck && bun test`
Expected: 세 명령 모두 성공 종료 (exit 0)

- [ ] **Step 6: 커밋**

```bash
git add src/ui/route.ts src/ui/route.test.ts
git commit -m "feat(ui): URL ↔ 화면 상태 순수 변환"
```

---

### Task 2: `ensureBoard` 가 예약어 board key 를 거부한다

**Files:**
- Modify: `src/store.ts` (`ensureBoard`, 파일 기준 380행 부근)
- Test: `src/store.test.ts`

**Interfaces:**
- Consumes: Task 1 의 `RESERVED_BOARD_KEYS`
- Produces: `ensureBoard` 가 `api`/`mcp` 키로 **새** 보드를 만들려 하면 던진다. 기존 보드 조회는 영향 없음.

> **왜 store 가 ui 파일을 import 하나:** `src/ui/route.ts` 는 순수 TypeScript 이고 DOM API 를 쓰지 않는다. `src/cli.ts` 도 이미 `./ui/lib` 에서 `linkLabel` 을 runtime import 하므로 이 방향은 기존 관례 안에 있다. 목록을 두 곳에 복붙하지 않는 것이 요점이다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src/store.test.ts` 의 `describe('boards', ...)` 블록 안에 더한다:

```ts
  // finding: 웹 UI 퍼머링크가 board key 를 경로 첫 세그먼트로 쓴다(`/rocky/12`).
  // `api`/`mcp` 는 데몬의 REST/MCP 라우트라 그 키의 보드가 생기면 링크가 서버 라우트에 먹힌다.
  test('ensureBoard rejects a key reserved by the daemon routes', () => {
    expect(() => store.ensureBoard('api', { actor: 'tester' })).toThrow(/reserved/);
    expect(() => store.ensureBoard('mcp', { actor: 'tester' })).toThrow(/reserved/);
  });

  test('a key that merely contains a reserved word is fine', () => {
    const board = store.ensureBoard('api-gateway', { actor: 'tester' });
    expect(board.key).toBe('api-gateway');
  });

  // 검증은 새 보드 CREATE 에만 걸린다 — 구버전 데몬이 만들어둔 보드는 계속 조회돼야 한다.
  test('a pre-existing reserved-key board is returned unchanged', () => {
    const db = new Database(join(dir, 'todo.db'));
    db.run(
      "INSERT INTO boards (id, key, title, created_at) VALUES ('legacy01', 'api', 'api', '2026-07-01T00:00:00.000Z')",
    );
    db.close();

    const board = store.ensureBoard('api', { actor: 'tester' });
    expect(board.id).toBe('legacy01');
    expect(board.key).toBe('api');
  });
```

> `Database` 와 `join`/`dir` 은 `src/store.test.ts` 상단에서 이미 import·선언되어 있다 (`import { Database } from 'bun:sqlite'`, `let dir: string`). 새 import 를 더하지 않는다.

- [ ] **Step 2: 실패를 확인한다**

Run: `bun test src/store.test.ts`
Expected: FAIL — 첫 테스트가 "expected to throw" 로 실패한다 (지금은 `api` 보드가 그냥 만들어진다)

- [ ] **Step 3: 구현한다**

`src/store.ts` 상단 import 에 더한다:

```ts
import { RESERVED_BOARD_KEYS } from './ui/route';
```

`ensureBoard` 의 `#` 검사 **뒤**, `const board: Board = {` **앞**에 넣는다:

```ts
    if (RESERVED_BOARD_KEYS.includes(key)) {
      throw new Error(
        `board key is reserved by the daemon routes: ${JSON.stringify(key)} (${RESERVED_BOARD_KEYS.join(', ')})`,
      );
    }
```

`ensureBoard` 의 JSDoc `@throws` 줄에 예약어를 더한다:

```
   * @throws key 가 비어 있거나 공백/`#` 를 포함하거나, 데몬 라우트가 쓰는 예약어
   * (`api`/`mcp`)인 **새** 보드를 만들려 하면 — 어느 문자/이유가 문제인지 명시한다.
   * 이미 존재하는 보드는 이 검증을 건너뛴다.
```

- [ ] **Step 4: 테스트 통과를 확인한다**

Run: `bun test src/store.test.ts`
Expected: PASS

- [ ] **Step 5: 게이트를 돌린다**

Run: `bun run check && bun run typecheck && bun test`
Expected: 전부 성공

- [ ] **Step 6: 커밋**

```bash
git add src/store.ts src/store.test.ts
git commit -m "feat(store): 데몬 라우트 예약어를 board key 로 못 쓰게 막는다"
```

---

### Task 3: 데몬 fallback 라우트

**Files:**
- Modify: `src/daemon.ts` (`Bun.serve` 의 `routes`, 파일 기준 66-72행)

**Interfaces:**
- Consumes: 없음
- Produces: `/rocky` · `/rocky/12` 같은 임의 경로가 웹 UI HTML 을 받는다. `/api/*` 와 `/mcp` 는 그대로.

- [ ] **Step 1: 라우트를 더한다**

`src/daemon.ts` 의 `routes` 객체를 바꾼다:

```ts
    routes: {
      '/': ui,
      '/mcp': (req) => mcp(req),
      '/api/*': (req) => api.fetch(req),
      // 웹 UI 퍼머링크(`/rocky/12`)는 클라이언트 라우팅이라 서버에 그 경로가 없다.
      // 이 fallback 이 없으면 새로고침이 아래 `fetch`(REST) 로 떨어져 404 가 된다.
      // Bun 은 더 구체적인 패턴을 먼저 매칭하므로 `/api/*`·`/mcp` 는 영향받지 않는다.
      '/*': ui,
    },
```

같은 파일 상단 JSDoc 의 표면 목록에서 `/` 줄을 갱신한다:

```
 *   /            React 웹 UI (HTML import 자동 번들 — dist 없음)
 *   /*           같은 웹 UI — 퍼머링크(`/rocky/12`) 새로고침용 fallback
```

- [ ] **Step 2: 격리 데몬으로 런타임 확인한다**

이 레포에는 데몬 라우트를 도는 테스트 하네스가 없다(`server.test.ts` 는 `buildTodoServer` 의 fetch 핸들러만 검증한다). **사용자의 실제 보드 DB 를 건드리지 않도록** 임시 디렉터리와 별도 포트로 띄운다:

```bash
export ROCKY_TODO_DIR=$(mktemp -d)
export ROCKY_TODO_PORT=8996
export ROCKY_TODO_EXPOSE=""
bun src/daemon.ts &
sleep 3
curl -s -o /dev/null -w 'GET /          %{http_code}\n' "http://127.0.0.1:8996/"
curl -s -o /dev/null -w 'GET /rocky     %{http_code}\n' "http://127.0.0.1:8996/rocky"
curl -s -o /dev/null -w 'GET /rocky/12  %{http_code}\n' "http://127.0.0.1:8996/rocky/12"
curl -s "http://127.0.0.1:8996/api/health"; echo
curl -s -o /dev/null -w 'GET /api/nope  %{http_code}\n' "http://127.0.0.1:8996/api/nope"
curl -s -o /dev/null -w 'POST /mcp      %{http_code}\n' -X POST "http://127.0.0.1:8996/mcp"
```

Expected:
- `/`, `/rocky`, `/rocky/12` → **200** (HTML)
- `/api/health` → `{"ok":true,...}` JSON
- `/api/nope` → **404** (fallback 이 API 경로를 삼키지 않는다)
- `/mcp` → MCP 핸들러 응답 (200 또는 4xx — **HTML 이 아니어야 한다**)

`/rocky` 가 HTML 인지 실제로 확인한다:

```bash
curl -s "http://127.0.0.1:8996/rocky" | head -c 200
```
Expected: `<!DOCTYPE html>` 로 시작하는 문서

끝나면 **반드시** 데몬을 내리고 임시 디렉터리를 지운다:

```bash
kill %1
rm -rf "$ROCKY_TODO_DIR"
```

`/api/nope` 가 200 HTML 을 받거나 `/mcp` 가 HTML 을 받으면 Bun 의 라우트 우선순위 가정이 틀린 것이다 — 그 경우 멈추고 관측한 것을 보고한다. 라우트를 임의로 재배열하지 말 것.

- [ ] **Step 3: 게이트를 돌린다**

Run: `bun run check && bun run typecheck && bun test`
Expected: 전부 성공

- [ ] **Step 4: 커밋**

```bash
git add src/daemon.ts
git commit -m "feat(daemon): 퍼머링크 경로를 웹 UI 로 서빙하는 fallback 라우트"
```

---

### Task 4: URL 배선 — pushState / popstate / 부팅 복원

**Files:**
- Modify: `src/ui/store.ts`
- Modify: `src/ui/main.tsx`

**Interfaces:**
- Consumes: Task 1 의 `BoardSelection` / `Route` / `parseRoute` / `buildPath` / `routeForTodo` / `findTodoIdByNumber`
- Produces:
  - `UiState.applyRoute: (route: Route) => Promise<void>`
  - `openTodoDetail(id: string, options?: { push?: boolean }): Promise<void>` — 기본 `push: true`
  - `src/ui/store.ts` 가 `BoardSelection` 을 재수출한다 (기존 import 경로 보존)

- [ ] **Step 1: 타입과 import 를 옮긴다**

`src/ui/store.ts` 상단 import 에 더한다:

```ts
import {
  type BoardSelection,
  buildPath,
  findTodoIdByNumber,
  parseRoute,
  type Route,
  routeForTodo,
} from './route';
```

기존의 `export type BoardSelection = 'all' | string;` 선언을 **삭제**하고 재수출로 바꾼다:

```ts
// BoardSelection 은 './route' 가 소유한다 — store 가 route 를 import 하므로 반대 방향은
// 순환이 된다. 기존 import 경로(`from './store'`)를 쓰는 컴포넌트를 위해 재수출한다.
export type { BoardSelection };
```

- [ ] **Step 2: 상태와 액션 시그니처를 더한다**

`UiState` 인터페이스에서 `openTodoDetail` 선언을 바꾸고 `applyRoute` 를 더한다:

```ts
  /**
   * @param options.push false 면 히스토리 항목을 만들지 않는다. `refetch` 가 열린 상세를
   *   갱신할 때와 `applyRoute` 가 URL 을 따라갈 때 반드시 false 여야 한다 — 아니면
   *   SSE 이벤트 하나마다 히스토리가 한 칸씩 쌓인다.
   */
  openTodoDetail: (id: string, options?: { push?: boolean }) => Promise<void>;

  /** URL 이 지정한 화면으로 상태를 맞춘다 — 부팅과 popstate 가 쓴다. */
  applyRoute: (route: Route) => Promise<void>;
```

- [ ] **Step 3: 초기 selected 를 URL 에서 읽는다**

`create<UiState>` 의 초기값에서 `selected: 'all',` 를 바꾼다:

```ts
  // 첫 fetch 부터 올바른 보드를 조회하도록 URL 을 먼저 읽는다. 없는 보드였다면
  // 부팅 직후의 applyRoute 가 전체 보기로 되돌린다.
  selected: parseRoute(window.location.pathname).board,
```

- [ ] **Step 4: URL 을 쓰는 액션들을 고친다**

`setSelected` 를 바꾼다:

```ts
  setSelected: (selected) => {
    set({ selected });
    window.history.pushState(null, '', buildPath({ board: selected }));
    void get().refetch();
  },
```

`createBoard` 의 `set({ selected: board.key });` 줄 **뒤**에 더한다:

```ts
    window.history.pushState(null, '', buildPath({ board: board.key }));
```

`openTodoDetail` 을 바꾼다:

```ts
  openTodoDetail: async (id, options) => {
    const { actor, boards } = get();
    const body = await api<{ todo: TodoView; history: HistoryEntry[] }>(`/api/todos/${id}`, actor);
    set({ detail: { kind: 'todo', todo: body.todo, history: body.history } });
    if (options?.push === false) {
      return;
    }
    // 상세를 연 것이 히스토리 항목을 만든다 — closeDetail 이 이 표식을 보고 back() 할지
    // 정한다(퍼머링크로 바로 진입한 경우엔 back() 이 앱 밖으로 나가버린다).
    window.history.pushState({ rockyTodoDetail: true }, '', buildPath(routeForTodo(body.todo, boards)));
  },
```

`refetch` 안에서 열린 상세를 갱신하는 두 줄 중 todo 쪽을 바꾼다 (note 쪽은 그대로):

```ts
    if (detail?.kind === 'todo' && detail.todo) {
      void get().openTodoDetail(detail.todo.id, { push: false });
    } else if (detail?.kind === 'note' && detail.note) {
      void get().openNoteDetail(detail.note.id);
    }
```

`closeDetail` 을 바꾼다:

```ts
  closeDetail: () => {
    const state = window.history.state as { rockyTodoDetail?: boolean } | null;
    if (state?.rockyTodoDetail) {
      // 우리가 만든 항목이니 뒤로가기로 되돌린다 — popstate 가 detail 을 닫는다.
      window.history.back();
      return;
    }
    // 퍼머링크로 바로 들어온 경우: 되돌릴 항목이 없다. back() 하면 앱 밖으로 나간다.
    set({ detail: null });
    window.history.replaceState(null, '', buildPath({ board: get().selected }));
  },
```

- [ ] **Step 5: `applyRoute` 를 더한다**

`src/ui/store.ts` 의 `closeDetail` **뒤**에 넣는다:

```ts
  applyRoute: async (route) => {
    const known = route.board === 'all' || get().boards.some((b) => b.key === route.board);
    const board: BoardSelection = known ? route.board : 'all';
    if (!known) {
      // 낡은 링크에 에러 화면을 띄우지 않는다. 히스토리에 죽은 항목을 남기지 않으려
      // push 가 아니라 replace 를 쓴다.
      window.history.replaceState(null, '', buildPath({ board: 'all' }));
    }
    if (board !== get().selected) {
      set({ selected: board });
      await get().refetch();
    }
    if (route.todoNumber === undefined) {
      set({ detail: null });
      return;
    }
    const id = findTodoIdByNumber(get().todos, get().boards, board, route.todoNumber);
    if (id === undefined) {
      // 없거나 보관된 번호 — 보드만 열어 준다.
      set({ detail: null });
      window.history.replaceState(null, '', buildPath({ board }));
      return;
    }
    await get().openTodoDetail(id, { push: false });
  },
```

- [ ] **Step 6: 부팅과 popstate 를 배선한다**

`src/ui/main.tsx` 의 import 에 더한다:

```ts
import { parseRoute } from './route';
```

`App` 의 `useEffect` 를 바꾼다. 초기 `refetch` 가 끝난 **뒤**에 라우트를 적용해야 한다 — `applyRoute` 가 번호를 id 로 바꾸려면 `todos`/`boards` 가 이미 있어야 한다:

```ts
  useEffect(() => {
    // 초기 목록을 받은 뒤에야 URL 의 번호를 todo id 로 해석할 수 있다.
    void refetch().then(() => useUiStore.getState().applyRoute(parseRoute(window.location.pathname)));

    const onPopState = () => {
      void useUiStore.getState().applyRoute(parseRoute(window.location.pathname));
    };
    window.addEventListener('popstate', onPopState);

    const source = new EventSource('/api/events');
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.onmessage = () => {
      // 연속 mutation 을 한 번의 refetch 로 흡수
      clearTimeout(debounce.current);
      debounce.current = setTimeout(() => void refetch(), 150);
    };
    // doing 경과 표시 갱신용 주기 리렌더
    const tick = setInterval(() => void refetch(), 60_000);
    return () => {
      window.removeEventListener('popstate', onPopState);
      source.close();
      clearTimeout(debounce.current);
      clearInterval(tick);
    };
  }, [refetch, setConnected]);
```

- [ ] **Step 7: 게이트를 돌린다**

Run: `bun run check && bun run typecheck && bun test`
Expected: 전부 성공. `typecheck` 가 `BoardSelection` import 경로로 다른 파일을 지적하면 그 파일이 `./store` 에서 계속 가져오도록(재수출 덕에 동작한다) 두고, 지적된 실제 오류만 고친다.

- [ ] **Step 8: 격리 데몬 + 브라우저로 확인한다**

```bash
export ROCKY_TODO_DIR=$(mktemp -d)
export ROCKY_TODO_PORT=8996
export ROCKY_TODO_EXPOSE=""
bun src/daemon.ts &
sleep 3
curl -s -X POST -H 'content-type: application/json' -H 'x-rocky-actor: tester' \
  -d '{"key":"demo"}' http://127.0.0.1:8996/api/boards >/dev/null
curl -s -X POST -H 'content-type: application/json' -H 'x-rocky-actor: tester' \
  -d '{"board":"demo","title":"퍼머링크 확인"}' http://127.0.0.1:8996/api/todos
```

브라우저에서 확인할 것:
1. `http://127.0.0.1:8996/` → 전체 보기. 사이드바에서 `demo` 를 누르면 주소가 `/demo` 로 바뀐다
2. 그 상태로 **새로고침** → `demo` 보드가 그대로 열려 있다 (이 태스크의 원래 요구)
3. todo 제목을 눌러 드로어를 열면 주소가 `/demo/1` 이 된다
4. 드로어를 닫으면 주소가 `/demo` 로 돌아간다
5. 브라우저 **뒤로가기** → 드로어가 다시 열린다 / **앞으로가기** → 다시 닫힌다
6. `http://127.0.0.1:8996/demo/1` 을 새 탭에 직접 입력 → 보드가 열리고 드로어가 떠 있다. 그 상태에서 **닫기를 눌러도 앱 밖으로 나가지 않고** 주소만 `/demo` 가 된다
7. `http://127.0.0.1:8996/없는보드` → 전체 보기로 떨어지고 주소가 `/` 로 바뀐다
8. `http://127.0.0.1:8996/demo/999` → `demo` 보드만 열리고 주소가 `/demo` 로 바뀐다

끝나면 **반드시** 정리한다:

```bash
kill %1
rm -rf "$ROCKY_TODO_DIR"
```

- [ ] **Step 9: 커밋**

```bash
git add src/ui/store.ts src/ui/main.tsx
git commit -m "feat(ui): 보드·작업 상태를 URL 에 반영하고 복원한다"
```

---

### Task 5: 문서와 changeset

**Files:**
- Modify: `FEATURES.md`, `docs/rocky-todo.md`
- Create: `.changeset/<이름>.md`

- [ ] **Step 1: 문서를 읽고 형식을 확인한다**

`FEATURES.md` 와 `docs/rocky-todo.md` 를 먼저 읽는다. 아래 지시는 "이 내용을 넣어라"이지 "이 줄 뒤에 넣어라"가 아니다 — 각 파일의 기존 형식(표·불릿·코드 블록)과 간결함을 따르는 것이 우선이다.

- [ ] **Step 2: 퍼머링크 문법을 문서화한다**

두 문서에 담을 사실:

```
웹 UI 주소가 보고 있는 화면을 담는다 — `/`(전체) · `/rocky`(보드) · `/rocky/12`(그 todo 상세).
새로고침해도 유지되고 링크로 공유할 수 있다. 뒤로가기가 드로어를 닫는다.
board key `api` / `mcp` 는 데몬 라우트와 겹쳐 쓸 수 없다.
```

없는 기능을 쓰지 않는다 — 노트(메모) 상세와 `보관됨 표시` 토글은 URL 에 담기지 **않는다**.

- [ ] **Step 3: changeset 을 만든다**

```bash
bunx changeset
```
- bump: **minor** (사용자 표면 추가)
- 요약: `웹 UI 퍼머링크 — /rocky/12 로 보드와 작업을 주소에 담는다 (새로고침 유지 · 링크 공유)`

`bunx changeset` 이 대화형이라 막히면 `.changeset/` 의 기존 파일을 하나 읽어 형식을 확인하고 같은 모양으로 직접 만든다. 패키지명은 `package.json` 의 `name` 을 쓴다.

- [ ] **Step 4: 게이트를 돌린다**

Run: `bun run check && bun run typecheck && bun test`
Expected: 전부 성공 (Biome 가 마크다운도 포맷한다)

- [ ] **Step 5: 커밋**

```bash
git add FEATURES.md docs/rocky-todo.md .changeset
git commit -m "docs: 웹 UI 퍼머링크 문서화와 changeset"
```

---

## 완료 조건

1. `bun run check` · `bun run typecheck` · `bun test` 전부 통과
2. `/demo` 새로고침이 보드를 유지한다 (원래 요구)
3. `/demo/1` 을 직접 입력하면 그 todo 의 드로어가 열리고, 닫아도 앱 밖으로 나가지 않는다
4. `/api/health` 가 여전히 JSON 이고 `/api/nope` 가 404 다 (fallback 이 API 를 삼키지 않는다)
5. `rocky-todo#15` 를 `done` 으로 전이 (`todo_status`)
