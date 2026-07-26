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
 * 경로 첫 세그먼트로 **가리킬 수 없는** board key — 데몬의 REST/MCP 라우트와 충돌한다.
 * 이 키의 보드도 `ensureBoard`(`src/store.ts`)로 정상 생성되고 동작한다 — 다만 URL 로
 * 가리킬 방법이 없어(`/api` 는 `/api/*` 라우트에 먹힌다) `buildPath` 가 이 키를 만나면
 * 전체 보기와 같은 `/` 를 낸다.
 */
export const RESERVED_BOARD_KEYS: readonly string[] = ['api', 'mcp'];

/**
 * 이 board key 를 주소 첫 세그먼트로 **되읽을 수 있게** 실어 보낼 수 있는가.
 *
 * 두 부류가 실패한다:
 * - `RESERVED_BOARD_KEYS` — 데몬의 `/api/*`·`/mcp` 라우트가 먼저 먹는다.
 * - 점 세그먼트(`.` / `..`) — `encodeURIComponent` 가 점을 이스케이프하지 않아 `/.`·`/..`
 *   가 그대로 나가고, 브라우저 URL 파서가 이를 `/` 로 정규화해 버린다. 주소가 만들어진
 *   순간 다른 화면을 가리키게 되므로 실을 수 없는 것으로 본다.
 *
 * `ensureBoard`(`src/store.ts`)는 이 키들을 거부하지 않는다 — board key 는 레포 이름에서
 * 유추되는 값이라 웹 UI 사정으로 조용히 망글링하거나 생성을 막지 않는다는 것이 그쪽 원칙이다.
 * 대신 주소만 전체 보기와 같은 `/` 로 접는다.
 */
export function isAddressableBoardKey(key: string): boolean {
  if (RESERVED_BOARD_KEYS.includes(key)) {
    return false;
  }
  const encoded = encodeURIComponent(key);
  return encoded !== '.' && encoded !== '..';
}

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
 * 전체 보기와 `isAddressableBoardKey` 가 거부하는 board key 는 `/` 를 낸다. 그런 보드도
 * 정상적으로 존재하고 선택도 되지만, 되읽을 수 없는 주소를 내보내느니 덜 정확한 `/` 를
 * 택한다. 이 폴백에 기대는 쪽은 히스토리 항목도 만들지 않아야 한다 — `src/ui/store.ts` 의
 * "주소가 그대로면 push 하지 않는다" 규칙이 그 짝이다.
 */
export function buildPath(route: Route): string {
  if (route.board === 'all' || !isAddressableBoardKey(route.board)) {
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
 * 스코프가 없어 항상 `undefined` 다 — `buildPath` 는 전체 보기에 번호를 싣지 않지만,
 * `parseRoute('/all/12')` 처럼 손으로 친 주소는 `{ board: 'all', todoNumber: 12 }` 를
 * 만들어낼 수 있어 이 조합이 URL 에서 실제로 나올 수 있다. 그때 `undefined` 를 돌려주는
 * 것이 올바른 처리다 — 스코프 없이 번호만으로 todo 를 특정할 수 없기 때문이다.
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
