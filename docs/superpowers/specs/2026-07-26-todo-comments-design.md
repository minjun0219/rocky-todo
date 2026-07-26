# todo 댓글 (에이전트 ↔ 사용자 커뮤니케이션)

- 날짜: 2026-07-26
- 상태: 설계 승인됨
- 보드 항목: `rocky-todo#10`
- 대상: `src/store.ts` · `src/server.ts` · `src/mcp.ts` · `src/cli.ts` · `src/notify.ts` · `src/ui/`

## 문제

에이전트가 작업 진행 상황을 todo 의 `description` 에 덧쓴다. `description` 은 "이 할 일이
무엇인가"를 적는 자리인데 진행 로그가 섞여 원래 요구가 묻히고, 매번 전체를 덮어쓰므로
직전 내용이 사라진다. 사용자가 거기에 답을 적을 자리도 없다.

보드에는 이미 전 mutation 히스토리가 있지만, 이건 "무엇이 바뀌었나"의 기록일 뿐
사람이 문장으로 남긴 맥락은 담지 못한다.

## 목표 / 비목표

**목표** — todo 하나에 시간순 대화를 붙인다. 에이전트가 진행 상황을 남기고 사용자가 답하면,
그 답이 다음 세션에 자동으로 주입돼 에이전트가 반응한다.

**비목표** — 댓글과 워크로그의 구분(지라식 탭 분리). 둘은 같은 한 줄기 타임라인이다.
note/board 에 붙는 댓글, 스레드(대댓글), 멘션, 알림, 서버측 읽음 상태.

## 설계

### 1. 스키마

`store.ts` 의 `SCHEMA` 상수에 테이블을 더한다. **마이그레이션은 필요 없다** — 기존 테이블이
전부 `CREATE TABLE IF NOT EXISTS` 로 매 기동 실행되는 구조이고, 신규 테이블 추가에는
`ALTER`/백필이 없어 `runMigrations` 의 백업·버전 관리가 개입할 이유가 없다.

```sql
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  todo_id TEXT NOT NULL REFERENCES todos(id),
  actor TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_comments_todo ON comments(todo_id, created_at);
```

id 는 기존 `newId()`(8자 base36)를 쓴다. 댓글은 보드별 번호(`#N`)를 갖지 않는다 — 참조는
언제나 부모 todo 를 거치고, 번호 공간이 하나 더 늘면 `resolveRef` 의 모호성만 커진다.

### 2. 히스토리 연동

댓글 mutation 은 **부모 todo 의 히스토리로** 기록한다:

```ts
this.recordHistory('todo', todoId, actor, 'comment', { comment: [null, body] }, boardId);
```

`entity` 를 `'todo'` 로 두는 것이 설계의 핵심이다. `history` 의
`CHECK (entity IN ('board','section','todo','note'))` 를 건드리지 않으면서 세 가지가 따라온다:

1. `/api/todos/:ref` 가 이미 하는 `listHistory({ entityId: todo.id })` 에 자동 포함
2. `recordHistory` 의 `emit` 이 SSE `change` 이벤트를 발행 → 웹 UI 실시간 갱신
3. `/api/changes` 피드에 실려 UserPromptSubmit 훅의 주입 경로로 자동 진입

액션 값: `comment` / `comment-edit` / `comment-archive` / `comment-unarchive`.

`changes` 페이로드는 `{ comment: [null, body] }`(작성),
`{ comment: [before, after] }`(수정) 형태로 둔다 — 기존 `[old, new]` 튜플 규약을 그대로 따른다.

### 3. 스토어 API

```ts
export interface Comment {
  id: string;
  todoId: string;
  actor: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}
```

```ts
addComment(ref: string, body: string, actor: string, currentBoardId?: string): Comment
listComments(todoId: string, includeArchived?: boolean): Comment[]
updateComment(id: string, body: string, actor: string): Comment
setCommentArchived(id: string, archived: boolean, actor: string): Comment
```

- `addComment` 는 todo 참조 문법(`#12` / `rocky#12` / id / id prefix)을 그대로 받는다
  (`resolveRef` 재사용). 빈 본문(공백만)은 거절한다.
- `updateComment` / `setCommentArchived` 는 댓글 id 로만 지정한다 — 번호가 없으므로.
- `listComments` 기본값은 보관된 댓글 제외.

`TodoView` 에 집계 두 개를 더한다:

```ts
commentCount: number;      // 보관되지 않은 댓글 수
lastCommentAt?: string;    // 가장 최근 댓글 시각 (없으면 undefined)
```

목록 화면의 배지를 위해서다. todo 마다 상세를 요청하지 않도록 `listTodos` 에서
`LEFT JOIN` 집계 한 번으로 계산한다.

### 4. REST

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| `GET` | `/api/todos/:ref` | 응답에 `comments` 배열 추가 (`{ todo, history, comments }`) |
| `POST` | `/api/todos/:ref/comments` | `{ body }` → 201 Comment |
| `PATCH` | `/api/comments/:id` | `{ body }` → Comment |
| `POST` | `/api/comments/:id/archive` | → Comment |
| `POST` | `/api/comments/:id/unarchive` | → Comment |

actor 는 기존과 같이 `x-rocky-actor` 헤더. `:ref` 해석은 기존 `currentBoardIdOf` 를 거친다.
없는 댓글 id 는 `not found` 메시지로 던져 `toHttpError` 가 404 로 번역하게 한다.

### 5. MCP — 도구는 5개를 유지한다

세션마다 실리는 스키마 토큰 고정비를 늘리지 않기 위해 새 도구를 만들지 않는다.

- `todo_write` 에 `comment?: string` 을 더한다.
  - **`comment` 만 오고 다른 수정 필드가 하나도 없으면 `updateTodo` 를 호출하지 않는다.**
    호출하면 아무것도 안 바뀐 `update` 히스토리 줄이 댓글마다 하나씩 따라붙는다.
  - 생성(`id` 없음)과 함께 와도 동작한다 — todo 를 만든 뒤 첫 댓글로 붙인다.
- `todo_list` 의 단건 조회(`id` 지정) 응답에 `comments` 배열을 더한다.
- `todo_write` 설명에 한 줄을 박는다: *진행 상황·중간 보고는 `description` 을 덮어쓰지 말고
  `comment` 로 남긴다.* 이 기능의 존재 이유를 도구 표면에 명시하는 것이다.

### 6. 훅 주입 — 양방향 루프

`notify.ts` 의 `formatLine` 에 `comment` 계열 액션 분기를 더한다. 기존
`field: old → new` 렌더는 문장에 맞지 않는다:

```
- logan: [rocky-todo] "댓글 기능 추가" 댓글 · "이거 SSE 로도 흘러가나?" · 6aqnak
```

- 본문은 200자에서 자르고(`…` 접미) 개행은 공백으로 접는다 — 주입 컨텍스트가 길어지지 않게.
- `comment-edit` 은 수정 후 본문만 보여준다.
- 에이전트가 단 댓글은 기존 `AGENT_ACTORS` 필터가 걸러내므로 자기 반향이 없다.

### 7. 웹 UI

**하나의 타임라인.** `DetailDrawer` 의 `HistoryTimeline` 을 확장해 히스토리 줄과 댓글 카드를
`at`/`createdAt` 기준 시간순으로 병합 렌더한다. 병합은 `ui/lib.ts` 의 순수 함수로 뺀다:

```ts
export type TimelineItem =
  | { kind: 'history'; at: string; entry: HistoryEntry }
  | { kind: 'comment'; at: string; comment: Comment };

export function mergeTimeline(history: HistoryEntry[], comments: Comment[]): TimelineItem[];
```

`comment` 계열 액션의 히스토리 줄은 병합 시 **버린다** — 같은 사건이 카드와 한 줄로 두 번
보이면 안 된다. 히스토리 기록 자체는 SSE·훅 주입을 위해 남겨 둔다.

- 드로어 하단에 댓글 입력 `textarea` + `⌘/Ctrl+Enter` 전송. 빈 본문은 전송하지 않는다.
- 댓글 카드에 **절대 작성 시각** — 오늘이면 `HH:MM`, 아니면 `MM-DD HH:MM`
  (`ui/lib.ts` 의 `formatStamp`). 수정된 댓글은 `(수정됨)` 표시.
  히스토리 줄은 기존 상대 시각(`formatElapsed`)을 유지한다.
- 각 댓글에 편집 / 보관 버튼. actor 는 자유 입력값이라 "본인 확인"이 성립하지 않으므로
  작성자 제한을 두지 않는다 — 수정·보관 사실은 히스토리에 남는다.
- **미확인 배지** — `TodoItem` 에 `💬 N`. `lastCommentAt` 이 읽음 커서보다 새로우면 강조한다.
  커서는 `localStorage` 의 `rocky-todo-seen-comments`(`{ [todoId]: ISO }`)에 두고 드로어를
  열 때 갱신한다. 단일 사용자 로컬 데몬이라 서버측 읽음 상태는 과설계다.

### 8. CLI

- `rocky-todo comment REF "본문"` — 작성.
- `rocky-todo show REF` 출력 끝에 댓글 타임라인(작성 시각 + actor + 본문)을 붙인다.
- 편집/보관은 넣지 않는다 — 웹 UI 로 충분하고 플래그만 늘어난다.

### 9. 테스트

| 파일 | 검증 |
| --- | --- |
| `store.test.ts` | 댓글 CRUD, 참조 문법 해석, 빈 본문 거절, 보관 필터, 히스토리 기록, `commentCount`/`lastCommentAt` 집계 |
| `server.test.ts` | 4개 라우트 + 없는 id 404 + 상세 응답의 `comments` |
| `mcp.test.ts` | `todo_write` 의 comment-only 호출이 `update` 히스토리를 만들지 않는 것, `todo_list` 상세의 `comments` |
| `cli.test.ts` | `comment` 명령 + `show` 출력 |
| `ui/lib.test.ts` | `mergeTimeline`(시간순·comment 히스토리 제거), `formatStamp` |
| `notify.test.ts` | comment 라인 포맷, 200자 절단, 에이전트 댓글 필터링 |

### 10. 문서

`FEATURES.md`(사람) · `AGENTS.md`(에이전트) · `docs/rocky-todo.md`(운영) 동기화.
`skills/board/SKILL.md` 에 "진행 보고는 댓글로" 에티켓 추가. `bunx changeset` — minor.

## 위험 / 판단 근거

- **히스토리 오염** — 댓글 하나마다 히스토리 줄이 하나 생긴다. 타임라인에서 그 줄을 버리므로
  화면상 중복은 없고, `/api/changes` 와 SSE 를 공짜로 얻는 대가로 받아들인다.
- **읽음 커서의 로컬성** — 브라우저를 바꾸면 배지가 다시 뜬다. 단일 사용자·로컬 데몬 전제에서
  서버 상태를 더하는 비용이 이득보다 크다.
- **댓글 삭제 없음** — 레포 전체 원칙(아카이브만)을 따른다.
