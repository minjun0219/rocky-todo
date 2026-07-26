# todo 댓글 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** todo 하나에 시간순 대화(댓글)를 붙여, 에이전트의 진행 보고와 사용자의 답이 같은 타임라인에 쌓이고 사용자의 답이 다음 세션에 자동 주입되게 한다.

**Architecture:** 새 `comments` 테이블을 두되 **히스토리는 부모 todo 의 것으로**(`entity='todo'`) 기록한다. 그러면 기존 상세 조회·SSE 실시간 갱신·`/api/changes` 훅 주입 경로를 그대로 탄다. 웹 UI 는 히스토리 줄과 댓글 카드를 하나의 타임라인으로 병합해 렌더한다(지라식 탭 분리 없음). MCP 도구는 5개를 유지하고 `todo_write` 에 `comment` 필드를 얹는다.

**Tech Stack:** Bun + TypeScript(ESM) · `bun:sqlite` · `bun:test` · React 19 + zustand(웹 UI) · `@modelcontextprotocol/sdk` · Biome.

## Global Constraints

- 설계 문서: `docs/superpowers/specs/2026-07-26-todo-comments-design.md` (승인됨). 이탈 시 문서를 먼저 고친다.
- import 는 전부 상대경로, 확장자 없음. `__dirname` 금지 — `import.meta.dir`/`import.meta.url`.
- 새 런타임 의존성 추가 금지.
- **삭제는 없다** — 아카이브만 존재한다. 댓글도 같다.
- MCP 도구는 **5개를 유지한다** (`todo_list` / `todo_write` / `todo_status` / `note_list` / `note_write`).
- exported 함수/클래스에 JSDoc. 한국어 주석 OK, 코드 식별자·경로·명령·URL 은 영어 원형.
- 게이트: `bun run check` · `bun run typecheck` · `bun test` 세 개가 모두 통과해야 태스크 완료다.
- 커밋 메시지는 Conventional Commits + 한국어 요약 (`feat(store): …`).
- 작업 브랜치는 `feat/todo-comments` (이미 생성됨).

## File Structure

| 파일 | 역할 | 태스크 |
| --- | --- | --- |
| `src/store.ts` | `comments` 스키마 + `Comment` 타입 + CRUD + 집계. 댓글 로직의 단일 소유자 | 1, 2 |
| `src/store.test.ts` | 스토어 계약 테스트 | 1, 2 |
| `src/refs.ts` | `TodoView` 에 댓글 집계 두 필드를 얹음 (REST·MCP·CLI 가 공유) | 2 |
| `src/refs.test.ts` | 직렬화 계약 테스트 | 2 |
| `src/server.ts` | REST 라우트 4개 + 상세 응답의 `comments` | 3 |
| `src/server.test.ts` | 라우트 계약 테스트 | 3 |
| `src/mcp.ts` | `todo_write.comment` + `todo_list` 상세의 `comments` | 4 |
| `src/mcp.test.ts` | MCP 계약 테스트 | 4 |
| `src/notify.ts` | 훅 주입 라인의 댓글 렌더 | 5 |
| `src/notify.test.ts` | 주입 포맷 테스트 | 5 |
| `src/cli.ts` | `comment` 명령 + `show` 출력 | 6 |
| `src/cli.test.ts` | CLI 계약 테스트 | 6 |
| `src/ui/lib.ts` | 순수 함수 — 타임라인 병합 / 시각 포맷 / 읽음 커서 | 7 |
| `src/ui/lib.test.ts` | 순수 함수 테스트 | 7 |
| `src/ui/store.ts` | 드로어 상태의 `comments` + 댓글 액션 3개 | 8 |
| `src/ui/components/DetailDrawer.tsx` | 통합 타임라인 + 댓글 작성/편집/보관 UI | 8 |
| `src/ui/components/TodoItem.tsx` | 미확인 댓글 배지 | 9 |
| `src/ui/styles.css` | 댓글 카드·작성 폼·배지 스타일 | 8, 9 |
| `FEATURES.md` · `AGENTS.md` · `docs/rocky-todo.md` · `skills/board/SKILL.md` | 문서 동기화 | 10 |

**UI 태스크(8·9)에는 자동 테스트가 없다** — 이 레포에는 React 컴포넌트 테스트 하네스가 없다. 대신 로직을 태스크 7 의 순수 함수로 최대한 밀어내고, 8·9 는 `bun run check` + `bun run typecheck` + 브라우저 육안 확인으로 검증한다.

---

### Task 1: 스토어 — `comments` 테이블과 CRUD

**Files:**
- Modify: `src/store.ts`
- Test: `src/store.test.ts`

**Interfaces:**
- Consumes: 기존 `TodoStore` 내부의 `newId()`, `nowIso()`, `recordHistory()`, `mustGetTodo()`
- Produces:
  - `export interface Comment { id: string; todoId: string; actor: string; body: string; createdAt: string; updatedAt: string; archivedAt?: string }`
  - `TodoStore.addComment(ref: string, body: string, actor: string, currentBoardId?: string): Comment`
  - `TodoStore.listComments(todoId: string, includeArchived?: boolean): Comment[]`
  - `TodoStore.updateComment(id: string, body: string, actor: string): Comment`
  - `TodoStore.setCommentArchived(id: string, archived: boolean, actor: string): Comment`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src/store.test.ts` 끝에 새 describe 블록을 추가한다:

```ts
describe('comments', () => {
  test('addComment stores a comment and records history on the parent todo', () => {
    const todo = store.createTodo({ board: 'rocky', title: '작업' }, 'logan');
    const comment = store.addComment(todo.id, '  진행 중입니다  ', 'claude-code');

    expect(comment.todoId).toBe(todo.id);
    expect(comment.actor).toBe('claude-code');
    expect(comment.body).toBe('진행 중입니다');
    expect(comment.archivedAt).toBeUndefined();

    const history = store.listHistory({ entityId: todo.id });
    const entry = history.find((h) => h.action === 'comment');
    expect(entry).toBeDefined();
    expect(entry?.entity).toBe('todo');
    expect(entry?.actor).toBe('claude-code');
    expect(entry?.changes?.comment).toEqual([null, '진행 중입니다']);
  });

  test('addComment accepts a board-scoped ref', () => {
    const todo = store.createTodo({ board: 'rocky', title: '작업' }, 'logan');
    const comment = store.addComment(`rocky#${todo.number}`, '참조로 달기', 'logan');
    expect(comment.todoId).toBe(todo.id);
  });

  test('addComment rejects a blank body', () => {
    const todo = store.createTodo({ board: 'rocky', title: '작업' }, 'logan');
    expect(() => store.addComment(todo.id, '   \n  ', 'logan')).toThrow(/body is required/);
  });

  test('listComments returns oldest first and hides archived by default', () => {
    const todo = store.createTodo({ board: 'rocky', title: '작업' }, 'logan');
    const first = store.addComment(todo.id, '첫째', 'logan');
    const second = store.addComment(todo.id, '둘째', 'claude-code');

    expect(store.listComments(todo.id).map((c) => c.body)).toEqual(['첫째', '둘째']);

    store.setCommentArchived(first.id, true, 'logan');
    expect(store.listComments(todo.id).map((c) => c.id)).toEqual([second.id]);
    expect(store.listComments(todo.id, true).map((c) => c.id)).toEqual([first.id, second.id]);
  });

  test('updateComment rewrites the body and records comment-edit', () => {
    const todo = store.createTodo({ board: 'rocky', title: '작업' }, 'logan');
    const comment = store.addComment(todo.id, '오타 있음', 'logan');
    const updated = store.updateComment(comment.id, '오타 고침', 'logan');

    expect(updated.body).toBe('오타 고침');
    const entry = store.listHistory({ entityId: todo.id }).find((h) => h.action === 'comment-edit');
    expect(entry?.changes?.comment).toEqual(['오타 있음', '오타 고침']);
  });

  test('setCommentArchived toggles archivedAt and records history', () => {
    const todo = store.createTodo({ board: 'rocky', title: '작업' }, 'logan');
    const comment = store.addComment(todo.id, '잘못 달았다', 'logan');

    const archived = store.setCommentArchived(comment.id, true, 'logan');
    expect(archived.archivedAt).toBeDefined();

    const restored = store.setCommentArchived(comment.id, false, 'logan');
    expect(restored.archivedAt).toBeUndefined();

    const actions = store.listHistory({ entityId: todo.id }).map((h) => h.action);
    expect(actions).toContain('comment-archive');
    expect(actions).toContain('comment-unarchive');
  });

  test('unknown comment id throws not found', () => {
    expect(() => store.updateComment('nosuchid', '본문', 'logan')).toThrow(/comment not found/);
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `bun test src/store.test.ts`
Expected: FAIL — `store.addComment is not a function`

- [ ] **Step 3: 스키마에 테이블을 더한다**

`src/store.ts` 의 `SCHEMA` 상수에서 `CREATE TABLE IF NOT EXISTS history (...)` 블록 **뒤**, `CREATE INDEX` 줄들 **앞**에 삽입한다:

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
```

그리고 인덱스 줄 무리 끝에 한 줄 더한다:

```sql
CREATE INDEX IF NOT EXISTS idx_comments_todo ON comments(todo_id, created_at);
```

> **마이그레이션은 추가하지 않는다.** 기존 테이블이 전부 `CREATE TABLE IF NOT EXISTS` 로 매 기동 실행되는 구조이고, 신규 테이블에는 `ALTER`/백필이 없어 `runMigrations` 가 개입할 이유가 없다. `MIGRATIONS` 배열은 손대지 않는다.

- [ ] **Step 4: 타입을 더한다**

`src/store.ts` 의 `HistoryEntry` 인터페이스 **앞**(`Note` 인터페이스 뒤)에 넣는다:

```ts
/** todo 한 건에 달리는 댓글 — 에이전트의 진행 보고와 사용자의 답이 같은 타임라인에 쌓인다. */
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

행 매핑 타입은 `HistoryRow` 인터페이스 바로 앞에 넣는다:

```ts
interface CommentRow {
  id: string;
  todo_id: string;
  actor: string;
  body: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}
```

파일 끝의 `toHistory` 함수 뒤에 매퍼를 더한다:

```ts
function toComment(row: CommentRow): Comment {
  return {
    id: row.id,
    todoId: row.todo_id,
    actor: row.actor,
    body: row.body,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at ?? undefined,
  };
}
```

- [ ] **Step 5: 스토어 메서드를 구현한다**

`src/store.ts` 의 `// ── history ───` 구분선 **앞**(notes 섹션 끝)에 새 섹션을 넣는다:

```ts
  // ── comments ──────────────────────────────────────────────────────────────

  /**
   * todo 에 댓글을 단다. `ref` 는 todo 참조 문법(`#12` / `rocky#12` / id / id prefix).
   *
   * 히스토리는 **부모 todo 의 것으로**(`entity='todo'`) 기록한다 — `history` 의
   * `CHECK (entity IN (...))` 를 건드리지 않으면서 상세 조회(`listHistory({entityId})`),
   * SSE change 이벤트, `/api/changes` 훅 주입 경로에 그대로 올라탄다.
   * @throws 본문이 공백뿐이거나 todo 를 못 찾으면.
   */
  addComment(ref: string, body: string, actor: string, currentBoardId?: string): Comment {
    const trimmed = body.trim();
    if (trimmed === '') {
      throw new Error('comment body is required');
    }
    const todo = this.mustGetTodo(ref, currentBoardId);
    const now = nowIso();
    const comment: Comment = {
      id: newId(),
      todoId: todo.id,
      actor,
      body: trimmed,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .query(
        'INSERT INTO comments (id, todo_id, actor, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        comment.id,
        comment.todoId,
        comment.actor,
        comment.body,
        comment.createdAt,
        comment.updatedAt,
      );
    this.recordHistory(
      'todo',
      todo.id,
      actor,
      'comment',
      { comment: [null, trimmed] },
      todo.boardId,
    );
    return comment;
  }

  /**
   * 한 todo 의 댓글 — 오래된 것부터(대화 순). 기본은 보관된 댓글 제외.
   * (같은 밀리초에 들어온 댓글의 순서를 랜덤 id 가 아니라 삽입 순서로 가른다 — `rowid` 를 tiebreak 로 쓴다.)
   */
  listComments(todoId: string, includeArchived = false): Comment[] {
    const archivedFilter = includeArchived ? '' : ' AND archived_at IS NULL';
    return this.db
      .query<CommentRow, [string]>(
        `SELECT * FROM comments WHERE todo_id = ?${archivedFilter} ORDER BY created_at ASC, rowid ASC`,
      )
      .all(todoId)
      .map(toComment);
  }

  /**
   * 댓글 본문 수정. 대상은 **댓글 id 로만** 지정한다 — 댓글은 보드별 번호(`#N`)를 갖지
   * 않는다(번호 공간이 하나 더 늘면 `resolveRef` 의 모호성만 커진다).
   * @throws 본문이 공백뿐이거나 댓글을 못 찾으면.
   */
  updateComment(id: string, body: string, actor: string): Comment {
    const trimmed = body.trim();
    if (trimmed === '') {
      throw new Error('comment body is required');
    }
    const current = this.mustGetComment(id);
    if (trimmed === current.body) {
      return current;
    }
    const now = nowIso();
    this.db.query('UPDATE comments SET body = ?, updated_at = ? WHERE id = ?').run(trimmed, now, id);
    this.recordHistory(
      'todo',
      current.todoId,
      actor,
      'comment-edit',
      { comment: [current.body, trimmed] },
      this.boardIdOfTodo(current.todoId),
    );
    return { ...current, body: trimmed, updatedAt: now };
  }

  /** 댓글 보관/복원 — 삭제는 없다(레포 전체 원칙). */
  setCommentArchived(id: string, archived: boolean, actor: string): Comment {
    const current = this.mustGetComment(id);
    const at = archived ? nowIso() : null;
    this.db.query('UPDATE comments SET archived_at = ? WHERE id = ?').run(at, id);
    this.recordHistory(
      'todo',
      current.todoId,
      actor,
      archived ? 'comment-archive' : 'comment-unarchive',
      undefined,
      this.boardIdOfTodo(current.todoId),
    );
    return { ...current, archivedAt: at ?? undefined };
  }

  private mustGetComment(id: string): Comment {
    const row = this.db.query<CommentRow, [string]>('SELECT * FROM comments WHERE id = ?').get(id);
    if (!row) {
      throw new Error(`comment not found: ${id}`);
    }
    return toComment(row);
  }

  /**
   * 댓글이 속한 todo 의 boardId — change 이벤트의 boardId 필드용.
   * `getTodo` 를 쓰지 않는 이유: 저장된 raw id 는 참조 해석을 거칠 필요가 없고,
   * 여기서 `resolveRef` 의 prefix/번호 분기를 타게 하면 의미만 흐려진다.
   */
  private boardIdOfTodo(todoId: string): string | undefined {
    return this.db
      .query<{ board_id: string }, [string]>('SELECT board_id FROM todos WHERE id = ?')
      .get(todoId)?.board_id;
  }
```

- [ ] **Step 6: 테스트 통과를 확인한다**

Run: `bun test src/store.test.ts`
Expected: PASS — 새 `comments` describe 의 7개 테스트 포함 전부 통과

- [ ] **Step 7: 게이트를 돌린다**

Run: `bun run check && bun run typecheck && bun test`
Expected: 세 명령 모두 성공 종료 (exit 0)

- [ ] **Step 8: 커밋**

```bash
git add src/store.ts src/store.test.ts
git commit -m "feat(store): todo 댓글 테이블과 CRUD"
```

---

### Task 2: `TodoView` 에 댓글 집계 얹기

목록 화면의 배지를 위해 todo 마다 상세를 요청하지 않아도 되게 한다.

**Files:**
- Modify: `src/store.ts` (`commentStatsOf` 추가)
- Modify: `src/refs.ts` (`TodoView` 확장 + `withRef` 계산)
- Test: `src/store.test.ts`, `src/refs.test.ts`

**Interfaces:**
- Consumes: Task 1 의 `addComment` / `setCommentArchived`
- Produces:
  - `TodoStore.commentStatsOf(todoId: string): { count: number; lastAt?: string }`
  - `TodoView` 에 `commentCount: number`, `lastCommentAt?: string`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src/store.test.ts` 의 `describe('comments', ...)` 안에 더한다:

```ts
  test('commentStatsOf counts only unarchived comments', () => {
    const todo = store.createTodo({ board: 'rocky', title: '작업' }, 'logan');
    expect(store.commentStatsOf(todo.id)).toEqual({ count: 0, lastAt: undefined });

    const first = store.addComment(todo.id, '첫째', 'logan');
    const second = store.addComment(todo.id, '둘째', 'logan');
    const stats = store.commentStatsOf(todo.id);
    expect(stats.count).toBe(2);
    expect(stats.lastAt).toBe(second.createdAt);

    store.setCommentArchived(second.id, true, 'logan');
    const after = store.commentStatsOf(todo.id);
    expect(after.count).toBe(1);
    expect(after.lastAt).toBe(first.createdAt);
  });
```

`src/refs.test.ts` 끝에 더한다 (파일 상단 import 에 `withRef` 가 이미 없다면 추가한다):

```ts
describe('withRef comment stats', () => {
  test('todo view carries comment count and last comment time', () => {
    const todo = store.createTodo({ board: 'rocky', title: '작업' }, 'logan');
    expect(withRef(store, todo).commentCount).toBe(0);
    expect(withRef(store, todo).lastCommentAt).toBeUndefined();

    const comment = store.addComment(todo.id, '한 마디', 'logan');
    const view = withRef(store, todo);
    expect(view.commentCount).toBe(1);
    expect(view.lastCommentAt).toBe(comment.createdAt);
  });

  test('note view is unaffected', () => {
    const note = store.createNote({ board: 'rocky', title: '메모' }, 'logan');
    const view = withRef(store, note);
    expect(view.ref).toBe(`rocky#${note.number}`);
    expect('commentCount' in view).toBe(false);
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `bun test src/store.test.ts src/refs.test.ts`
Expected: FAIL — `store.commentStatsOf is not a function`

- [ ] **Step 3: 집계 메서드를 구현한다**

`src/store.ts` 의 comments 섹션에서 `mustGetComment` **앞**에 넣는다:

```ts
  /**
   * 목록 배지용 집계 — 보관되지 않은 댓글 수와 마지막 작성 시각.
   *
   * `withRef` 가 todo 하나마다 한 번 호출한다(N+1). 데몬 안 in-process SQLite 이고
   * `idx_comments_todo` 가 커버하는 질의라 보드 규모(수십~수백 건)에서 비용이 무시할
   * 수준이다 — 대신 모든 호출부(REST 목록·MCP·CLI)가 코드 변경 없이 집계를 얻는다.
   */
  commentStatsOf(todoId: string): { count: number; lastAt?: string } {
    const row = this.db
      .query<{ n: number; last: string | null }, [string]>(
        'SELECT COUNT(*) AS n, MAX(created_at) AS last FROM comments WHERE todo_id = ? AND archived_at IS NULL',
      )
      .get(todoId);
    return { count: row?.n ?? 0, lastAt: row?.last ?? undefined };
  }
```

- [ ] **Step 4: `TodoView` 를 확장한다**

`src/refs.ts` 의 `TodoView` 인터페이스를 바꾼다:

```ts
/** 응답 전용 todo — 저장 모델에 사람이 쓰는 참조(ref)와 댓글 집계를 얹은 형태. */
export interface TodoView extends Todo {
  /** `rocky#12` — 보드 접두사를 포함한 완전 참조. */
  ref: string;
  /** 보관되지 않은 댓글 수 — 목록의 배지용. */
  commentCount: number;
  /** 가장 최근 댓글 시각(ISO). 댓글이 없으면 undefined. */
  lastCommentAt?: string;
}
```

같은 파일의 `withRef` 구현부를 바꾼다:

```ts
/** `Todo` 와 `Note` 를 가른다 — `status` 는 todo 에만 있다. */
function isTodo(entity: Todo | Note): entity is Todo {
  return 'status' in entity;
}

export function withRef(store: TodoStore, entity: Todo): TodoView;
export function withRef(store: TodoStore, entity: Note): NoteView;
export function withRef(store: TodoStore, entity: Todo | Note): TodoView | NoteView {
  const ref = refOf(store, entity.boardId, entity.number, entity.id);
  if (!isTodo(entity)) {
    return { ...entity, ref };
  }
  const stats = store.commentStatsOf(entity.id);
  return { ...entity, ref, commentCount: stats.count, lastCommentAt: stats.lastAt };
}
```

- [ ] **Step 5: 테스트 통과를 확인한다**

Run: `bun test src/store.test.ts src/refs.test.ts`
Expected: PASS

- [ ] **Step 6: 게이트를 돌린다**

Run: `bun run check && bun run typecheck && bun test`
Expected: 전부 성공. `typecheck` 가 다른 파일에서 `commentCount` 누락을 지적하면(테스트가 `TodoView` 리터럴을 손으로 만드는 경우) 그 리터럴에 `commentCount: 0` 을 채워 고친다.

- [ ] **Step 7: 커밋**

```bash
git add src/store.ts src/store.test.ts src/refs.ts src/refs.test.ts
git commit -m "feat(store): TodoView 에 댓글 수·마지막 댓글 시각 집계"
```

---

### Task 3: REST 라우트

**Files:**
- Modify: `src/server.ts`
- Test: `src/server.test.ts`

**Interfaces:**
- Consumes: Task 1 의 스토어 메서드
- Produces:
  - `GET /api/todos/:ref` → `{ todo, history, comments }`
  - `POST /api/todos/:ref/comments` `{ body }` → 201 `Comment`
  - `PATCH /api/comments/:id` `{ body }` → `Comment`
  - `POST /api/comments/:id/archive` · `POST /api/comments/:id/unarchive` → `Comment`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src/server.test.ts` 끝에 더한다:

```ts
describe('comments', () => {
  async function makeTodo(): Promise<{ id: string; ref: string }> {
    const res = await req('/api/todos', {
      method: 'POST',
      body: JSON.stringify({ board: 'rocky', title: '작업' }),
    });
    const todo = (await res.json()) as { id: string; ref: string };
    return todo;
  }

  test('POST /api/todos/:ref/comments creates a comment', async () => {
    const todo = await makeTodo();
    const res = await req(`/api/todos/${encodeURIComponent(todo.ref)}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body: '진행 중' }),
      actor: 'claude-code',
    });
    expect(res.status).toBe(201);
    const comment = (await res.json()) as { todoId: string; actor: string; body: string };
    expect(comment.todoId).toBe(todo.id);
    expect(comment.actor).toBe('claude-code');
    expect(comment.body).toBe('진행 중');
  });

  test('GET /api/todos/:ref includes comments', async () => {
    const todo = await makeTodo();
    await req(`/api/todos/${todo.id}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body: '첫 댓글' }),
    });
    const res = await req(`/api/todos/${todo.id}`);
    const detail = (await res.json()) as { comments: { body: string }[] };
    expect(detail.comments.map((c) => c.body)).toEqual(['첫 댓글']);
  });

  test('PATCH /api/comments/:id edits the body', async () => {
    const todo = await makeTodo();
    const created = await req(`/api/todos/${todo.id}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body: '오타' }),
    });
    const comment = (await created.json()) as { id: string };
    const res = await req(`/api/comments/${comment.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ body: '고침' }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { body: string }).body).toBe('고침');
  });

  test('archive hides a comment from the detail payload, unarchive restores it', async () => {
    const todo = await makeTodo();
    const created = await req(`/api/todos/${todo.id}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body: '잘못 달았다' }),
    });
    const comment = (await created.json()) as { id: string };

    await req(`/api/comments/${comment.id}/archive`, { method: 'POST' });
    const hidden = (await (await req(`/api/todos/${todo.id}`)).json()) as { comments: unknown[] };
    expect(hidden.comments).toHaveLength(0);

    await req(`/api/comments/${comment.id}/unarchive`, { method: 'POST' });
    const shown = (await (await req(`/api/todos/${todo.id}`)).json()) as { comments: unknown[] };
    expect(shown.comments).toHaveLength(1);
  });

  test('blank body is a 400 and unknown comment id is a 404', async () => {
    const todo = await makeTodo();
    const blank = await req(`/api/todos/${todo.id}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body: '   ' }),
    });
    expect(blank.status).toBe(400);

    const missing = await req('/api/comments/nosuchid', {
      method: 'PATCH',
      body: JSON.stringify({ body: '본문' }),
    });
    expect(missing.status).toBe(404);
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `bun test src/server.test.ts`
Expected: FAIL — 첫 테스트가 `expect(res.status).toBe(201)` 에서 404 를 받는다

- [ ] **Step 3: 상세 응답에 comments 를 더한다**

`src/server.ts` 의 `todoDetail` GET 분기에서 응답 객체를 바꾼다:

```ts
          return json({
            todo: withRef(store, todo),
            history: store.listHistory({ entityId: todo.id }),
            comments: store.listComments(todo.id),
          });
```

- [ ] **Step 4: 라우트 세 개를 더한다**

`src/server.ts` 의 `todoStatus` 블록 **바로 뒤**, `// ── notes ──` 주석 **앞**에 넣는다:

```ts
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
```

> 공백뿐인 본문은 스토어가 `comment body is required` 로 던지고 `toHttpError` 가 400 으로, 없는 댓글 id 는 `comment not found: …` 로 던져 404 로 번역된다 — 라우트에서 따로 분기하지 않는다.

- [ ] **Step 5: 테스트 통과를 확인한다**

Run: `bun test src/server.test.ts`
Expected: PASS

- [ ] **Step 6: 게이트를 돌린다**

Run: `bun run check && bun run typecheck && bun test`
Expected: 전부 성공

- [ ] **Step 7: 커밋**

```bash
git add src/server.ts src/server.test.ts
git commit -m "feat(server): 댓글 REST 라우트와 상세 응답 확장"
```

---

### Task 4: MCP — `todo_write.comment` 와 `todo_list` 의 comments

**Files:**
- Modify: `src/mcp.ts`
- Test: `src/mcp.test.ts`

**Interfaces:**
- Consumes: Task 1·2 의 스토어 메서드
- Produces: `todo_write` 의 `comment?: string` 입력, `todo_list` 단건 응답의 `comments` 배열. **도구 개수는 5개 그대로.**

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src/mcp.test.ts` 끝에 더한다 (기존 헬퍼 `connect()` / `resultJson()` / `client` 를 그대로 쓴다):

```ts
describe('comments through MCP', () => {
  test('todo_write with only a comment does not create an update history row', async () => {
    const created = resultJson(
      await client.callTool({
        name: 'todo_write',
        arguments: { board: 'rocky', title: '작업' },
      }),
    ) as { id: string };

    await client.callTool({
      name: 'todo_write',
      arguments: { id: created.id, comment: '진행 중입니다', actor: 'claude-code' },
    });

    const detail = resultJson(
      await client.callTool({ name: 'todo_list', arguments: { id: created.id } }),
    ) as { comments: { body: string; actor: string }[]; history: { action: string }[] };

    expect(detail.comments.map((c) => c.body)).toEqual(['진행 중입니다']);
    expect(detail.comments[0]?.actor).toBe('claude-code');
    expect(detail.history.map((h) => h.action)).not.toContain('update');
  });

  test('todo_write applies a patch and a comment in the same call', async () => {
    const created = resultJson(
      await client.callTool({
        name: 'todo_write',
        arguments: { board: 'rocky', title: '작업' },
      }),
    ) as { id: string };

    const patched = resultJson(
      await client.callTool({
        name: 'todo_write',
        arguments: { id: created.id, priority: 'p1', comment: '우선순위 올림' },
      }),
    ) as { priority: string; commentCount: number };

    expect(patched.priority).toBe('p1');
    expect(patched.commentCount).toBe(1);

    const detail = resultJson(
      await client.callTool({ name: 'todo_list', arguments: { id: created.id } }),
    ) as { history: { action: string }[] };
    expect(detail.history.map((h) => h.action)).toContain('update');
  });

  test('todo_write can create a todo with its first comment', async () => {
    const created = resultJson(
      await client.callTool({
        name: 'todo_write',
        arguments: { board: 'rocky', title: '새 작업', comment: '착수합니다' },
      }),
    ) as { id: string; commentCount: number };

    expect(created.commentCount).toBe(1);
    const detail = resultJson(
      await client.callTool({ name: 'todo_list', arguments: { id: created.id } }),
    ) as { comments: { body: string }[] };
    expect(detail.comments.map((c) => c.body)).toEqual(['착수합니다']);
  });

  test('the tool surface is still exactly five tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TODO_MCP_TOOLS].sort());
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `bun test src/mcp.test.ts`
Expected: FAIL — `todo_list` 응답에 `comments` 가 없어 `detail.comments.map` 이 터진다

- [ ] **Step 3: `todo_list` 단건 응답에 comments 를 더한다**

`src/mcp.ts` 의 `todo_list` 핸들러 안 `if (id) { ... }` 블록의 반환값을 바꾼다:

```ts
        return jsonResult({
          todo: withRef(store, todo),
          history: store.listHistory({ entityId: todo.id }),
          comments: store.listComments(todo.id),
        });
```

- [ ] **Step 4: `todo_write` 에 comment 를 더한다**

`src/mcp.ts` 의 `todo_write` 등록에서 description 을 바꾼다 (기존 문장 끝에 한 문장 추가):

```ts
      description:
        'todo 생성/수정. id 없으면 생성(board + title 필수), 있으면 부분 수정. section 은 이름으로 자동 upsert. links 에 GitHub 이슈 / Todoist URL 을 첨부해 맥락을 연결한다. 삭제는 없다 — todo_status 의 archive 를 쓴다. id 는 참조 문법(#12, rocky#12, id, id prefix)을 받는다 — 맨숫자 #12 로 수정하려면 board 를 함께 줘야 한다. 진행 상황·중간 보고·사용자에게 묻고 싶은 것은 description 을 덮어쓰지 말고 comment 로 남긴다 — description 은 "이 할 일이 무엇인가"의 자리이고, comment 는 사용자와 주고받는 타임라인이다.',
```

`inputSchema` 에 `links` 다음 줄로 필드를 더한다:

```ts
        comment: z
          .string()
          .optional()
          .describe(
            'append a comment to this todo — progress notes, findings, questions to the user. Use this instead of rewriting description',
          ),
```

핸들러를 통째로 바꾼다:

```ts
    async ({ id, board, title, comment, actor, ...rest }) => {
      const who = actor ?? 'agent';
      if (id) {
        const currentBoardId = resolveBoardId(store, board, id);
        // comment 만 온 호출은 updateTodo 를 건너뛴다 — 아무것도 안 바뀐 `update`
        // 히스토리 줄이 댓글마다 하나씩 따라붙어 타임라인을 어지럽히지 않게.
        const hasPatch =
          title !== undefined || Object.values(rest).some((value) => value !== undefined);
        const todo = hasPatch
          ? store.updateTodo(id, { title, ...rest }, who, currentBoardId)
          : store.getTodo(id, currentBoardId);
        if (!todo) {
          throw new Error(`todo not found: ${id}`);
        }
        if (comment) {
          store.addComment(todo.id, comment, who);
        }
        return jsonResult(withRef(store, todo));
      }
      if (!board || !title) {
        throw new Error('board and title are required to create a todo');
      }
      const created = store.createTodo({ board, title, ...rest }, who);
      if (comment) {
        store.addComment(created.id, comment, who);
      }
      return jsonResult(withRef(store, created));
    },
```

> `withRef` 를 댓글 추가 **뒤에** 호출하는 순서가 중요하다 — 응답의 `commentCount` 가 방금 단 댓글을 포함해야 한다.

- [ ] **Step 5: 테스트 통과를 확인한다**

Run: `bun test src/mcp.test.ts`
Expected: PASS — 도구 개수 테스트 포함 전부 통과

- [ ] **Step 6: 게이트를 돌린다**

Run: `bun run check && bun run typecheck && bun test`
Expected: 전부 성공

- [ ] **Step 7: 커밋**

```bash
git add src/mcp.ts src/mcp.test.ts
git commit -m "feat(mcp): todo_write 에 comment 추가, todo_list 상세에 댓글 노출"
```

---

### Task 5: 훅 주입 — 사용자 댓글을 세션으로

**Files:**
- Modify: `src/notify.ts`
- Test: `src/notify.test.ts`

**Interfaces:**
- Consumes: Task 1 이 남기는 `comment` / `comment-edit` 히스토리의 `changes.comment`
- Produces: `buildNotifyContext` 출력의 댓글 전용 라인

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src/notify.test.ts` 의 `describe('buildNotifyContext', ...)` 안(없으면 파일 끝에 새 describe)에 더한다:

```ts
describe('comment lines', () => {
  test('renders a comment with its body instead of a field diff', () => {
    const context = buildNotifyContext([
      entry({
        action: 'comment',
        changes: { comment: [null, '이거 SSE 로도 흘러가나?'] },
        title: '댓글 기능 추가',
      }),
    ]);
    expect(context).toContain('"댓글 기능 추가" 댓글 · "이거 SSE 로도 흘러가나?"');
    expect(context).not.toContain('comment:');
  });

  test('renders an edited comment with the new body', () => {
    const context = buildNotifyContext([
      entry({ action: 'comment-edit', changes: { comment: ['오타', '고침'] } }),
    ]);
    expect(context).toContain('댓글 수정 · "고침"');
  });

  test('folds newlines and truncates a long body', () => {
    const body = `${'가'.repeat(250)}\n둘째 줄`;
    const context = buildNotifyContext([
      entry({ action: 'comment', changes: { comment: [null, body] } }),
    ]);
    expect(context).toContain('…');
    expect(context).not.toContain('\n둘째 줄');
    const line = (context ?? '').split('\n').find((l) => l.includes('댓글')) ?? '';
    expect(line.length).toBeLessThan(300);
  });

  test('agent comments are filtered out before formatting', () => {
    const entries = [
      entry({ id: 1, actor: 'claude-code', action: 'comment', changes: { comment: [null, '봇'] } }),
      entry({ id: 2, actor: 'logan', action: 'comment', changes: { comment: [null, '사람'] } }),
    ];
    const context = buildNotifyContext(filterHumanChanges(entries));
    expect(context).toContain('"사람"');
    expect(context).not.toContain('"봇"');
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `bun test src/notify.test.ts`
Expected: FAIL — 첫 테스트가 `comment: null → 이거 SSE 로도 흘러가나?` 꼴을 받아 어서션에 걸린다

- [ ] **Step 3: 댓글 렌더를 구현한다**

`src/notify.ts` 의 `ACTION_LABELS` 에 두 줄을 더한다:

```ts
  'comment-archive': '댓글 보관',
  'comment-unarchive': '댓글 보관 해제',
```

`ACTION_LABELS` 상수 **뒤**, `formatLine` **앞**에 넣는다:

```ts
/** 본문을 실어 보여주는 액션 — 나머지는 기존 `field: old → new` 렌더를 탄다. */
const COMMENT_ACTIONS: ReadonlySet<string> = new Set(['comment', 'comment-edit']);

/** 주입 컨텍스트가 길어지지 않게 본문 길이를 제한한다. */
const COMMENT_MAX_CHARS = 200;

/** 댓글 본문을 한 줄로 접고 길면 자른다. */
function condenseBody(body: string): string {
  const oneLine = body.replace(/\s+/g, ' ').trim();
  return oneLine.length > COMMENT_MAX_CHARS
    ? `${oneLine.slice(0, COMMENT_MAX_CHARS)}…`
    : oneLine;
}
```

`formatLine` 함수 본문 맨 앞(`const board = ...` 줄 **뒤**)에 분기를 넣는다:

```ts
  if (COMMENT_ACTIONS.has(entry.action)) {
    // 댓글은 문장이라 `field: old → new` 렌더가 맞지 않는다 — 본문을 그대로 보여준다.
    const raw = entry.changes?.comment?.[1];
    const body = typeof raw === 'string' ? condenseBody(raw) : '';
    const label = entry.action === 'comment' ? '댓글' : '댓글 수정';
    return `- ${entry.actor}: ${board}"${entry.title}" ${label} · "${body}" · ${entry.entityId.slice(0, 6)}`;
  }
```

- [ ] **Step 4: 테스트 통과를 확인한다**

Run: `bun test src/notify.test.ts`
Expected: PASS

- [ ] **Step 5: 게이트를 돌린다**

Run: `bun run check && bun run typecheck && bun test`
Expected: 전부 성공

- [ ] **Step 6: 커밋**

```bash
git add src/notify.ts src/notify.test.ts
git commit -m "feat(notify): 사용자 댓글을 세션 컨텍스트로 주입"
```

---

### Task 6: CLI — `comment` 명령과 `show` 출력

**Files:**
- Modify: `src/cli.ts`
- Test: `src/cli.test.ts`

**Interfaces:**
- Consumes: Task 3 의 REST 라우트
- Produces: `rocky-todo comment REF "본문"` · `rocky-todo show REF` 의 댓글 섹션

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src/cli.test.ts` 끝에 더한다. 기존 참조 통합 테스트(`src/cli.test.ts:118` 부근)와 **같은 하네스**를 쓴다 — 임시 store + `Bun.serve({ port: 0 })` + `buildContext(server.port)`. `CliContext` 는 `{ baseUrl, port, dir, actor }` 뿐이라 fetch 주입 지점이 없다:

```ts
describe('comment command paths', () => {
  let dir: string;
  let store: TodoStore;
  let server: ReturnType<typeof Bun.serve>;
  let ctx: CliContext;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rocky-todo-cli-comment-'));
    store = new TodoStore({ dbPath: join(dir, 'todo.db') });
    const api = buildTodoServer({ store });
    server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: (req) => api.fetch(req) });
    if (server.port === undefined) {
      throw new Error('Bun.serve did not assign a port');
    }
    ctx = buildContext({ port: server.port, dir, actor: 'tester' });
  });

  afterEach(() => {
    server.stop(true);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('todoRefPath builds the comments endpoint', () => {
    expect(todoRefPath('rocky#3', '/comments', 'rocky')).toBe(
      '/api/todos/rocky%233/comments?board=rocky',
    );
  });

  test('posting through the comments path creates a comment', async () => {
    const todo = store.createTodo({ board: 'rocky', title: '작업' }, 'tester');
    const comment = await request<{ body: string; todoId: string }>(
      ctx,
      'POST',
      todoRefPath(`rocky#${todo.number}`, '/comments', 'rocky'),
      { body: '한 마디' },
    );
    expect(comment.todoId).toBe(todo.id);
    expect(comment.body).toBe('한 마디');
  });

  test('show payload carries comments', async () => {
    const todo = store.createTodo({ board: 'rocky', title: '작업' }, 'tester');
    store.addComment(todo.id, '미리 달아둔 댓글', 'logan');
    const detail = await request<{ comments: { body: string }[] }>(
      ctx,
      'GET',
      todoRefPath(`rocky#${todo.number}`, '', 'rocky'),
    );
    expect(detail.comments.map((c) => c.body)).toEqual(['미리 달아둔 댓글']);
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `bun test src/cli.test.ts`
Expected: FAIL — `todoRefPath` 어서션 실패 또는 컴파일 에러

- [ ] **Step 3: `comment` 명령을 더한다**

`src/cli.ts` 의 `case 'update':` 블록 **뒤**에 넣는다:

```ts
    case 'comment': {
      const id = rest[0];
      const body = rest[1];
      if (!id || !body) {
        throw new Error('usage: rocky-todo comment REF "본문"');
      }
      const comment = await request<Comment>(ctx, 'POST', todoRefPath(id, '/comments', board), {
        body,
      });
      print(comment, () => `✓ ${id} 댓글 작성`);
      return;
    }
```

파일 상단의 store 타입 import 에 `Comment` 를 더한다:

```ts
import type { Board, Comment, HistoryEntry, Section } from './store';
```

- [ ] **Step 4: `show` 출력에 댓글을 더한다**

`src/cli.ts` 의 `case 'show':` 블록에서 요청 타입과 렌더를 바꾼다:

```ts
      const detail = await request<{
        todo: TodoView;
        history: HistoryEntry[];
        comments: Comment[];
      }>(ctx, 'GET', todoRefPath(id, '', board));
      print(detail, () => {
        const t = detail.todo;
        const lines = [t.ref, formatTodoLine(t, 0)];
        if (t.description !== '') {
          lines.push('', t.description);
        }
        if (t.links.length > 0) {
          lines.push('', ...t.links.map((l) => `↗ ${l.url}`));
        }
        lines.push('', `id: ${t.id}`);
        if (detail.comments.length > 0) {
          lines.push('', '댓글:');
          for (const c of detail.comments) {
            const stamp = c.createdAt.slice(0, 16).replace('T', ' ');
            lines.push(`  ${stamp} ${c.actor}: ${c.body.replace(/\s+/g, ' ')}`);
          }
        }
        lines.push('', '히스토리:');
        // 댓글은 위 섹션이 본문까지 보여준다 — 히스토리에서 같은 사건을 한 줄 더 찍지 않는다.
        const rows = detail.history.filter((h) => !h.action.startsWith('comment'));
        for (const h of rows.slice(0, 8)) {
          lines.push(`  ${h.at.slice(0, 16)} ${h.actor} ${h.action}`);
        }
        return lines.join('\n');
      });
      return;
```

- [ ] **Step 5: HELP 를 갱신한다**

`src/cli.ts` 의 `HELP` 상수에서 `show REF · update REF` 줄 **뒤**에 한 줄을 넣는다:

```
  rocky-todo comment REF "본문"                 todo 에 댓글 (에이전트/사람 공용 타임라인)
```

- [ ] **Step 6: 테스트 통과를 확인한다**

Run: `bun test src/cli.test.ts`
Expected: PASS

- [ ] **Step 7: 수동으로 한 번 돌려 본다**

```bash
bun run bin/rocky-todo add "댓글 스모크" --board rocky
bun run bin/rocky-todo comment "rocky#<위에서 나온 번호>" "CLI 에서 단 댓글"
bun run bin/rocky-todo show "rocky#<위에서 나온 번호>"
```
Expected: `show` 출력에 `댓글:` 섹션과 방금 단 한 줄이 보인다

- [ ] **Step 8: 게이트를 돌린다**

Run: `bun run check && bun run typecheck && bun test`
Expected: 전부 성공

- [ ] **Step 9: 커밋**

```bash
git add src/cli.ts src/cli.test.ts
git commit -m "feat(cli): comment 명령과 show 의 댓글 섹션"
```

---

### Task 7: UI 순수 함수 — 타임라인 병합 · 시각 · 읽음 커서

**Files:**
- Modify: `src/ui/lib.ts`
- Test: `src/ui/lib.test.ts`

**Interfaces:**
- Consumes: `Comment`(Task 1), `HistoryEntry`
- Produces:
  - `export type TimelineItem = { kind: 'history'; at: string; entry: HistoryEntry } | { kind: 'comment'; at: string; comment: Comment }`
  - `export function mergeTimeline(history: HistoryEntry[], comments: Comment[]): TimelineItem[]` — **최신 우선**
  - `export function formatStamp(iso: string, now?: Date): string`
  - `export interface SeenStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }`
  - `export function readSeen(storage: SeenStorage): Record<string, string>`
  - `export function markSeen(storage: SeenStorage, todoId: string, at: string): void`
  - `export function hasUnreadComments(todo: { id: string; lastCommentAt?: string }, seen: Record<string, string>): boolean`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src/ui/lib.test.ts` 끝에 더한다:

```ts
import type { Comment, HistoryEntry } from '../store';
import {
  formatStamp,
  hasUnreadComments,
  markSeen,
  mergeTimeline,
  readSeen,
  type SeenStorage,
} from './lib';

function history(partial: Partial<HistoryEntry>): HistoryEntry {
  return {
    id: 1,
    entity: 'todo',
    entityId: 'abcd1234',
    actor: 'logan',
    action: 'update',
    at: '2026-07-26T01:00:00.000Z',
    ...partial,
  };
}

function comment(partial: Partial<Comment>): Comment {
  return {
    id: 'c1',
    todoId: 'abcd1234',
    actor: 'logan',
    body: '본문',
    createdAt: '2026-07-26T02:00:00.000Z',
    updatedAt: '2026-07-26T02:00:00.000Z',
    ...partial,
  };
}

/** localStorage 대신 쓰는 인메모리 저장소. */
function fakeStorage(initial: Record<string, string> = {}): SeenStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value;
    },
  };
}

describe('mergeTimeline', () => {
  test('merges newest first', () => {
    const items = mergeTimeline(
      [history({ id: 2, at: '2026-07-26T03:00:00.000Z' }), history({ id: 1, at: '2026-07-26T01:00:00.000Z' })],
      [comment({ id: 'c1', createdAt: '2026-07-26T02:00:00.000Z' })],
    );
    expect(items.map((i) => i.at)).toEqual([
      '2026-07-26T03:00:00.000Z',
      '2026-07-26T02:00:00.000Z',
      '2026-07-26T01:00:00.000Z',
    ]);
    expect(items[1]?.kind).toBe('comment');
  });

  test('drops comment-family history rows so nothing is shown twice', () => {
    const items = mergeTimeline(
      [
        history({ id: 3, action: 'comment' }),
        history({ id: 4, action: 'comment-edit' }),
        history({ id: 5, action: 'comment-archive' }),
        history({ id: 6, action: 'comment-unarchive' }),
        history({ id: 7, action: 'done' }),
      ],
      [],
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe('history');
  });
});

describe('formatStamp', () => {
  test('shows only the time for today', () => {
    const now = new Date(2026, 6, 26, 15, 0);
    const at = new Date(2026, 6, 26, 9, 5);
    expect(formatStamp(at.toISOString(), now)).toBe('09:05');
  });

  test('shows month-day and time for other days', () => {
    const now = new Date(2026, 6, 26, 15, 0);
    const at = new Date(2026, 6, 24, 18, 30);
    expect(formatStamp(at.toISOString(), now)).toBe('07-24 18:30');
  });
});

describe('seen cursor', () => {
  test('unread when there is a comment newer than the cursor', () => {
    const seen = { abcd1234: '2026-07-26T01:00:00.000Z' };
    expect(hasUnreadComments({ id: 'abcd1234', lastCommentAt: '2026-07-26T02:00:00.000Z' }, seen)).toBe(true);
    expect(hasUnreadComments({ id: 'abcd1234', lastCommentAt: '2026-07-26T00:00:00.000Z' }, seen)).toBe(false);
  });

  test('no comments means nothing unread', () => {
    expect(hasUnreadComments({ id: 'abcd1234' }, {})).toBe(false);
  });

  test('never seen but has a comment counts as unread', () => {
    expect(hasUnreadComments({ id: 'abcd1234', lastCommentAt: '2026-07-26T02:00:00.000Z' }, {})).toBe(true);
  });

  test('markSeen persists and readSeen survives malformed json', () => {
    const storage = fakeStorage();
    markSeen(storage, 'abcd1234', '2026-07-26T02:00:00.000Z');
    expect(readSeen(storage)).toEqual({ abcd1234: '2026-07-26T02:00:00.000Z' });

    const broken = fakeStorage({ 'rocky-todo-seen-comments': '{not json' });
    expect(readSeen(broken)).toEqual({});
  });
});
```

> 파일 상단에 이미 `describe`/`expect`/`test` import 가 있으면 중복 import 를 만들지 말고 기존 것을 쓴다. 새로 더한 `import` 줄은 파일 맨 위 import 블록으로 옮긴다 (Biome 가 정렬한다).

- [ ] **Step 2: 실패를 확인한다**

Run: `bun test src/ui/lib.test.ts`
Expected: FAIL — `mergeTimeline` 등이 `./lib` 에 없다

- [ ] **Step 3: 순수 함수를 구현한다**

`src/ui/lib.ts` 끝에 더한다. 파일 상단 import 에 타입을 추가한다:

```ts
import type { Comment, HistoryEntry } from '../store';
```

```ts
/** 히스토리 줄과 댓글 카드를 한 줄기로 묶은 타임라인 항목. */
export type TimelineItem =
  | { kind: 'history'; at: string; entry: HistoryEntry }
  | { kind: 'comment'; at: string; comment: Comment };

/**
 * 댓글 계열 히스토리 액션 — 타임라인에서는 버린다.
 *
 * 댓글 mutation 은 부모 todo 의 히스토리로도 기록된다(SSE·훅 주입 경로를 타기 위해서다).
 * 그대로 두면 같은 사건이 댓글 카드와 히스토리 한 줄로 두 번 보인다.
 */
const COMMENT_HISTORY_ACTIONS: ReadonlySet<string> = new Set([
  'comment',
  'comment-edit',
  'comment-archive',
  'comment-unarchive',
]);

/**
 * 히스토리와 댓글을 시간순(**최신 우선**)으로 병합한다. 드로어의 기존 히스토리 렌더가
 * 최신 우선이라 그 방향을 유지한다.
 */
export function mergeTimeline(history: HistoryEntry[], comments: Comment[]): TimelineItem[] {
  const items: TimelineItem[] = [
    ...history
      .filter((entry) => !COMMENT_HISTORY_ACTIONS.has(entry.action))
      .map((entry) => ({ kind: 'history' as const, at: entry.at, entry })),
    ...comments.map((comment) => ({ kind: 'comment' as const, at: comment.createdAt, comment })),
  ];
  // 동률은 0 을 돌려 안정 정렬을 유지한다 (같은 밀리초의 두 항목이 뒤바뀌지 않게).
  return items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

/**
 * 절대 작성 시각 — 오늘이면 `HH:MM`, 다른 날이면 `MM-DD HH:MM` (브라우저 로컬 타임존).
 * 상대 시각(`formatElapsed`)은 "언제 썼는지"를 정확히 못 알려줘 댓글에는 쓰지 않는다.
 */
export function formatStamp(iso: string, now = new Date()): string {
  const at = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  const hm = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const sameDay =
    at.getFullYear() === now.getFullYear() &&
    at.getMonth() === now.getMonth() &&
    at.getDate() === now.getDate();
  return sameDay ? hm : `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${hm}`;
}

/** localStorage 의 최소 계약 — 테스트에서 인메모리 대역을 넣기 위해 좁혀 둔다. */
export interface SeenStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const SEEN_KEY = 'rocky-todo-seen-comments';

/** todo id → 마지막으로 확인한 댓글 시각(ISO). 깨진 값은 빈 커서로 취급한다. */
export function readSeen(storage: SeenStorage): Record<string, string> {
  try {
    const parsed = JSON.parse(storage.getItem(SEEN_KEY) ?? '{}') as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Record<string, string>;
  } catch {
    return {};
  }
}

/** 이 todo 의 댓글을 `at` 까지 확인했다고 기록한다. */
export function markSeen(storage: SeenStorage, todoId: string, at: string): void {
  const seen = readSeen(storage);
  seen[todoId] = at;
  storage.setItem(SEEN_KEY, JSON.stringify(seen));
}

/** 읽음 커서보다 새로운 댓글이 있는지 — 배지 강조 조건. */
export function hasUnreadComments(
  todo: { id: string; lastCommentAt?: string },
  seen: Record<string, string>,
): boolean {
  if (!todo.lastCommentAt) {
    return false;
  }
  const at = seen[todo.id];
  return at === undefined || at < todo.lastCommentAt;
}
```

- [ ] **Step 4: 테스트 통과를 확인한다**

Run: `bun test src/ui/lib.test.ts`
Expected: PASS

- [ ] **Step 5: 게이트를 돌린다**

Run: `bun run check && bun run typecheck && bun test`
Expected: 전부 성공

- [ ] **Step 6: 커밋**

```bash
git add src/ui/lib.ts src/ui/lib.test.ts
git commit -m "feat(ui): 타임라인 병합·작성 시각·읽음 커서 순수 함수"
```

---

### Task 8: 웹 UI — 통합 타임라인과 댓글 작성/편집/보관

**Files:**
- Modify: `src/ui/store.ts`
- Modify: `src/ui/components/DetailDrawer.tsx`
- Modify: `src/ui/styles.css`

**Interfaces:**
- Consumes: Task 3 의 REST, Task 7 의 `mergeTimeline` / `formatStamp` / `markSeen`
- Produces:
  - `DetailState.comments: Comment[]`
  - `UiState.seenComments: Record<string, string>` — 읽음 커서를 **zustand 상태로** 들고 있는다
  - `useUiStore` 액션: `addComment(todoId: string, body: string): Promise<void>` · `editComment(id: string, body: string): Promise<void>` · `archiveComment(id: string): Promise<void>`

- [ ] **Step 1: 스토어에 댓글 상태와 액션을 더한다**

`src/ui/store.ts` — import 에 `Comment` 와 커서 헬퍼를 더한다:

```ts
import type { Board, Comment, HistoryEntry, Section, StatusAction } from '../store';
import { markSeen, readSeen } from './lib';
```

> **읽음 커서를 zustand 에 두는 이유:** `localStorage` 를 컴포넌트에서 직접 읽으면 커서가 바뀌어도 리렌더가 걸리지 않는다 — 드로어를 열어 커서를 갱신해도 목록의 배지는 다음 `refetch` 까지 강조된 채로 남는다. 진실은 `localStorage`(세션 간 유지)에 두되, 화면이 보는 사본을 상태로 들고 함께 갱신한다.

`DetailState` 를 바꾼다:

```ts
interface DetailState {
  kind: 'todo' | 'note';
  todo?: TodoView;
  note?: NoteView;
  history: HistoryEntry[];
  comments: Comment[];
}
```

`UiState` 인터페이스에 상태 한 줄(`detail` 뒤)과 액션 세 개(`archiveNote` 뒤)를 더한다:

```ts
  /** todo id → 마지막으로 확인한 댓글 시각. localStorage 의 화면용 사본. */
  seenComments: Record<string, string>;
```

```ts
  addComment: (todoId: string, body: string) => Promise<void>;
  editComment: (id: string, body: string) => Promise<void>;
  archiveComment: (id: string) => Promise<void>;
```

`create<UiState>` 의 초기값 블록에서 `detail: null,` 뒤에 더한다:

```ts
  seenComments: readSeen(localStorage),
```

`openTodoDetail` 을 바꾼다 — 응답의 `comments` 를 싣고 읽음 커서를 갱신한다:

```ts
  openTodoDetail: async (id) => {
    const { actor } = get();
    const body = await api<{ todo: TodoView; history: HistoryEntry[]; comments: Comment[] }>(
      `/api/todos/${id}`,
      actor,
    );
    set({ detail: { kind: 'todo', todo: body.todo, history: body.history, comments: body.comments } });
    // 드로어를 연 시점에 이 todo 의 댓글은 모두 확인한 것으로 본다. localStorage(세션 간
    // 유지)와 상태 사본(리렌더 트리거)을 함께 갱신한다.
    if (body.todo.lastCommentAt) {
      markSeen(localStorage, body.todo.id, body.todo.lastCommentAt);
      set({ seenComments: readSeen(localStorage) });
    }
  },
```

`openNoteDetail` 은 `comments: []` 를 채운다:

```ts
    set({ detail: { kind: 'note', note: body.note, history: body.history, comments: [] } });
```

`archiveNote` 뒤에 액션 세 개를 더한다:

```ts
  addComment: async (todoId, body) => {
    const { actor } = get();
    await api(`/api/todos/${todoId}/comments`, actor, {
      method: 'POST',
      body: JSON.stringify({ body }),
    });
    await get().refetch();
  },

  editComment: async (id, body) => {
    const { actor } = get();
    await api(`/api/comments/${id}`, actor, { method: 'PATCH', body: JSON.stringify({ body }) });
    await get().refetch();
  },

  archiveComment: async (id) => {
    const { actor } = get();
    await api(`/api/comments/${id}/archive`, actor, { method: 'POST' });
    await get().refetch();
  },
```

- [ ] **Step 2: 드로어를 통합 타임라인으로 바꾼다**

`src/ui/components/DetailDrawer.tsx` — import 를 바꾼다:

```ts
import type { Comment, HistoryEntry } from '../../store';
import {
  actorTone,
  copyRefWithFeedback,
  formatElapsed,
  formatStamp,
  isEditableTarget,
  linkLabel,
  mdTokens,
  mergeTimeline,
} from '../lib';
```

`DetailDrawer` 본문의 `<HistoryTimeline history={detail.history} />` 를 바꾼다:

```tsx
        {detail.kind === 'todo' ? <TodoDetail /> : <NoteDetail />}
        {detail.kind === 'todo' && detail.todo && <CommentComposer todoId={detail.todo.id} />}
        <Timeline history={detail.history} comments={detail.comments} />
```

`HistoryTimeline` 함수를 아래 세 컴포넌트로 **교체**한다:

```tsx
/** 댓글 작성 — ⌘/Ctrl+Enter 로 전송. 빈 본문은 보내지 않는다. */
function CommentComposer({ todoId }: { todoId: string }) {
  const addComment = useUiStore((s) => s.addComment);
  const [body, setBody] = useState('');

  const submit = () => {
    const next = body.trim();
    if (next === '') {
      return;
    }
    setBody('');
    void addComment(todoId, next);
  };

  return (
    <div className="comment-compose">
      <div className="drawer-section-label">댓글</div>
      <textarea
        className="comment-input"
        value={body}
        rows={3}
        placeholder="진행 상황이나 질문을 남긴다 (⌘/Ctrl+Enter 전송)"
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <div className="drawer-actions">
        <button type="button" className="drawer-btn" onClick={submit} disabled={body.trim() === ''}>
          등록
        </button>
      </div>
    </div>
  );
}

/** 댓글 카드 — 작성 시각(절대) + actor + 본문 + 편집/보관. */
function CommentCard({ comment }: { comment: Comment }) {
  const editComment = useUiStore((s) => s.editComment);
  const archiveComment = useUiStore((s) => s.archiveComment);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body);

  useEffect(() => {
    if (!editing) {
      setDraft(comment.body);
    }
  }, [comment.body, editing]);

  const edited = comment.updatedAt !== comment.createdAt;

  return (
    <div className="comment-card">
      <div className="comment-head">
        <span className={`history-dot tone-${actorTone(comment.actor)}`} />
        <span className={`comment-actor tone-${actorTone(comment.actor)}`}>{comment.actor}</span>
        <span className="comment-at">{formatStamp(comment.createdAt)}</span>
        {edited && <span className="comment-edited">(수정됨)</span>}
        <span className="comment-tools">
          <button type="button" className="comment-tool" onClick={() => setEditing(!editing)}>
            {editing ? '취소' : '편집'}
          </button>
          <button
            type="button"
            className="comment-tool"
            onClick={() => void archiveComment(comment.id)}
          >
            보관
          </button>
        </span>
      </div>
      {editing ? (
        <div>
          <textarea
            className="comment-input"
            value={draft}
            rows={3}
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="drawer-actions">
            <button
              type="button"
              className="drawer-btn"
              onClick={() => {
                const next = draft.trim();
                setEditing(false);
                if (next !== '' && next !== comment.body) {
                  void editComment(comment.id, next);
                }
              }}
            >
              저장
            </button>
          </div>
        </div>
      ) : (
        <div className="comment-body">
          <Markdown text={comment.body} />
        </div>
      )}
    </div>
  );
}

/** 히스토리와 댓글을 한 줄기로 보여준다 — 지라식 탭 분리를 하지 않는다. */
function Timeline({ history, comments }: { history: HistoryEntry[]; comments: Comment[] }) {
  const items = mergeTimeline(history, comments);
  return (
    <div className="drawer-history">
      <div className="drawer-section-label">타임라인</div>
      {items.map((item) =>
        item.kind === 'comment' ? (
          <CommentCard key={`c-${item.comment.id}`} comment={item.comment} />
        ) : (
          <div key={`h-${item.entry.id}`} className="history-row">
            <span className={`history-dot tone-${actorTone(item.entry.actor)}`} />
            <span className={`history-actor tone-${actorTone(item.entry.actor)}`}>
              {item.entry.actor}
            </span>
            <span className="history-action">{actionLabel(item.entry.action)}</span>
            {item.entry.changes?.title && (
              <span className="history-change">→ {String(item.entry.changes.title[1])}</span>
            )}
            <span className="history-at">{formatElapsed(item.entry.at)} 전</span>
          </div>
        ),
      )}
    </div>
  );
}
```

`ACTION_LABELS` 에 두 줄을 더한다 (보관/복원 히스토리는 타임라인에서 걸러지지만, 다른 표면이 같은 상수를 참조할 때를 대비해 이름을 맞춰 둔다):

```ts
  'comment-archive': '댓글 보관',
  'comment-unarchive': '댓글 보관 해제',
```

- [ ] **Step 3: 스타일을 더한다**

`src/ui/styles.css` 끝에 더한다 (기존 파일의 CSS 변수·톤 클래스를 그대로 쓴다 — 새 색을 발명하지 말고 `.history-row` / `.drawer-desc` 근처 규칙의 값을 참고해 맞춘다):

```css
/* ── 댓글 ─────────────────────────────────────────────────────────────────── */
.comment-compose {
  margin-top: 14px;
}

.comment-input {
  width: 100%;
  resize: vertical;
  font: inherit;
  padding: 8px;
  border-radius: 6px;
  border: 1px solid var(--line);
  background: var(--bg-input);
  color: inherit;
}

.comment-card {
  padding: 8px 0;
  border-bottom: 1px solid var(--line);
}

.comment-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}

.comment-actor {
  font-weight: 600;
}

.comment-at,
.comment-edited {
  color: var(--muted);
}

.comment-tools {
  margin-left: auto;
  display: flex;
  gap: 6px;
}

.comment-tool {
  background: none;
  border: none;
  padding: 0;
  color: var(--muted);
  cursor: pointer;
  font-size: 12px;
}

.comment-tool:hover {
  color: inherit;
}

.comment-body {
  margin-top: 4px;
  font-size: 13px;
  line-height: 1.5;
}
```

> `--line` / `--bg-input` / `--muted` 는 이 파일에 이미 정의된 변수여야 한다. 없으면 **새로 만들지 말고** 기존 파일에서 같은 목적으로 쓰이는 변수명으로 바꿔 쓴다 (`grep -n "^\s*--" src/ui/styles.css` 로 확인).

- [ ] **Step 4: 게이트를 돌린다**

Run: `bun run check && bun run typecheck && bun test`
Expected: 전부 성공

- [ ] **Step 5: 브라우저에서 확인한다**

```bash
bun run bin/rocky-todo daemon stop || true
bun src/daemon.ts &
bun run bin/rocky-todo open
```
확인 목록:
1. todo 를 열면 드로어에 "댓글" 입력창과 "타임라인" 섹션이 보인다
2. 댓글을 쓰고 ⌘/Ctrl+Enter → 카드가 즉시 나타나고 작성 시각이 `HH:MM` 으로 보인다
3. 편집 → 저장 후 `(수정됨)` 이 붙는다
4. 보관 → 카드가 사라진다
5. 히스토리 줄에 `comment` 액션이 **중복으로** 보이지 않는다

확인이 끝나면 데몬을 내린다: `bun run bin/rocky-todo daemon stop`

- [ ] **Step 6: 커밋**

```bash
git add src/ui/store.ts src/ui/components/DetailDrawer.tsx src/ui/styles.css
git commit -m "feat(ui): 드로어 통합 타임라인과 댓글 작성·편집·보관"
```

---

### Task 9: 미확인 댓글 배지

**Files:**
- Modify: `src/ui/components/TodoItem.tsx`
- Modify: `src/ui/styles.css`

**Interfaces:**
- Consumes: Task 2 의 `TodoView.commentCount` / `lastCommentAt`, Task 7 의 `hasUnreadComments`, Task 8 의 `UiState.seenComments`

- [ ] **Step 1: 배지를 더한다**

`src/ui/components/TodoItem.tsx` — import 에 함수 하나를 더한다:

```ts
import {
  actorTone,
  copyRefWithFeedback,
  formatDue,
  formatElapsed,
  hasUnreadComments,
  isOverdue,
  isStale,
  linkLabel,
} from '../lib';
```

컴포넌트 본문의 `const stale = ...` 뒤에 더한다:

```ts
  // 커서는 zustand 상태에서 읽는다 — localStorage 를 직접 읽으면 커서가 바뀌어도
  // 리렌더가 걸리지 않아 배지 강조가 다음 refetch 까지 안 풀린다.
  const unread = hasUnreadComments(todo, seenComments);
```

같은 컴포넌트 상단의 셀렉터 옆에 한 줄을 더한다:

```ts
  const seenComments = useUiStore((s) => s.seenComments);
```

`doing` 배지 블록 **앞**에 배지를 넣는다:

```tsx
      {todo.commentCount > 0 && (
        <button
          type="button"
          className={`comment-badge ${unread ? 'is-unread' : ''}`}
          title={unread ? '읽지 않은 댓글이 있다' : '댓글 보기'}
          onClick={() => void openTodoDetail(todo.id)}
        >
          💬 {todo.commentCount}
        </button>
      )}
```

- [ ] **Step 2: 스타일을 더한다**

`src/ui/styles.css` 의 댓글 섹션 끝에 더한다:

```css
.comment-badge {
  background: none;
  border: none;
  padding: 0 2px;
  cursor: pointer;
  font-size: 12px;
  color: var(--muted);
}

.comment-badge.is-unread {
  color: inherit;
  font-weight: 600;
}
```

- [ ] **Step 3: 게이트를 돌린다**

Run: `bun run check && bun run typecheck && bun test`
Expected: 전부 성공

- [ ] **Step 4: 브라우저에서 확인한다**

```bash
bun src/daemon.ts &
bun run bin/rocky-todo open
```
확인 목록:
1. 댓글이 달린 todo 줄에 `💬 N` 이 보인다
2. CLI 로 새 댓글을 달면(`rocky-todo comment REF "새 댓글"`) 배지가 **강조**된다
3. 그 todo 의 드로어를 열었다 닫으면 강조가 풀린다

확인이 끝나면 데몬을 내린다: `bun run bin/rocky-todo daemon stop`

- [ ] **Step 5: 커밋**

```bash
git add src/ui/components/TodoItem.tsx src/ui/styles.css
git commit -m "feat(ui): 미확인 댓글 배지"
```

---

### Task 10: 문서 동기화와 changeset

**Files:**
- Modify: `FEATURES.md`, `AGENTS.md`, `docs/rocky-todo.md`, `skills/board/SKILL.md`
- Create: `.changeset/<자동 생성 이름>.md`

- [ ] **Step 1: `FEATURES.md` 를 고친다**

CLI 사용법 블록의 `rocky-todo show REF · update REF` 줄 뒤에 한 줄을 더한다:

```
rocky-todo comment REF "본문"                  todo 에 댓글
```

MCP 도구 설명에서 `todo_write` 항목에 `comment` 를 언급하고, 기능 목록에 한 줄을 더한다:

```
- **댓글** — todo 마다 시간순 대화. 에이전트의 진행 보고와 사용자의 답이 같은 타임라인에
  쌓이고, 사용자가 단 댓글은 다음 세션에 자동 주입된다. 삭제는 없다(보관만).
```

- [ ] **Step 2: `AGENTS.md` 를 고친다**

"Project in one line" 문단의 MCP 도구 나열은 그대로 두고(도구 수 불변), 같은 문단의 기능 열거에 `댓글(todo 별 타임라인 — description 대신 진행 보고를 남기는 자리)` 을 더한다.

"Layout" 표의 `src/store.ts` 설명에 `+ comments` 를 더한다:

```
│   ├── store.ts                    # SQLite 스토어 — CRUD + 계층/섹션 + 댓글 + 아카이브 + history + change 이벤트
```

- [ ] **Step 3: `docs/rocky-todo.md` 를 고친다**

CLI 명령 표에 `comment` 행을, REST 표에 새 라우트 네 개를 더한다. 표의 기존 형식을 그대로 따른다.

- [ ] **Step 4: `skills/board/SKILL.md` 에 에티켓을 더한다**

start→done 에티켓 절 뒤에 한 절을 더한다:

```markdown
## 진행 보고는 댓글로

작업 중 알게 된 것, 막힌 지점, 사용자에게 묻고 싶은 것은 `todo_write` 의 `comment` 로 남긴다.
`description` 을 덮어쓰지 않는다 — 거기는 "이 할 일이 무엇인가"의 자리이고, 덮어쓰면 원래
요구가 사라진다. 사용자가 웹 UI 에서 단 답글은 다음 세션 시작 시 자동으로 주입된다.
```

- [ ] **Step 5: changeset 을 만든다**

```bash
bunx changeset
```
- bump: **minor** (사용자 표면 추가)
- 요약: `todo 댓글 — 에이전트와 사용자가 같은 타임라인에서 대화한다 (웹 UI · MCP todo_write.comment · CLI comment · 훅 주입)`

- [ ] **Step 6: 게이트를 돌린다**

Run: `bun run check && bun run typecheck && bun test`
Expected: 전부 성공

- [ ] **Step 7: 커밋**

```bash
git add FEATURES.md AGENTS.md docs/rocky-todo.md skills/board/SKILL.md .changeset
git commit -m "docs: todo 댓글 문서 동기화와 changeset"
```

---

## 완료 조건

1. `bun run check` · `bun run typecheck` · `bun test` 전부 통과
2. MCP 도구가 여전히 5개 (`mcp.test.ts` 의 도구 목록 테스트가 지킨다)
3. 웹 UI 에서 댓글 작성 → 편집 → 보관이 동작하고, 히스토리 줄이 중복되지 않는다
4. CLI 로 단 댓글이 다음 세션의 훅 주입에 사람 변경으로 나타난다
5. `rocky-todo#10` 을 `done` 으로 전이 (`todo_status`)
