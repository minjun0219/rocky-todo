# 보드·작업 퍼머링크

- 날짜: 2026-07-26
- 상태: 설계 승인됨
- 보드 항목: `rocky-todo#15`
- 대상: `src/daemon.ts` · `src/store.ts` · `src/ui/route.ts`(신규) · `src/ui/store.ts` · `src/ui/main.tsx`

## 문제

웹 UI 의 보드 선택은 zustand 메모리에만 있다(`selected: 'all'` 하드코딩, `src/ui/store.ts`).
새로고침하면 보던 보드가 사라지고 전체 보기로 돌아간다. 주소창은 항상 `/` 라서 특정 todo 를
가리켜 공유할 방법도 없다 — 대화에서는 `rocky#12` 라고 부를 수 있는데, 그 참조를 클릭 가능한
링크로 옮길 자리가 없다.

## 목표 / 비목표

**목표** — 보고 있는 화면이 주소에 담긴다. 새로고침해도 유지되고, 링크로 건네면 상대가 같은
화면을 연다.

**비목표** — 노트(메모) 상세의 퍼머링크, `showArchived` 같은 뷰 필터의 URL 반영, 라우터
라이브러리 도입, 서버 사이드 렌더링.

## 설계

### 1. URL 문법

```
/              전체 보기
/rocky         rocky 보드
/rocky/12      rocky 보드의 12번 todo 상세 열림
```

경로가 사람이 쓰는 참조 `rocky#12` 와 1:1 로 대응한다. 번호는 보드 안에서 안정적이고
(아카이브해도 회수되지 않는다) 랜덤 id 보다 짧아 링크에 적합하다.

### 2. 서버 — fallback 라우트

`src/daemon.ts` 의 `Bun.serve` 라우트에 `'/*': ui` 를 더한다. 현재는 `'/'` 만 HTML 이고
나머지 경로는 `fetch` 폴백이 REST 로 흘려 404 가 난다 — 새로고침이 곧 404 다.

```ts
routes: {
  '/': ui,
  '/mcp': (req) => mcp(req),
  '/api/*': (req) => api.fetch(req),
  '/*': ui,
},
```

Bun 은 더 구체적인 패턴을 먼저 매칭하므로 `/api/*` 와 `/mcp` 는 영향받지 않는다.

**예약어.** 보드 키 `api` / `mcp` 는 `ensureBoard`(`src/store.ts`)에서 거부하지 **않는다**.
보드 키는 레포 이름에서 유추되므로(`boardKeyFrom`, `src/actor.ts`) `api` 라는 레포는
현실적으로 존재할 수 있고, 거부하면 그 레포에서 `rocky-todo add`·MCP
`todo_write`/`note_write` 가 첫 사용부터 에러가 된다 — board key 검증(공백·`#`)과 달리
이 키들은 참조 문법을 깨지 않으므로 거부할 근거가 없다.

대신 **선택은 되지만 URL 은 `/` 로 둔다** — `refOf` 가 malformed board key 에서 raw id 로
폴백하는 것과 같은 판단이다: 되읽을 수 없는(REST 라우트와 충돌하는) 주소를 내보내느니
덜 예쁜 쪽을 택한다. `RESERVED_BOARD_KEYS`(`src/ui/route.ts`)는 `buildPath` 가 이 폴백에
쓰는 목록으로만 남는다.

### 3. 라우팅 — 새 의존성 없이

React Router 를 넣지 않는다(레포 원칙: 신규 런타임 dep 은 별도 논의). History API 를 직접
쓰되 파싱·조립을 순수 함수로 분리해 단위 테스트한다 — `mdTokens`/`formatElapsed` 를
`src/ui/lib.ts` 에 두는 것과 같은 이유다.

```ts
// src/ui/route.ts (신규 — 순수, DOM 무의존)

/**
 * 보드 선택 — `'all'`(전체 보기) 또는 board key.
 * 지금은 `src/ui/store.ts` 가 이 타입을 갖고 있는데 여기로 옮긴다. 반대로 두면
 * route.ts 가 store.ts 를 import 하고 store.ts 가 route.ts 를 import 하는 순환이 된다.
 * `store.ts` 는 기존 import 경로를 위해 재수출한다.
 */
export type BoardSelection = 'all' | string;

/** URL 이 담는 화면 상태. todoNumber 가 있으면 그 todo 의 상세가 열린 상태다. */
export interface Route {
  board: BoardSelection;
  todoNumber?: number;
}

/** `/rocky/12` → `{ board: 'rocky', todoNumber: 12 }`. 해석 불가한 꼬리는 버린다. */
export function parseRoute(pathname: string): Route;

/** `{ board: 'rocky', todoNumber: 12 }` → `/rocky/12`. board 가 'all' 이면 `/`. */
export function buildPath(route: Route): string;
```

`parseRoute` 규칙:
- 빈 경로 / `/` → `{ board: 'all' }`
- 첫 세그먼트를 board key 로, 둘째 세그먼트가 **순수 숫자일 때만** `todoNumber` 로 읽는다
  (`/rocky/abc` → `{ board: 'rocky' }`)
- 셋째 이후 세그먼트는 무시한다
- 트레일링 슬래시는 없는 것과 같다
- 세그먼트는 `decodeURIComponent` 를 거친다 — board key 는 `[a-zA-Z0-9_-]` 범위지만
  레거시 키가 있을 수 있다

`buildPath` 규칙:
- board key 를 `encodeURIComponent` 로 감싼다
- board 가 `'all'` 이면 `todoNumber` 가 있어도 `/` 를 낸다 — 보드 없는 todo 경로는 문법에 없다
- **예약어 board key(`api`/`mcp`)면 `/` 를 낸다** — §2 에서 결정한 대로 이 키의 보드도
  정상 생성·선택되지만, 주소가 덜 정확해지는 대가로 REST 라우트와 충돌하는 링크를
  내보내지 않는다

### 4. 스토어 배선

`src/ui/store.ts` 가 URL 을 **쓰고**, 앱 부팅과 `popstate` 가 URL 을 **읽는다**.

| 동작 | URL |
| --- | --- |
| `setSelected(board)` | `pushState(buildPath({ board }))` |
| `openTodoDetail(id)` | `pushState(buildPath({ board, todoNumber }))` |
| `closeDetail()` | `history.back()` |
| `popstate` | URL 을 읽어 `selected` / `detail` 을 맞춘다 |

`closeDetail` 을 `history.back()` 으로 두는 이유: 드로어를 연 것이 히스토리 항목을 만들었으니
뒤로가기가 그것을 되돌리는 것이 브라우저 표준 기대다. 닫기를 별도 `pushState` 로 두면
뒤로가기가 드로어를 **다시 여는** 반직관적 동작이 된다.

초기 상태는 `parseRoute(location.pathname)` 에서 온다 — `selected` 의 하드코딩된 `'all'` 이
여기로 바뀐다.

`popstate` 리스너는 `src/ui/main.tsx` 의 기존 `useEffect`(SSE 구독과 같은 자리)에 붙인다.

### 5. 해석 실패 처리

| 경우 | 동작 |
| --- | --- |
| 없는 보드 (`/오타`) | `all` 로 폴백 + `replaceState('/')` |
| 없는/보관된 번호 (`/rocky/999`) | 보드만 열고 `replaceState('/rocky')` |

둘 다 조용히 폴백한다. 낡은 링크에 에러 화면을 띄우는 것보다 보드를 보여주는 편이 낫다.
`replaceState` 를 쓰는 이유는 히스토리에 죽은 항목을 남기지 않기 위해서다.

### 6. 번호 → id 해석

`openTodoDetail(id)` 는 랜덤 id 를 받는데 URL 은 번호를 담는다. 이미 로드된 `todos` 배열에서
`boardId` + `number` 로 찾는다. 전체 보기에서는 `boards` 로 board key → boardId 를 먼저 얻는다.
**새 REST 호출은 없다.**

부팅 시에는 `refetch()` 가 끝난 뒤에야 `todos` 가 있으므로, URL 이 지정한 상세 열기는
초기 `refetch` 완료 후에 수행한다.

### 7. 테스트

| 파일 | 검증 |
| --- | --- |
| `src/ui/route.test.ts`(신규) | `parseRoute`/`buildPath` 왕복, `/`, 없는 꼬리, 숫자 아닌 둘째 세그먼트, 트레일링 슬래시, 인코딩된 키 |
| `src/store.test.ts` | `ensureBoard` 가 `api`/`mcp` 키를 그대로 받아들이고, `buildPath({ board: 'api' })` 는 `/` |

라우팅 배선(History API·popstate)은 컴포넌트 테스트 하네스가 없어 순수 함수로 최대한 밀어낸
뒤 브라우저에서 확인한다.

### 8. 브랜치

`main` 에서 딴다. `feat/todo-comments`(PR #8)가 별도로 진행 중이며 이 작업과 겹치는 파일은
`src/ui/store.ts` 뿐이다.

## 위험 / 판단 근거

- **`'/*': ui` 가 오타난 API 경로까지 HTML 로 준다** — `/api/todoss` 는 `/api/*` 에 잡혀 여전히
  404 지만, `/todos` 같은 경로는 이제 HTML 을 받는다. 보드로 해석되지 않으면 전체 보기로
  폴백하므로 사용자에게는 "빈 보드" 가 아니라 정상 화면이 보인다. 허용 가능한 대가다.
- **`api`/`mcp` 를 거부하지 않기로 한 결정은 자동 유추 경로(레포 이름 → board key)를
  깨뜨리지 않기 위해서다** — 대안(자동 유추 시 이름을 망글링)은 이 레포가 조용한 정규화를
  하지 않는다는 원칙과 충돌한다.
- **뒤로가기 = 드로어 닫기** 는 취향이 갈릴 수 있으나, 여는 동작이 히스토리를 만든 이상
  대칭이 맞는 쪽이다.
