# 보드에서 백그라운드 세션 띄우기 — 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 보드 드로어의 버튼 하나로 그 todo 전용 워크트리에 백그라운드 Claude Code 세션을 띄우고, 첫 작업 요청을 그 세션에 바로 배달한다.

**Architecture:** 워크트리 생성·재사용·정리는 전부 Claude Code 의 `-w/--worktree` 에 맡긴다. 데몬은 워크트리 이름을 `todo-<번호>` 로 결정론적으로 계산해 `claude --bg` 를 띄우기만 한다 — 이름이 곧 "이 todo 의 워크트리"라 기억할 저장소가 필요 없다. 첫 배달은 프롬프트 직접 주입이고, 그 뒤로는 `rocky-todo#11` 이 만든 평범한 handoff 큐(`Stop` 훅 claim)를 그대로 탄다.

**Tech Stack:** TypeScript(ESM) · Bun(`bun:sqlite`, `bun:test`, `Bun.spawnSync`) · React + zustand(웹 UI) · Biome.

설계 문서: `docs/superpowers/specs/2026-07-27-background-session-spawn-design.md`

## Global Constraints

- 런타임 의존성을 새로 추가하지 않는다. 현재 prod-dep(`@modelcontextprotocol/sdk`, `react`, `react-dom`, `zustand`, `zod`) 그대로.
- import 는 전부 상대경로, 확장자 없음(`./sessions`). `__dirname` 금지 — `import.meta.dir` / `import.meta.url`.
- exported 함수·클래스에 JSDoc. 한국어 주석 OK, 코드 식별자·경로·명령·URL 은 영어 원형.
- **`claude` CLI 가 없는 머신에서도 `bun run check` · `bun run typecheck` · `bun test` 가 전부 통과해야 한다.** 외부 명령은 전부 주입 가능한 실행기를 거친다.
- 외부 프로세스를 실제로 띄우는 테스트를 쓰지 않는다.
- MCP 도구는 5개를 유지한다 — spawn 을 MCP 로 노출하지 않는다.
- 커밋 메시지는 Conventional Commits (`type(scope): 한국어 요약`).
- 마이그레이션은 `MIGRATIONS` 배열 끝에만 추가한다. 기존 항목은 절대 수정하지 않는다.

---

### Task 1: 세션 목록에 `id` / `state` 싣기

`agents --json` 은 문서화된 필드 외에 짧은 id(`5acaaaeb`)와 `state`(`working` / `done`)를 준다. background 세션에만 붙고 interactive 에는 없다. 동시 실행 가드가 "죽지 않은 세션" 을 판별하려면 `state` 가 필요하다.

**Files:**
- Modify: `src/sessions.ts`
- Test: `src/sessions.test.ts`

**Interfaces:**
- Consumes: 없음 (첫 태스크)
- Produces: `AgentSession` 에 `id?: string`, `state?: string` 추가. 둘 다 optional — interactive 세션에는 없다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src/sessions.test.ts` 의 `SAMPLE` 아래에 상수와 테스트를 더한다:

```ts
const SAMPLE_BACKGROUND = JSON.stringify([
  {
    pid: 24075,
    id: '5acaaaeb',
    cwd: '/repo/.claude/worktrees/todo-16',
    kind: 'background',
    startedAt: 1785151478042,
    sessionId: '5acaaaeb-1275-48d1-8f4c-3970c33ff6dc',
    name: 'rocky-todo-16',
    status: 'idle',
    state: 'done',
  },
]);

describe('listSessions — background 필드', () => {
  test('id 와 state 를 싣는다', () => {
    const result = listSessions(runWith(SAMPLE_BACKGROUND));
    expect(result.sessions[0]?.id).toBe('5acaaaeb');
    expect(result.sessions[0]?.state).toBe('done');
  });

  test('interactive 세션처럼 id/state 가 없으면 undefined 로 둔다', () => {
    const result = listSessions(runWith(SAMPLE));
    expect(result.sessions[0]?.id).toBeUndefined();
    expect(result.sessions[0]?.state).toBeUndefined();
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `bun test src/sessions.test.ts`
Expected: FAIL — `expect(received).toBe(expected)` 에서 `undefined` 가 `'5acaaaeb'` 와 다르다.

- [ ] **Step 3: 구현한다**

`src/sessions.ts` 의 `AgentSession` 인터페이스에 두 필드를 더한다:

```ts
export interface AgentSession {
  pid: number;
  cwd: string;
  /** 'interactive' | 'background' — CLI 가 주는 값을 그대로 둔다. */
  kind: string;
  sessionId: string;
  /**
   * 짧은 id(8자) — `claude attach/logs/stop/rm` 이 받는 값이자 `sessionId` 의 접두사다.
   * background 세션에만 붙는다.
   */
  id?: string;
  /** 사람이 읽는 세션 이름 (예: `eelpout-a3`). */
  name: string;
  /** 'idle' | 'busy' — CLI 가 주는 값을 그대로 둔다. */
  status: string;
  /**
   * background 세션의 수명 상태 — 'working' | 'done'. interactive 세션에는 없다.
   * 없음(undefined)은 "죽지 않았다"로 읽는다 — 살아 있는 interactive 세션이 그 꼴이다.
   */
  state?: string;
  startedAt: number;
}
```

같은 파일의 `toSession` 반환문에 두 줄을 더한다 (`kind` 바로 아래, `status` 바로 아래):

```ts
  return {
    pid: row.pid,
    cwd: row.cwd,
    kind: typeof row.kind === 'string' ? row.kind : 'interactive',
    ...(typeof row.id === 'string' ? { id: row.id } : {}),
    sessionId: row.sessionId,
    name: row.name,
    status: typeof row.status === 'string' ? row.status : 'idle',
    ...(typeof row.state === 'string' ? { state: row.state } : {}),
    startedAt: typeof row.startedAt === 'number' ? row.startedAt : 0,
  };
```

- [ ] **Step 4: 통과를 확인한다**

Run: `bun test src/sessions.test.ts`
Expected: PASS — 기존 테스트 포함 전부 초록.

- [ ] **Step 5: 커밋**

```bash
git add src/sessions.ts src/sessions.test.ts
git commit -m "feat(sessions): agents --json 의 짧은 id 와 state 를 싣는다"
```

---

### Task 2: `boards.path` — 메인 레포 경로

데몬에는 cwd 개념이 없어 보드 key 만으로는 레포 경로를 알 수 없다. `boards.repo`(user_version 2)와 같은 패턴으로 컬럼 하나를 더한다.

**Files:**
- Modify: `src/store.ts` (SCHEMA · `Board` · `BoardRow` · `toBoard` · `setBoardPath`)
- Modify: `src/migrations.ts` (`addBoardPath` + `MIGRATIONS`)
- Test: `src/store.test.ts`, `src/migrations.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces: `Board.path?: string`, `TodoStore.setBoardPath(key: string, path: string, actor: string): Board`, `user_version` 4.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src/store.test.ts` 끝에 추가:

```ts
describe('setBoardPath', () => {
  test('보드에 메인 레포 경로를 저장한다', () => {
    store.ensureBoard('rocky-todo', { actor: 'logan' });
    const updated = store.setBoardPath('rocky-todo', '/Users/x/dev/rocky-todo', 'logan');
    expect(updated.path).toBe('/Users/x/dev/rocky-todo');
    expect(store.getBoard('rocky-todo')?.path).toBe('/Users/x/dev/rocky-todo');
  });

  test('앞뒤 공백을 다듬고, 같은 값이면 히스토리를 남기지 않는다', () => {
    const board = store.ensureBoard('rocky-todo', { actor: 'logan' });
    store.setBoardPath('rocky-todo', '  /Users/x/dev/rocky-todo  ', 'logan');
    const before = store.listHistory({ entity: 'board', entityId: board.id }).length;
    store.setBoardPath('rocky-todo', '/Users/x/dev/rocky-todo', 'logan');
    expect(store.listHistory({ entity: 'board', entityId: board.id })).toHaveLength(before);
  });

  test('없는 보드면 던진다', () => {
    expect(() => store.setBoardPath('nope', '/tmp/x', 'logan')).toThrow(/board not found/);
  });
});
```

`src/migrations.test.ts` 에 추가:

```ts
test('user_version 4 — 기존 DB 에 boards.path 를 더한다', () => {
  const db = new Database(':memory:');
  db.run('CREATE TABLE boards (id TEXT PRIMARY KEY, key TEXT, title TEXT, created_at TEXT)');
  db.run('CREATE TABLE todos (id TEXT PRIMARY KEY, board_id TEXT, created_at TEXT)');
  db.run('CREATE TABLE notes (id TEXT PRIMARY KEY, board_id TEXT, created_at TEXT)');
  runMigrations(db);
  const columns = db.query<{ name: string }, []>('PRAGMA table_info(boards)').all();
  expect(columns.some((c) => c.name === 'path')).toBe(true);
  expect(db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version).toBe(4);
});

test('user_version 4 — path 가 이미 있는 신규 DB 에서도 기동한다', () => {
  const db = new Database(':memory:');
  db.run('CREATE TABLE boards (id TEXT PRIMARY KEY, key TEXT, title TEXT, repo TEXT, path TEXT, created_at TEXT)');
  db.run('CREATE TABLE todos (id TEXT PRIMARY KEY, board_id TEXT, created_at TEXT)');
  db.run('CREATE TABLE notes (id TEXT PRIMARY KEY, board_id TEXT, created_at TEXT)');
  expect(() => runMigrations(db)).not.toThrow();
});
```

기존 마이그레이션 테스트가 픽스처를 만드는 헬퍼를 이미 갖고 있으면 그것을 쓴다 — 위 `CREATE TABLE` 은 최소 골격일 뿐이다.

- [ ] **Step 2: 실패를 확인한다**

Run: `bun test src/store.test.ts src/migrations.test.ts`
Expected: FAIL — `store.setBoardPath is not a function`, `user_version` 이 3.

- [ ] **Step 3: 구현한다**

`src/store.ts` 의 `Board` 인터페이스:

```ts
export interface Board {
  id: string;
  key: string;
  title: string;
  /** `owner/name` — GitHub 이슈 생성 대상. 설정 전에는 undefined. */
  repo?: string;
  /** 메인 레포의 절대경로 — 백그라운드 세션을 띄우는 자리. 설정 전에는 undefined. */
  path?: string;
  createdAt: string;
  archivedAt?: string;
}
```

`BoardRow` 에 `path: string | null;` 을 더하고, `toBoard` 가 `repo` 를 옮기는 방식 그대로 `path` 를 옮긴다 (`row.path ?? undefined`).

`SCHEMA` 의 `CREATE TABLE IF NOT EXISTS boards (...)` 에 `path TEXT` 를 `repo TEXT` 옆에 더한다.

`setBoardRepo` 바로 아래에 쌍둥이 메서드를 둔다:

```ts
  /**
   * 보드의 메인 레포 경로를 설정한다 — 백그라운드 세션을 띄우는 자리다.
   *
   * `setBoardRepo` 와 같은 규칙: 값은 여기서 한 번 더 trim 하고, 같은 값이면 write 도
   * 히스토리도 남기지 않는다(no-op). 경로가 실제로 존재하는지·git 레포인지는 여기서
   * 보지 않는다 — 스토어는 파일시스템을 모르고, 그 판정은 spawn 라우트가 한다.
   *
   * @throws 없는 보드면 — 여기서 보드를 만들지 않는다(`setBoardRepo` 와 같은 판단).
   */
  setBoardPath(key: string, path: string, actor: string): Board {
    const existing = this.db
      .query<BoardRow, [string]>('SELECT * FROM boards WHERE key = ?')
      .get(key);
    if (!existing) {
      throw new Error(`board not found: ${key}`);
    }
    const normalized = path.trim();
    if (existing.path === normalized) {
      return toBoard(existing);
    }
    this.db.query('UPDATE boards SET path = ? WHERE id = ?').run(normalized, existing.id);
    this.recordHistory(
      'board',
      existing.id,
      actor,
      'update',
      { path: [existing.path ?? null, normalized] },
      existing.id,
    );
    return { ...toBoard(existing), path: normalized };
  }
```

`src/migrations.ts` — `addHandoffs` 아래에 추가하고 배열 끝에 붙인다:

```ts
/**
 * 마이그레이션 4: 보드에 메인 레포 경로를 붙인다.
 *
 * 데몬에는 cwd 개념이 없어 보드 key 만으로는 레포가 어디 있는지 알 수 없다 — 백그라운드
 * 세션을 띄우려면 그 경로가 필요하다. 기존 행에는 NULL 이 남고 CLI/웹 UI 가 나중에 채운다.
 *
 * `SCHEMA` 도 이 컬럼을 만들므로 `addBoardRepo` 와 같은 `PRAGMA table_info` 가드가 붙는다.
 */
export const addBoardPath: Migration = (db) => {
  const columns = db.query<{ name: string }, []>('PRAGMA table_info(boards)').all();
  if (columns.some((c) => c.name === 'path')) {
    return;
  }
  db.run('ALTER TABLE boards ADD COLUMN path TEXT');
};

export const MIGRATIONS: Migration[] = [addNumbers, addBoardRepo, addHandoffs, addBoardPath];
```

- [ ] **Step 4: 통과를 확인한다**

Run: `bun test src/store.test.ts src/migrations.test.ts`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add src/store.ts src/store.test.ts src/migrations.ts src/migrations.test.ts
git commit -m "feat(store): 보드에 메인 레포 경로(boards.path)를 붙인다"
```

---

### Task 3: `via='spawn'` 핸드오프 레코드

spawn 은 큐를 거치지 않고 프롬프트로 직접 배달한다. 그래도 "언제 어디로 무엇을 보냈나" 는 기존 handoff 기록에 남아야 UI·히스토리·취소 표시가 한 경로로 유지된다.

**Files:**
- Modify: `src/store.ts` (`HandoffVia` · `CreateSpawnedHandoffInput` · `createSpawnedHandoff` · `listChangesSince` 제외 목록)
- Test: `src/store.test.ts`

**Interfaces:**
- Consumes: Task 2 의 `Board.path` (직접 쓰진 않는다)
- Produces: `TodoStore.createSpawnedHandoff(input: CreateSpawnedHandoffInput): Handoff` — 생성 즉시 `status: 'delivered'`, `deliveredVia: 'spawn'`. 히스토리 action 은 `handoff-spawn`.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src/store.test.ts` 의 handoff 관련 describe 옆에 추가:

```ts
describe('createSpawnedHandoff', () => {
  test('생성 즉시 delivered / via=spawn 이다', () => {
    const todo = store.createTodo({ board: 'rocky-todo', title: '세션 띄우기' }, 'logan');
    const handoff = store.createSpawnedHandoff({
      ref: todo.id,
      sessionId: '5acaaaeb',
      sessionName: 'rocky-todo-16',
      sessionCwd: '/repo/.claude/worktrees/todo-16',
      note: '테스트부터',
      actor: 'logan',
    });
    expect(handoff.status).toBe('delivered');
    expect(handoff.deliveredVia).toBe('spawn');
    expect(handoff.deliveredAt).toBeTruthy();
    expect(handoff.sessionCwd).toBe('/repo/.claude/worktrees/todo-16');
  });

  test('pending 이 아니므로 claim 대상이 아니다', () => {
    const todo = store.createTodo({ board: 'rocky-todo', title: 'x' }, 'logan');
    store.createSpawnedHandoff({
      ref: todo.id,
      sessionId: '5acaaaeb',
      sessionName: 'n',
      sessionCwd: '/w',
      actor: 'logan',
    });
    expect(store.pendingHandoffOf(todo.id)).toBeUndefined();
    expect(store.claimHandoff('5acaaaeb', 'stop')).toBeNull();
  });

  test('히스토리에 handoff-spawn 을 남긴다', () => {
    const todo = store.createTodo({ board: 'rocky-todo', title: 'x' }, 'logan');
    store.createSpawnedHandoff({
      ref: todo.id,
      sessionId: '5acaaaeb',
      sessionName: 'n',
      sessionCwd: '/w',
      actor: 'logan',
    });
    const actions = store.listHistory({ entityId: todo.id }).map((h) => h.action);
    expect(actions).toContain('handoff-spawn');
  });

  test('/api/changes 피드에서는 빠진다 — 다른 세션의 프롬프트 주입에 실리면 노이즈다', () => {
    const todo = store.createTodo({ board: 'rocky-todo', title: 'x' }, 'logan');
    const before = store.listChangesSince(0).lastId;
    store.createSpawnedHandoff({
      ref: todo.id,
      sessionId: '5acaaaeb',
      sessionName: 'n',
      sessionCwd: '/w',
      actor: 'logan',
    });
    const actions = store.listChangesSince(before).entries.map((e) => e.action);
    expect(actions).not.toContain('handoff-spawn');
  });

  test('아카이브된 todo 에는 만들지 않는다', () => {
    const todo = store.createTodo({ board: 'rocky-todo', title: 'x' }, 'logan');
    store.setTodoStatus(todo.id, 'archive', 'logan');
    expect(() =>
      store.createSpawnedHandoff({
        ref: todo.id,
        sessionId: '5acaaaeb',
        sessionName: 'n',
        sessionCwd: '/w',
        actor: 'logan',
      }),
    ).toThrow(/archived/);
  });
});
```

`getTodoDetail` 의 실제 이름·형태가 다르면 같은 파일에서 이미 히스토리를 읽는 방식을 그대로 쓴다 — 검증 대상은 `handoff-spawn` 이 기록된다는 것 하나다.

- [ ] **Step 2: 실패를 확인한다**

Run: `bun test src/store.test.ts`
Expected: FAIL — `store.createSpawnedHandoff is not a function`.

- [ ] **Step 3: 구현한다**

`src/store.ts` 상단 타입:

```ts
/**
 * 어느 경로로 배달됐는지 — `Stop`(자동 착수) · `UserPromptSubmit`(사용자가 말을 걸 때) ·
 * `spawn`(데몬이 새 백그라운드 세션을 띄우며 프롬프트로 직접 넣은 것).
 */
export type HandoffVia = 'stop' | 'prompt' | 'spawn';

export interface CreateSpawnedHandoffInput {
  /** todo 참조 문법 (`#12` / `rocky#12` / id / id prefix). */
  ref: string;
  /** 짧은 id(8자) — 사용자가 `claude attach/logs/stop/rm` 에 그대로 넣는 값이다. */
  sessionId: string;
  sessionName: string;
  /** 워크트리 경로. `via='spawn'` 인 행에서는 표시용이 아니라 재사용 대상을 가리킨다. */
  sessionCwd: string;
  note?: string;
  actor: string;
  currentBoardId?: string;
}
```

`createHandoff` 아래에 추가:

```ts
  /**
   * 새로 띄운 백그라운드 세션 앞으로의 배달을 기록한다.
   *
   * `createHandoff` 와 달리 pending 을 거치지 않는다 — 프롬프트로 이미 배달했기 때문에
   * 생성 시점에 `delivered` 다. 그래서 claim 대상이 되지 않고, 큐를 소모하지도 않는다.
   *
   * 호출 순서가 중요하다: **spawn 이 성공한 뒤에** 부른다. 실패한 spawn 이 배달 기록을
   * 남기면 보드가 "보냈다"고 말하는데 아무도 받지 않은 상태가 된다.
   *
   * @throws todo 를 못 찾거나 아카이브됐으면.
   */
  createSpawnedHandoff(input: CreateSpawnedHandoffInput): Handoff {
    const todo = this.mustGetTodo(input.ref, input.currentBoardId);
    if (todo.archivedAt) {
      throw new Error(`todo is archived: ${todo.id}`);
    }
    const at = nowIso();
    const handoff: Handoff = {
      id: newId(),
      todoId: todo.id,
      sessionId: input.sessionId,
      sessionName: input.sessionName,
      sessionCwd: input.sessionCwd,
      note: (input.note ?? '').trim(),
      actor: input.actor,
      status: 'delivered',
      createdAt: at,
      deliveredAt: at,
      deliveredVia: 'spawn',
    };
    this.db
      .query(
        `INSERT INTO handoffs
           (id, todo_id, session_id, session_name, session_cwd, note, actor, status,
            created_at, delivered_at, delivered_via)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        handoff.id,
        handoff.todoId,
        handoff.sessionId,
        handoff.sessionName ?? null,
        handoff.sessionCwd ?? null,
        handoff.note,
        handoff.actor,
        handoff.status,
        handoff.createdAt,
        at,
        'spawn',
      );
    this.recordHistory(
      'todo',
      todo.id,
      input.actor,
      'handoff-spawn',
      { handoff: [null, handoff.sessionName ?? handoff.sessionId] },
      todo.boardId,
    );
    return handoff;
  }
```

`listChangesSince` 의 SQL 에서 handoff 계열을 걸러내는 `NOT IN` 목록에 `'handoff-spawn'` 을 더한다 — A 세션에 띄운 요청이 B·C 세션의 프롬프트 주입에 노이즈로 실리면 안 된다:

```sql
            AND action NOT IN ('handoff', 'handoff-delivered', 'handoff-cancel', 'handoff-spawn')
```

- [ ] **Step 4: 통과를 확인한다**

Run: `bun test src/store.test.ts`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add src/store.ts src/store.test.ts
git commit -m "feat(store): 새 세션 배달을 via=spawn 핸드오프로 기록한다"
```

---

### Task 4: `src/spawn.ts` — 순수 로직과 실행기

경로·이름 계산, stdout 파싱, 동시 실행 판정, 명령줄 조립을 전부 순수 함수로 두고, 실제 프로세스 기동만 주입 가능한 실행기 뒤에 숨긴다. `claude` 없는 머신에서도 이 파일의 테스트는 전부 돈다.

**Files:**
- Create: `src/spawn.ts`
- Create: `src/spawn.test.ts`
- Modify: `src/handoff.ts` (프롬프트 생성 입력 분리)

**Interfaces:**
- Consumes: Task 1 의 `AgentSession.state`
- Produces:
  - `worktreeNameFor(todoNumber: number): string`
  - `worktreePathFor(boardPath: string, todoNumber: number): string`
  - `parseBackgroundId(stdout: string): string | undefined`
  - `findLiveSessionAt(sessions: AgentSession[], worktreePath: string): AgentSession | undefined`
  - `buildSpawnCommand(input: SpawnCommandInput): string[]`
  - `type RunInDir = (cmd: string[], cwd: string, timeoutMs: number) => RunResult`
  - `spawnBackgroundSession(input: SpawnInput, run?: RunInDir): string` — 짧은 id 반환, 실패 시 throw
  - `src/handoff.ts` 의 `buildHandoffPromptFrom(input: HandoffPromptInput): string`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src/spawn.test.ts` 를 새로 만든다:

```ts
import { describe, expect, test } from 'bun:test';
import type { AgentSession } from './sessions';
import {
  buildSpawnCommand,
  findLiveSessionAt,
  parseBackgroundId,
  type RunInDir,
  spawnBackgroundSession,
  worktreeNameFor,
  worktreePathFor,
} from './spawn';

const session = (over: Partial<AgentSession>): AgentSession => ({
  pid: 1,
  cwd: '/repo',
  kind: 'background',
  sessionId: 'aaaaaaaa-0000-0000-0000-000000000000',
  name: 'n',
  status: 'idle',
  startedAt: 0,
  ...over,
});

describe('worktree 이름·경로', () => {
  test('번호로 결정론적인 이름을 만든다', () => {
    expect(worktreeNameFor(16)).toBe('todo-16');
  });

  test('Claude Code 규약 경로를 만든다', () => {
    expect(worktreePathFor('/Users/x/dev/rocky-todo', 16)).toBe(
      '/Users/x/dev/rocky-todo/.claude/worktrees/todo-16',
    );
  });

  test('보드 경로 끝의 슬래시를 흡수한다', () => {
    expect(worktreePathFor('/Users/x/dev/rocky-todo/', 16)).toBe(
      '/Users/x/dev/rocky-todo/.claude/worktrees/todo-16',
    );
  });
});

describe('parseBackgroundId', () => {
  test('backgrounded 줄에서 짧은 id 를 꺼낸다', () => {
    const stdout = [
      'backgrounded · 5acaaaeb · rocky-todo-16',
      '  claude agents             list sessions',
    ].join('\n');
    expect(parseBackgroundId(stdout)).toBe('5acaaaeb');
  });

  test('경고 줄이 앞에 있어도 찾는다', () => {
    const stdout = 'warning: something\nbackgrounded · 8c8819b4 · n';
    expect(parseBackgroundId(stdout)).toBe('8c8819b4');
  });

  test('형식이 다르면 undefined', () => {
    expect(parseBackgroundId('nothing here')).toBeUndefined();
  });
});

describe('findLiveSessionAt', () => {
  const worktree = '/repo/.claude/worktrees/todo-16';

  test('같은 워크트리에서 도는 background 세션을 찾는다', () => {
    const found = findLiveSessionAt(
      [session({ cwd: worktree, state: 'working', id: 'aaaaaaaa' })],
      worktree,
    );
    expect(found?.id).toBe('aaaaaaaa');
  });

  test('끝난 세션(state=done)은 무시한다', () => {
    expect(findLiveSessionAt([session({ cwd: worktree, state: 'done' })], worktree)).toBeUndefined();
  });

  test('state 가 없는 interactive 세션은 살아있는 것으로 본다', () => {
    const found = findLiveSessionAt(
      [session({ cwd: worktree, kind: 'interactive', name: 'hand-opened' })],
      worktree,
    );
    expect(found?.name).toBe('hand-opened');
  });

  test('다른 경로의 세션은 잡지 않는다', () => {
    expect(findLiveSessionAt([session({ cwd: '/repo' })], worktree)).toBeUndefined();
  });
});

describe('buildSpawnCommand', () => {
  test('--bg --worktree -n 과 프롬프트를 순서대로 조립한다', () => {
    expect(
      buildSpawnCommand({
        worktreeName: 'todo-16',
        sessionName: 'rocky-todo-16',
        prompt: '# rocky-todo: 보드에서 도착한 작업 요청',
      }),
    ).toEqual([
      'claude',
      '--bg',
      '--worktree',
      'todo-16',
      '-n',
      'rocky-todo-16',
      '# rocky-todo: 보드에서 도착한 작업 요청',
    ]);
  });

  test('--permission-mode 를 넣지 않는다 — 사용자 기본 설정을 따른다', () => {
    const cmd = buildSpawnCommand({ worktreeName: 'w', sessionName: 's', prompt: 'p' });
    expect(cmd).not.toContain('--permission-mode');
  });
});

describe('spawnBackgroundSession', () => {
  test('보드 경로를 cwd 로 실행하고 짧은 id 를 돌려준다', () => {
    let seenCwd = '';
    let seenCmd: string[] = [];
    const run: RunInDir = (cmd, cwd) => {
      seenCwd = cwd;
      seenCmd = cmd;
      return { ok: true, stdout: 'backgrounded · 5acaaaeb · rocky-todo-16', stderr: '' };
    };
    const id = spawnBackgroundSession(
      { boardPath: '/repo', worktreeName: 'todo-16', sessionName: 'rocky-todo-16', prompt: 'p' },
      run,
    );
    expect(id).toBe('5acaaaeb');
    expect(seenCwd).toBe('/repo');
    expect(seenCmd[0]).toBe('claude');
  });

  test('0 아닌 종료면 stderr 를 담아 던진다', () => {
    const run: RunInDir = () => ({ ok: false, stdout: '', stderr: 'claude: command not found' });
    expect(() =>
      spawnBackgroundSession(
        { boardPath: '/repo', worktreeName: 'w', sessionName: 's', prompt: 'p' },
        run,
      ),
    ).toThrow(/command not found/);
  });

  test('id 를 못 읽으면 던진다 — 성공했다고 볼 수 없다', () => {
    const run: RunInDir = () => ({ ok: true, stdout: '???', stderr: '' });
    expect(() =>
      spawnBackgroundSession(
        { boardPath: '/repo', worktreeName: 'w', sessionName: 's', prompt: 'p' },
        run,
      ),
    ).toThrow();
  });
});
```

`src/handoff.test.ts` 에 추가:

```ts
test('buildHandoffPromptFrom — claim 없이도 같은 주입문을 만든다', () => {
  const prompt = buildHandoffPromptFrom({
    actor: 'logan',
    note: '테스트부터',
    todoRef: 'rocky-todo#16',
    todoTitle: '세션 띄우기',
    remaining: 0,
  });
  expect(prompt).toContain('logan → rocky-todo#16 "세션 띄우기"');
  expect(prompt).toContain('메모: 테스트부터');
  expect(prompt).not.toContain('대기 중인 요청이');
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `bun test src/spawn.test.ts src/handoff.test.ts`
Expected: FAIL — `Cannot find module './spawn'`.

- [ ] **Step 3: 구현한다**

먼저 `src/handoff.ts` 를 분해한다 (기존 export 시그니처는 그대로 유지):

```ts
import type { ClaimedHandoff } from './store';

/** 주입문을 만드는 데 필요한 값 — claim 결과에서도, spawn 직전에도 같은 모양으로 만든다. */
export interface HandoffPromptInput {
  actor: string;
  note: string;
  todoRef: string;
  todoTitle: string;
  /** 이 세션 앞에 아직 남은 pending 건수. spawn 은 항상 0 이다. */
  remaining: number;
}

/**
 * 세션에 주입할 지시문.
 *
 * todo 본문은 싣지 않는다 — 세션이 `todo_list` 로 직접 읽으면 댓글·히스토리까지
 * 최신으로 본다. 복사하면 그 시점에 굳어버린다.
 */
export function buildHandoffPromptFrom(input: HandoffPromptInput): string {
  const lines = [
    '# rocky-todo: 보드에서 도착한 작업 요청',
    '',
    `${input.actor} → ${input.todoRef} "${input.todoTitle}"`,
  ];
  if (input.note !== '') {
    lines.push(`메모: ${input.note}`);
  }
  lines.push(
    '',
    `이 항목을 지금 착수해라. 상세는 todo_list { id: "${input.todoRef}" } 로 읽고,`,
    `착수할 때 todo_status { id: "${input.todoRef}", action: "start" } 로 표시한다.`,
  );
  if (input.remaining > 0) {
    lines.push(`(대기 중인 요청이 ${input.remaining}건 더 있다 — 이 건을 마치면 이어서 도착한다.)`);
  }
  return lines.join('\n');
}

/** claim 결과로 주입문을 만든다 — 훅(`Stop` / `UserPromptSubmit`)이 쓰는 입구. */
export function buildHandoffPrompt(claimed: ClaimedHandoff): string {
  return buildHandoffPromptFrom({
    actor: claimed.handoff.actor,
    note: claimed.handoff.note,
    todoRef: claimed.todoRef,
    todoTitle: claimed.todoTitle,
    remaining: claimed.remaining,
  });
}
```

`src/spawn.ts` 를 새로 만든다:

```ts
import type { AgentSession, RunResult } from './sessions';

/**
 * 보드에서 백그라운드 Claude Code 세션을 띄운다.
 *
 * 워크트리 생성·재사용·정리는 전부 Claude Code 의 `-w/--worktree` 가 한다 — 데몬은 git 을
 * 만지지 않는다. 이름을 `todo-<번호>` 로 결정론적으로 계산하는 것이 "이 todo 의 워크트리"
 * 라는 기억을 대신하며, 같은 이름을 다시 주면 Claude Code 가 기존 워크트리를 재사용한다.
 *
 * `src/sessions.ts` 와 같은 형태로 외부 명령은 주입 가능한 실행기를 거친다 — `claude` 가
 * 없는 머신에서도 전 테스트가 통과한다.
 */

/** Claude Code 가 워크트리를 만드는 자리 — 레포 안의 이 경로다. */
const WORKTREE_DIR = '.claude/worktrees';

/** `--bg` 가 stdout 첫 줄에 찍는 형식: `backgrounded · 5acaaaeb · <name>`. */
const BACKGROUNDED = /^backgrounded\s+·\s+(\S+)\s+·/m;

/** `claude --bg` 는 즉시 반환하지만, 프로세스 기동 자체가 늦어질 여지를 남긴다. */
const SPAWN_TIMEOUT_MS = 30_000;

export interface SpawnCommandInput {
  worktreeName: string;
  sessionName: string;
  prompt: string;
}

export interface SpawnInput extends SpawnCommandInput {
  /** 메인 레포 절대경로 — 이 자리에서 명령을 실행한다. */
  boardPath: string;
}

/** `cwd` 를 지정해 외부 명령을 실행한다. `src/sessions.ts` 의 `RunCommand` 에 cwd 를 더한 꼴. */
export type RunInDir = (cmd: string[], cwd: string, timeoutMs: number) => RunResult;

const defaultRun: RunInDir = (cmd, cwd, timeoutMs) => {
  try {
    const proc = Bun.spawnSync({ cmd, cwd, stdout: 'pipe', stderr: 'pipe', timeout: timeoutMs });
    return {
      ok: proc.exitCode === 0,
      stdout: proc.stdout.toString(),
      stderr: proc.stderr.toString(),
    };
  } catch (error) {
    return {
      ok: false,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
};

/** todo 번호 → 워크트리 이름. 결정론적이라 같은 todo 는 늘 같은 워크트리로 간다. */
export function worktreeNameFor(todoNumber: number): string {
  return `todo-${todoNumber}`;
}

/** 워크트리의 절대경로 — Claude Code 규약(`<repo>/.claude/worktrees/<name>`)을 따른다. */
export function worktreePathFor(boardPath: string, todoNumber: number): string {
  const base = boardPath.replace(/\/+$/, '');
  return `${base}/${WORKTREE_DIR}/${worktreeNameFor(todoNumber)}`;
}

/** `--bg` stdout 에서 짧은 id 를 꺼낸다. 형식이 다르면 undefined. */
export function parseBackgroundId(stdout: string): string | undefined {
  return BACKGROUNDED.exec(stdout)?.[1];
}

/**
 * 그 워크트리에서 아직 돌고 있는 세션을 찾는다 — 있으면 새로 띄우면 안 된다.
 *
 * 두 에이전트가 한 워크트리의 파일을 같이 고치는 것을 막는 가드다. `state` 는 background
 * 세션에만 붙으므로, 없으면(= interactive) 살아있는 것으로 본다 — 사람이 그 워크트리를
 * 터미널에서 열어둔 경우가 정확히 그 꼴이고, 그때야말로 끼어들면 안 된다.
 */
export function findLiveSessionAt(
  sessions: AgentSession[],
  worktreePath: string,
): AgentSession | undefined {
  return sessions.find((s) => s.cwd === worktreePath && s.state !== 'done');
}

/**
 * 명령줄을 조립한다.
 *
 * `--permission-mode` 를 넣지 않는 것이 의도다 — 사용자 settings 의 `permissions.defaultMode`
 * 를 그대로 따른다. 보드에서 모드를 고르게 하면 `bypassPermissions` 를 원격 화면에서 고를 수
 * 있는 자리가 생긴다.
 */
export function buildSpawnCommand(input: SpawnCommandInput): string[] {
  return [
    'claude',
    '--bg',
    '--worktree',
    input.worktreeName,
    '-n',
    input.sessionName,
    input.prompt,
  ];
}

/**
 * 백그라운드 세션을 띄우고 짧은 id 를 돌려준다.
 *
 * @throws 명령이 실패했거나 stdout 에서 id 를 읽지 못하면. id 를 못 읽으면 성공으로 볼 수
 *   없다 — 보드가 배달됐다고 말하는데 무엇이 떴는지 가리킬 수 없는 상태가 된다.
 */
export function spawnBackgroundSession(input: SpawnInput, run: RunInDir = defaultRun): string {
  const result = run(buildSpawnCommand(input), input.boardPath, SPAWN_TIMEOUT_MS);
  if (!result.ok) {
    const reason = `${result.stderr || result.stdout}`.trim() || 'claude --bg 실행에 실패했다';
    throw new Error(reason);
  }
  const id = parseBackgroundId(result.stdout);
  if (!id) {
    throw new Error(`세션이 떴는지 확인할 수 없다 — claude --bg 출력: ${result.stdout.trim()}`);
  }
  return id;
}
```

- [ ] **Step 4: 통과를 확인한다**

Run: `bun test src/spawn.test.ts src/handoff.test.ts`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add src/spawn.ts src/spawn.test.ts src/handoff.ts src/handoff.test.ts
git commit -m "feat(spawn): 백그라운드 세션 기동 로직과 워크트리 이름 규약"
```

---

### Task 5: `POST /api/todos/:ref/spawn`

**Files:**
- Modify: `src/server.ts`
- Modify: `src/local-request.ts` (거부 문구)
- Test: `src/server.test.ts`

**Interfaces:**
- Consumes: Task 2 `setBoardPath` · `Board.path`, Task 3 `createSpawnedHandoff`, Task 4 `worktreePathFor` / `findLiveSessionAt` / `spawnBackgroundSession` / `buildHandoffPromptFrom`
- Produces: `BuildTodoServerOptions.spawn?: (input: SpawnInput) => string` (테스트 주입), `POST /api/todos/:ref/spawn` → 201 `{handoff, reused, worktreePath, sessionShortId?}`, `GET /api/health` 에 `spawnAllowed: boolean`, `PATCH /api/boards/:key` 가 `path` 를 받는다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src/server.test.ts` 에 추가한다. 이 파일의 관례를 그대로 쓴다 — 모듈 스코프의 `handle` 을 `beforeEach` 에서 재할당하고, 요청은 `req(path, { method, body, peer })` 헬퍼로 보낸다(기본 peer 는 `127.0.0.1`).

```ts
describe('POST /api/todos/:ref/spawn', () => {
  /** 이 describe 는 세션 목록·spawn·경로 검사를 전부 주입한 핸들러로 갈아끼운다. */
  function useHandle(options: {
    sessions?: SessionsResult;
    spawn?: () => string;
    pathExists?: boolean;
  }): void {
    handle = buildTodoServer({
      store,
      sessions: () => options.sessions ?? { available: true, sessions: [] },
      spawn: options.spawn ?? (() => '5acaaaeb'),
      pathExists: () => options.pathExists ?? true,
    }).fetch;
  }

  /** 경로가 설정된 보드 + todo 하나. */
  function seed(): { number: number; id: string } {
    store.ensureBoard('rocky-todo', { actor: 'logan' });
    store.setBoardPath('rocky-todo', '/repo', 'logan');
    const todo = store.createTodo({ board: 'rocky-todo', title: '세션 띄우기' }, 'logan');
    return { number: todo.number, id: todo.id };
  }

  test('보드 경로가 없으면 400', async () => {
    useHandle({});
    const todo = store.createTodo({ board: 'rocky-todo', title: 'x' }, 'logan');
    const res = await req(`/api/todos/${todo.id}/spawn`, { method: 'POST' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/경로/);
  });

  test('비로컬 요청은 403', async () => {
    useHandle({});
    const todo = seed();
    const res = await req(`/api/todos/${todo.id}/spawn`, { method: 'POST', peer: '192.168.0.5' });
    expect(res.status).toBe(403);
  });

  test('git 워크트리가 아니면 400', async () => {
    useHandle({ pathExists: false });
    const todo = seed();
    const res = await req(`/api/todos/${todo.id}/spawn`, { method: 'POST' });
    expect(res.status).toBe(400);
  });

  test('세션이 없으면 새로 띄우고 via=spawn 으로 기록한다', async () => {
    useHandle({});
    const todo = seed();
    const res = await req(`/api/todos/${todo.id}/spawn`, {
      method: 'POST',
      body: JSON.stringify({ note: '테스트부터' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      reused: boolean;
      sessionShortId: string;
      worktreePath: string;
      handoff: { deliveredVia: string; status: string };
    };
    expect(body.reused).toBe(false);
    expect(body.sessionShortId).toBe('5acaaaeb');
    expect(body.worktreePath).toBe(`/repo/.claude/worktrees/todo-${todo.number}`);
    expect(body.handoff.deliveredVia).toBe('spawn');
    expect(body.handoff.status).toBe('delivered');
  });

  test('그 워크트리에 살아있는 세션이 있으면 spawn 대신 큐잉한다', async () => {
    store.ensureBoard('rocky-todo', { actor: 'logan' });
    store.setBoardPath('rocky-todo', '/repo', 'logan');
    const todo = store.createTodo({ board: 'rocky-todo', title: 'x' }, 'logan');
    useHandle({
      sessions: {
        available: true,
        sessions: [
          {
            pid: 1,
            cwd: `/repo/.claude/worktrees/todo-${todo.number}`,
            kind: 'background',
            sessionId: 'live-session-uuid',
            name: 'rocky-todo-live',
            status: 'busy',
            state: 'working',
            startedAt: 0,
          },
        ],
      },
      spawn: () => {
        throw new Error('살아있는 세션이 있으면 spawn 하면 안 된다');
      },
    });
    const res = await req(`/api/todos/${todo.id}/spawn`, { method: 'POST' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      reused: boolean;
      sessionShortId?: string;
      handoff: { status: string; sessionId: string };
    };
    expect(body.reused).toBe(true);
    expect(body.handoff.status).toBe('pending');
    expect(body.handoff.sessionId).toBe('live-session-uuid');
    expect(body.sessionShortId).toBeUndefined();
  });

  test('spawn 이 실패하면 400 이고 배달 기록을 남기지 않는다', async () => {
    useHandle({
      spawn: () => {
        throw new Error('claude: command not found');
      },
    });
    const todo = seed();
    const res = await req(`/api/todos/${todo.id}/spawn`, { method: 'POST' });
    expect(res.status).toBe(400);
    expect(store.listHandoffs({ todoId: todo.id })).toHaveLength(0);
  });

  test('이미 pending 이 있으면 409', async () => {
    useHandle({});
    const todo = seed();
    store.createHandoff({ ref: todo.id, sessionId: 'other-session', actor: 'logan' });
    const res = await req(`/api/todos/${todo.id}/spawn`, { method: 'POST' });
    expect(res.status).toBe(409);
  });

  test('없는 todo 면 404', async () => {
    useHandle({});
    const res = await req('/api/todos/nope/spawn', { method: 'POST' });
    expect(res.status).toBe(404);
  });
});

describe('spawn 게이트 힌트와 보드 경로', () => {
  test('GET /api/health 가 spawnAllowed 를 싣는다', async () => {
    const local = (await (await req('/api/health')).json()) as { spawnAllowed: boolean };
    expect(local.spawnAllowed).toBe(true);
    const remote = (await (await req('/api/health', { peer: '10.0.0.2' })).json()) as {
      spawnAllowed: boolean;
    };
    expect(remote.spawnAllowed).toBe(false);
  });

  test('PATCH /api/boards/:key 가 path 를 받는다', async () => {
    store.ensureBoard('rocky-todo', { actor: 'logan' });
    const res = await req('/api/boards/rocky-todo', {
      method: 'PATCH',
      body: JSON.stringify({ path: '/repo' }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { path: string }).path).toBe('/repo');
  });

  test('PATCH /api/boards/:key 는 repo 도 그대로 받는다 (회귀)', async () => {
    store.ensureBoard('rocky-todo', { actor: 'logan' });
    const res = await req('/api/boards/rocky-todo', {
      method: 'PATCH',
      body: JSON.stringify({ repo: 'minjun0219/rocky-todo' }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { repo: string }).repo).toBe('minjun0219/rocky-todo');
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `bun test src/server.test.ts`
Expected: FAIL — spawn 라우트가 없어 catch-all 404, `spawnAllowed` 는 undefined.

- [ ] **Step 3: 구현한다**

`src/local-request.ts` 끝에 문구를 더한다:

```ts
/** spawn 거부 문구 — 이슈 생성과 같은 등급의 게이트다. */
export const NON_LOCAL_SPAWN_MESSAGE =
  '백그라운드 세션 띄우기는 로컬(루프백) 요청만 할 수 있다 — 이 기계에서 파일을 고치는 프로세스를 띄우기 때문에 노출된 표면으로는 허용하지 않는다';
```

`src/server.ts` 의 `BuildTodoServerOptions` 에 두 옵션을 더한다:

```ts
  /**
   * 백그라운드 세션 기동 — 테스트 주입용. 기본은 실제 `claude --bg` 를 띄운다.
   * 짧은 id 를 돌려주고, 실패하면 던진다.
   */
  spawn?: (input: SpawnInput) => string;
  /**
   * 경로 존재 검사 — 테스트 주입용. 기본은 `existsSync`.
   * spawn 라우트가 `boards.path` 가 실재하는 git 워크트리인지 보는 데만 쓴다.
   */
  pathExists?: (path: string) => boolean;
```

파일 상단 import 를 고친다. `node:fs` · `./handoff` · `./spawn` 은 새 줄이고, 나머지 둘은 **기존 줄에 이름을 더하는 것**이다 (현재 `./local-request` 는 `isLocalRequest, NON_LOCAL_ISSUE_MESSAGE` 만, `./refs` 는 `refNeedsBoardContext, withRef` 만 가져온다):

```ts
import { existsSync } from 'node:fs';
import pkg from '../package.json' with { type: 'json' };
import { buildHandoffPromptFrom } from './handoff';
import {
  isLocalRequest,
  NON_LOCAL_ISSUE_MESSAGE,
  NON_LOCAL_SPAWN_MESSAGE,
} from './local-request';
import { refNeedsBoardContext, refOf, withRef } from './refs';
import {
  findLiveSessionAt,
  type SpawnInput,
  spawnBackgroundSession,
  worktreeNameFor,
  worktreePathFor,
} from './spawn';
```

`import` 정렬은 Biome 이 잡는다 — `bun run fix` 를 돌리면 자리는 알아서 맞는다.

`sessionsOf` 옆에 기본값을 만든다:

```ts
  const spawnSession = options.spawn ?? ((input: SpawnInput) => spawnBackgroundSession(input));
  const pathExists = options.pathExists ?? existsSync;
```

`/api/health` 응답에 한 줄 더한다 (`issueCreateAllowed` 옆):

```ts
          issueCreateAllowed: local,
          // spawn 도 이슈 생성과 같은 등급의 로컬 전용 게이트다 — UI 가 없는 버튼을
          // 그리지 않도록 미리 보는 힌트일 뿐, 강제는 spawn 라우트 자신이 한다.
          spawnAllowed: local,
```

`PATCH /api/boards/:key` 를 `repo` 와 `path` 둘 다 받게 고친다:

```ts
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
```

`POST /api/todos/:ref/handoff` 라우트 바로 아래에 spawn 라우트를 둔다:

```ts
      const todoSpawn = /^\/api\/todos\/([^/]+)\/spawn$/.exec(path);
      if (todoSpawn?.[1] && method === 'POST') {
        // 이슈 생성과 같은 등급의 게이트다 — 보드 쓰기 권한이 "이 기계에서 파일을 고치는
        // 프로세스를 띄우는 권한" 으로 확대되는 지점이라 `todo.expose` 와 무관하게 막는다.
        if (!local) {
          return errorResponse(NON_LOCAL_SPAWN_MESSAGE, 403);
        }
        const ref = decodeURIComponent(todoSpawn[1]);
        const body = await readBody(req);
        const note = typeof body.note === 'string' ? body.note : undefined;
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

        const board = store.listBoards(true).find((b) => b.id === todo.boardId);
        const boardPath = board?.path ?? '';
        if (boardPath === '') {
          return errorResponse(
            `보드 "${board?.key ?? ''}" 에 메인 레포 경로가 없다 — rocky-todo board path <절대경로> 로 설정하라`,
            400,
          );
        }
        if (!pathExists(`${boardPath.replace(/\/+$/, '')}/.git`)) {
          return errorResponse(`git 워크트리가 아니다: ${boardPath}`, 400);
        }

        const sessions = sessionsOf();
        if (!sessions.available) {
          return errorResponse(sessions.reason ?? '활성 세션 목록을 가져올 수 없다', 400);
        }

        const worktreePath = worktreePathFor(boardPath, todo.number);
        const todoRef = refOf(store, todo.boardId, todo.number, todo.id);

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
          return json({ handoff, reused: true, worktreePath }, 201);
        }

        const sessionName = `${board?.key ?? 'todo'}-${todo.number}`;
        let shortId: string;
        try {
          shortId = spawnSession({
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
          return errorResponse(error instanceof Error ? error.message : String(error), 400);
        }

        // 기록은 spawn 이 성공한 뒤에만 남긴다 — 실패한 spawn 이 배달 기록을 남기면
        // 보드가 "보냈다"고 말하는데 아무도 받지 않은 상태가 된다.
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
```

- [ ] **Step 4: 통과를 확인한다**

Run: `bun test src/server.test.ts`
Expected: PASS.

- [ ] **Step 5: 전체 게이트를 돌린다**

Run: `bun run check && bun run typecheck && bun test`
Expected: 전부 통과.

- [ ] **Step 6: 커밋**

```bash
git add src/server.ts src/server.test.ts src/local-request.ts
git commit -m "feat(server): 보드에서 백그라운드 세션을 띄우는 spawn 라우트"
```

---

### Task 6: CLI — `board path` 와 `spawn`

**Files:**
- Modify: `src/cli.ts`
- Test: `src/cli.test.ts`

**Interfaces:**
- Consumes: Task 5 의 `PATCH /api/boards/:key` (`path`), `POST /api/todos/:ref/spawn`
- Produces: `rocky-todo board path [절대경로]`, `rocky-todo spawn REF [--message "…"]`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src/cli.test.ts` 는 `runCli` 를 직접 부르지 않는다 — 순수 경로 함수를 검증하고, 실제 `Bun.serve` + `buildTodoServer` 에 `request` 로 왕복시켜 CLI 가 만든 경로가 서버에 닿는지 본다. 그 관례를 따른다.

경로 함수 테스트는 `todoRefPath` describe 안에 넣는다:

```ts
test('spawn 경로에도 board 컨텍스트를 싣는다', () => {
  expect(todoRefPath('16', '/spawn', 'rocky-todo')).toBe(
    '/api/todos/16/spawn?board=rocky-todo',
  );
});
```

왕복 테스트는 실서버를 띄우는 기존 describe 를 본떠 하나 더 만든다. 이 describe 의 서버만 spawn 을 주입한다:

```ts
describe('CLI 경로 왕복 — spawn / board path', () => {
  let dir: string;
  let store: TodoStore;
  let server: ReturnType<typeof Bun.serve>;
  let ctx: CliContext;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rocky-todo-cli-spawn-'));
    store = new TodoStore({ dbPath: join(dir, 'todo.db') });
    const api = buildTodoServer({
      store,
      sessions: () => ({ available: true, sessions: [] }),
      spawn: () => '5acaaaeb',
      pathExists: () => true,
    });
    server = Bun.serve({ port: 0, fetch: (req) => api.fetch(req, '127.0.0.1') });
    ctx = buildContext({ port: server.port, dir, actor: 'tester' });
  });

  afterEach(() => {
    server.stop(true);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('board path 가 보드에 경로를 저장한다', async () => {
    store.ensureBoard('rocky-todo', { actor: 'tester' });
    const updated = await request<Board>(ctx, 'PATCH', boardRepoPath('rocky-todo'), {
      path: '/Users/x/dev/rocky-todo',
    });
    expect(updated.path).toBe('/Users/x/dev/rocky-todo');
  });

  test('spawn 경로가 201 과 짧은 id 를 돌려준다', async () => {
    store.ensureBoard('rocky-todo', { actor: 'tester' });
    store.setBoardPath('rocky-todo', '/repo', 'tester');
    const todo = store.createTodo({ board: 'rocky-todo', title: 'x' }, 'tester');
    const result = await request<{ sessionShortId: string; reused: boolean }>(
      ctx,
      'POST',
      todoRefPath(todo.id, '/spawn', 'rocky-todo'),
      { note: '테스트부터' },
    );
    expect(result.reused).toBe(false);
    expect(result.sessionShortId).toBe('5acaaaeb');
  });
});
```

기존 describe 들이 `Bun.serve` 를 부르는 방식(포트·핸들러 배선)이 위와 다르면 그쪽을 그대로 복사한다 — 여기서 새로 검증하려는 것은 경로와 응답 두 가지뿐이다. `Board` 타입 import 가 없으면 `import type { Board } from './store'` 를 더한다.

- [ ] **Step 2: 실패를 확인한다**

Run: `bun test src/cli.test.ts`
Expected: FAIL — 알 수 없는 명령 / 사용법 에러.

- [ ] **Step 3: 구현한다**

`src/cli.ts` 의 `case 'board'` 안, `sub === 'repo'` 블록 아래에 더한다:

```ts
      if (sub === 'path') {
        // 인자를 주면 그 값, 없으면 지금 있는 자리를 쓴다 — 보통 레포 안에서 부른다.
        const target = rest[1] ?? process.cwd();
        const updated = await request<Board>(ctx, 'PATCH', boardRepoPath(board), { path: target });
        print(updated, () => `✓ ${updated.key} → ${updated.path}`);
        return;
      }
```

같은 `case 'board'` 의 usage 문구를 고친다:

```ts
      throw new Error(
        'usage: rocky-todo board ls | board add KEY [제목] | board repo [OWNER/NAME] | board path [절대경로]',
      );
```

`case 'handoff'` 아래에 새 명령을 더한다:

```ts
    case 'spawn': {
      const id = rest[0];
      if (!id) {
        throw new Error('usage: rocky-todo spawn REF [--message "본문"]');
      }
      const message = typeof flags.message === 'string' ? flags.message : undefined;
      const result = await request<{
        handoff: Handoff;
        reused: boolean;
        worktreePath: string;
        sessionShortId?: string;
      }>(ctx, 'POST', todoRefPath(id, '/spawn', board), message ? { note: message } : {});
      print(result, () =>
        result.reused
          ? `✓ ${id} → 이미 도는 세션(${result.handoff.sessionName ?? ''})에 큐잉 · ${result.worktreePath}`
          : `✓ ${id} → 새 세션 ${result.sessionShortId} · ${result.worktreePath}\n  claude attach ${result.sessionShortId}`,
      );
      return;
    }
```

`usage` 문자열(파일 상단의 도움말 블록)에도 두 줄을 더한다:

```
  rocky-todo spawn REF [--message "본문"]        그 todo 전용 워크트리에 새 세션 띄우기
  rocky-todo board ls|add|repo|path             보드 목록/추가/GitHub 레포/메인 경로
```

- [ ] **Step 4: 통과를 확인한다**

Run: `bun test src/cli.test.ts`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add src/cli.ts src/cli.test.ts
git commit -m "feat(cli): board path 와 spawn 명령"
```

---

### Task 7: 웹 UI — "새 세션 띄우기"

**Files:**
- Modify: `src/ui/store.ts`
- Modify: `src/ui/components/DetailDrawer.tsx`
- Modify: `src/ui/styles.css`

**Interfaces:**
- Consumes: Task 5 의 `POST /api/todos/:ref/spawn`, `/api/health` 의 `spawnAllowed`, `PATCH /api/boards/:key` 의 `path`
- Produces: 사용자 표면. 테스트 없음 — 이 레포의 UI 는 자동 테스트 대상이 아니다(기존 컴포넌트도 동일). 대신 Step 4 에서 손으로 확인한다.

- [ ] **Step 1: 스토어에 액션을 더한다**

`src/ui/store.ts` 의 상태 인터페이스에:

```ts
  /** `/api/health` 가 알려주는 힌트 — 이 출처에서 세션을 띄울 수 있는가. */
  spawnAllowed: boolean;
  /**
   * 그 todo 전용 워크트리에 백그라운드 세션을 띄운다. 이미 도는 세션이 있으면 서버가
   * spawn 대신 큐잉하고 `reused: true` 로 알린다.
   * @throws 서버가 거절한 이유를 그대로 던진다 — 호출자가 화면에 보여줘야 한다.
   */
  spawnSession: (
    todoId: string,
    note?: string,
  ) => Promise<{ reused: boolean; worktreePath: string; sessionShortId?: string }>;
  /** 보드의 메인 레포 경로를 설정한다. @throws 서버 거절 사유 그대로. */
  setBoardPath: (boardKey: string, path: string) => Promise<void>;
```

초기값에 `spawnAllowed: true,` 를 `issueCreateAllowed: true,` 옆에 둔다.

`loadCapabilities` 를 고친다:

```ts
  loadCapabilities: async () => {
    try {
      const health = await api<{ issueCreateAllowed?: boolean; spawnAllowed?: boolean }>(
        '/api/health',
        get().actor,
      );
      // 필드가 없는 구버전 데몬이면 낙관적으로 둔다 — 그 데몬에는 애초에 이 가드가 없다.
      set({
        issueCreateAllowed: health.issueCreateAllowed ?? true,
        spawnAllowed: health.spawnAllowed ?? true,
      });
    } catch {
      // 힌트를 못 얻는 것으로 화면이 망가지면 안 된다. 강제는 서버 몫이다.
    }
  },
```

`sendHandoff` 옆에 구현을 더한다:

```ts
  spawnSession: async (todoId, note) => {
    const { actor } = get();
    const result = await api<{
      reused: boolean;
      worktreePath: string;
      sessionShortId?: string;
    }>(`/api/todos/${todoId}/spawn`, actor, {
      method: 'POST',
      body: JSON.stringify(note ? { note } : {}),
    });
    await get().refetch();
    return result;
  },

  setBoardPath: async (boardKey, path) => {
    const { actor } = get();
    await api(`/api/boards/${encodeURIComponent(boardKey)}`, actor, {
      method: 'PATCH',
      body: JSON.stringify({ path }),
    });
    await get().refetch();
  },
```

- [ ] **Step 2: 드로어에 액션을 더한다**

`src/ui/components/DetailDrawer.tsx` 의 `IssueAction` 아래에 형제 컴포넌트를 만들고, `<IssueAction todo={todo} />` 옆에 `<SpawnAction todo={todo} />` 를 놓는다.

`IssueAction` 과 같은 원칙이다 — **실패해도 입력이 열린 채 남아** 고쳐 재시도할 수 있어야 한다.

```tsx
/**
 * 그 todo 전용 워크트리에 백그라운드 세션을 띄운다.
 *
 * 보드에 메인 레포 경로가 없으면 그 자리에서 입력받는다. `IssueAction` 과 같은 규칙으로
 * 실패해도 입력을 (다시) 열어 막다른 길을 만들지 않는다 — 브라우저만 쓰는 사용자에게는
 * 이 화면이 유일한 설정 경로다.
 */
function SpawnAction({ todo }: { todo: TodoView }) {
  const boards = useUiStore((s) => s.boards);
  const spawnAllowed = useUiStore((s) => s.spawnAllowed);
  const spawnSession = useUiStore((s) => s.spawnSession);
  const setBoardPath = useUiStore((s) => s.setBoardPath);
  const [path, setPath] = useState('');
  const [note, setNote] = useState('');
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    reused: boolean;
    worktreePath: string;
    sessionShortId?: string;
  } | null>(null);

  const board = boards.find((b) => b.id === todo.boardId);

  if (!spawnAllowed) {
    return (
      <div className="spawn-action">
        <p className="spawn-unavailable">
          세션 띄우기는 로컬(루프백)에서만 — 이 화면은 노출된 데몬을 거쳐 열렸다.
        </p>
      </div>
    );
  }

  const submit = async (): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      if (asking && board) {
        await setBoardPath(board.key, path.trim());
      }
      setResult(await spawnSession(todo.id, note.trim() || undefined));
      setAsking(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setAsking(true);
      setPath(path || board?.path || '');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="spawn-action">
      {asking && (
        <input
          className="spawn-path-input"
          value={path}
          placeholder="/Users/…/레포 절대경로"
          aria-label="메인 레포 절대경로"
          onChange={(e) => setPath(e.target.value)}
        />
      )}
      <input
        className="spawn-note-input"
        value={note}
        placeholder="메모 (선택)"
        aria-label="세션에 함께 보낼 메모"
        onChange={(e) => setNote(e.target.value)}
      />
      <div className="drawer-actions">
        <button
          type="button"
          className="drawer-btn"
          disabled={busy || (asking && path.trim() === '')}
          onClick={() => {
            if (!board?.path && !asking) {
              setAsking(true);
              setPath(board?.path ?? '');
              return;
            }
            void submit();
          }}
        >
          {busy ? '띄우는 중…' : '새 세션 띄우기'}
        </button>
      </div>
      {result && (
        <div className="spawn-result">
          {result.reused ? (
            <span>이미 도는 세션에 넘겼다 · {result.worktreePath}</span>
          ) : (
            <>
              <span>세션 {result.sessionShortId} · {result.worktreePath}</span>
              <code>claude attach {result.sessionShortId}</code>
            </>
          )}
        </div>
      )}
      {/* 실패 사유는 즉시 읽혀야 한다 — 보이기만 하면 스크린리더가 놓친다. */}
      {error && (
        <div className="spawn-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: 스타일을 더한다**

`src/ui/styles.css` 의 handoff 블록 아래에 붙인다. 기존 `.issue-*` 규칙의 값을 그대로 따라 색·간격을 맞춘다:

```css
/* ── spawn — 새 세션 띄우기 ─────────────────────────────────────────────── */
.spawn-action {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.spawn-path-input,
.spawn-note-input {
  width: 100%;
}

.spawn-result {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--handoff);
}

.spawn-result code {
  user-select: all;
}

.spawn-unavailable,
.spawn-error {
  font-size: 12px;
}
```

- [ ] **Step 4: 손으로 확인한다**

```bash
bun run src/daemon.ts
```

브라우저에서 `http://127.0.0.1:8636` 을 열고: (1) 경로가 없는 보드의 todo 드로어에서 "새 세션 띄우기" 를 누르면 경로 입력이 열리는지, (2) 잘못된 경로를 넣으면 에러가 뜨고 입력이 **열린 채 남는지**, (3) 올바른 경로로 다시 누르면 세션이 뜨고 짧은 id 와 워크트리 경로가 보이는지, (4) 같은 todo 를 한 번 더 누르면 "이미 도는 세션에 넘겼다" 로 바뀌는지 확인한다.

확인이 끝나면 `claude rm <짧은 id>` 로 띄운 세션과 워크트리를 정리한다.

- [ ] **Step 5: 게이트를 돌리고 커밋**

Run: `bun run check && bun run typecheck && bun test`
Expected: 전부 통과.

```bash
git add src/ui/store.ts src/ui/components/DetailDrawer.tsx src/ui/styles.css
git commit -m "feat(ui): 드로어에서 새 백그라운드 세션 띄우기"
```

---

### Task 8: 문서 동기화와 changeset

**Files:**
- Modify: `FEATURES.md`, `AGENTS.md`, `README.md`, `docs/rocky-todo.md`
- Create: `.changeset/<자동 생성>.md`

**Interfaces:**
- Consumes: Task 1–7 전부
- Produces: 없음 (문서)

- [ ] **Step 1: `AGENTS.md` 를 고친다**

- Layout 트리에 `src/spawn.ts` 한 줄을 `src/handoff.ts` 아래에 더한다: `# 백그라운드 세션 기동 (워크트리 이름 규약 + claude --bg)`
- "데몬/설치 모델 (핵심)" 의 **핸드오프(보드 → 세션)** 항목 끝에 문단을 잇는다:

```
- **새 세션 띄우기(보드 → 새 워크트리)**: 실행 중인 세션이 없으면 보드가 `claude --bg
  --worktree todo-<번호>` 로 새 백그라운드 세션을 띄운다(`src/spawn.ts`). 워크트리 생성·
  재사용·정리는 전부 Claude Code 몫이고(`<repo>/.claude/worktrees/`, 정리는 `claude rm
  <id>`), 데몬은 이름을 결정론적으로 계산할 뿐이라 "이 todo 의 워크트리" 를 저장하지
  않는다. 대상 레포 경로는 `boards.path`(user_version 4). 그 워크트리에서 이미 도는
  세션이 있으면 **띄우지 않고** 기존 handoff 큐로 넘긴다 — 두 에이전트가 한 워크트리를
  같이 고치는 것을 막는 가드다. `--permission-mode` 는 넘기지 않는다(사용자 기본 설정).
  **이슈 생성과 같은 로컬 요청 전용**(`isLocalRequest`, 403) — 보드 쓰기 권한이 프로세스를
  띄우는 권한으로 확대되는 지점이다. MCP 도구는 여전히 5개다.
```

- [ ] **Step 2: `FEATURES.md` 를 고친다**

핸드오프를 설명하는 절에 새 세션 띄우기를 사람 말로 더한다: 드로어의 "새 세션 띄우기" 버튼, 보드마다 메인 레포 경로가 필요하다는 것(`rocky-todo board path <절대경로>` 또는 드로어 입력), 워크트리가 `<레포>/.claude/worktrees/todo-<번호>` 에 생긴다는 것, 정리는 `claude rm <id>` 라는 것, 로컬에서만 된다는 것. CLI 표에 `spawn` 과 `board path` 행을 더한다.

- [ ] **Step 3: `README.md` · `docs/rocky-todo.md` 를 고친다**

`README.md` 는 한 줄 요약 수준으로 — 기존 핸드오프 언급 옆에 "세션이 없으면 새로 띄울 수도 있다" 를 덧붙인다. `docs/rocky-todo.md` 에는 운영 관점을 쓴다: 보드 경로 설정 방법, 워크트리가 쌓이는 자리와 정리 명령(`claude rm`), 로컬 전용이라 tailscale 로 열어도 이 버튼은 안 뜬다는 것.

- [ ] **Step 4: changeset 을 만든다**

```bash
bunx changeset
```

`minor` 를 고르고 요약을 쓴다: `보드에서 todo 전용 워크트리에 백그라운드 Claude Code 세션을 띄울 수 있다 (로컬 전용)`.

- [ ] **Step 5: 게이트를 돌리고 커밋**

Run: `bun run check && bun run typecheck && bun test`
Expected: 전부 통과.

```bash
git add FEATURES.md AGENTS.md README.md docs/rocky-todo.md .changeset
git commit -m "docs: 보드에서 백그라운드 세션 띄우기 문서화"
```

---

## 완료 조건

- `bun run check` · `bun run typecheck` · `bun test` 전부 통과.
- `claude` CLI 가 없는 머신에서도 위 셋이 통과한다 (외부 명령은 전부 주입 뒤에 있다).
- MCP 도구 수가 5개 그대로다.
- 보드 `rocky-todo#16` 에 결과를 댓글로 남기고 `done` 으로 넘긴다.
