# 에이전트 작업 요청 핸드오프 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 보드에서 todo 를 실행 중인 Claude Code 세션에 넘기면, 그 세션이 턴을 끝내는 순간 자동으로 착수한다.

**Architecture:** 데몬은 세션에 밀 수 없다(훅으로 유휴 세션을 깨울 수단이 없다). 그래서 데몬이 `handoffs` 큐를 들고, 세션 쪽 훅(`Stop` 신규 + 기존 `UserPromptSubmit`)이 자기 `sessionId` 앞으로 온 것만 당겨간다. 세션 목록은 `claude agents --json` 을 감싼 `src/sessions.ts` 가 제공한다 — `src/tailscale.ts` 와 같은 주입 가능 `RunCommand` 패턴이라 `claude` CLI 가 없어도 전 테스트가 통과한다.

**Tech Stack:** TypeScript (`type: module`), Bun 런타임, `bun:sqlite`, `bun:test`, React + zustand(웹 UI), Biome.

설계 문서: `docs/superpowers/specs/2026-07-26-agent-handoff-design.md`

## Global Constraints

- 새 런타임 의존성을 추가하지 않는다. prod dep 은 현재 5개(`@modelcontextprotocol/sdk`, `react`, `react-dom`, `zustand`, `zod`) 그대로.
- import 에 `.js`/`.ts` 확장자를 붙이지 않는다. 전부 상대경로. `src/*` 끼리는 `./`, `hooks/*` 에서는 `../src/*`.
- `__dirname` 금지 — `import.meta.dir` / `import.meta.url`.
- **MCP 도구는 5개를 유지한다.** 이 기능으로 도구를 추가하지 않는다.
- 훅은 전부 **fail-open** — 어떤 에러에서도 exit 0, 세션 동작을 막지 않는다.
- 모든 테스트는 `claude` CLI 가 설치되지 않은 머신에서도 통과해야 한다.
- 게이트: `bun run check` · `bun run typecheck` · `bun test` 전부 통과.
- JSDoc 은 exported 함수/클래스에. 주석은 한국어, 코드 식별자/경로/명령은 영어 원형.
- 커밋 메시지는 Conventional Commits (`type(scope): 한국어 요약`).

---

### Task 1: `src/sessions.ts` — 활성 세션 목록과 보드 매칭

**Files:**
- Create: `src/sessions.ts`
- Test: `src/sessions.test.ts`

**Interfaces:**
- Consumes: 없음 (첫 태스크)
- Produces:
  - `interface AgentSession { pid: number; cwd: string; kind: string; sessionId: string; name: string; status: string; startedAt: number }`
  - `type RunCommand = (cmd: string[], timeoutMs: number) => { ok: boolean; stdout: string; stderr: string }`
  - `interface SessionsResult { available: boolean; sessions: AgentSession[]; reason?: string }`
  - `function listSessions(run?: RunCommand): SessionsResult`
  - `function matchBoard(sessions: AgentSession[], boardKey: string): AgentSession[]`

- [ ] **Step 1: Write the failing test**

Create `src/sessions.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { type AgentSession, listSessions, matchBoard, type RunCommand } from './sessions';

const SAMPLE = JSON.stringify([
  {
    pid: 19921,
    cwd: '/Users/minjun/dev/workspaces/rocky-todo',
    kind: 'interactive',
    startedAt: 1784964736538,
    sessionId: 'bc29bdd3-ba90-4547-96eb-9db0af935e6c',
    name: 'rocky-todo-1e',
    status: 'idle',
  },
  {
    pid: 32551,
    cwd: '/Users/minjun/orca/workspaces/rocky-todo/eelpout',
    kind: 'interactive',
    startedAt: 1785067158470,
    sessionId: '5591d3d2-9ac5-49c4-96b2-2b3e7bdcfce6',
    name: 'eelpout-a3',
    status: 'busy',
  },
]);

const runWith = (stdout: string, ok = true): RunCommand => () => ({ ok, stdout, stderr: '' });

describe('listSessions', () => {
  test('claude agents --json 출력을 파싱한다', () => {
    const result = listSessions(runWith(SAMPLE));
    expect(result.available).toBe(true);
    expect(result.sessions).toHaveLength(2);
    expect(result.sessions[0]?.name).toBe('rocky-todo-1e');
    expect(result.sessions[1]?.status).toBe('busy');
  });

  test('세션이 하나도 없으면 available 이지만 빈 목록', () => {
    const result = listSessions(runWith('[]'));
    expect(result.available).toBe(true);
    expect(result.sessions).toEqual([]);
  });

  test('CLI 실행 실패는 available:false + reason', () => {
    const result = listSessions(() => ({ ok: false, stdout: '', stderr: 'command not found' }));
    expect(result.available).toBe(false);
    expect(result.reason).toContain('command not found');
    expect(result.sessions).toEqual([]);
  });

  test('깨진 JSON 은 available:false', () => {
    const result = listSessions(runWith('not json'));
    expect(result.available).toBe(false);
    expect(result.sessions).toEqual([]);
  });

  test('필수 필드가 빠진 항목은 건너뛴다', () => {
    const result = listSessions(runWith(JSON.stringify([{ pid: 1 }, JSON.parse(SAMPLE)[0]])));
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]?.name).toBe('rocky-todo-1e');
  });
});

describe('matchBoard', () => {
  const sessions = listSessions(runWith(SAMPLE)).sessions;

  test('경로 세그먼트가 보드 key 와 같으면 후보다 — 워크트리도 잡는다', () => {
    const matched = matchBoard(sessions, 'rocky-todo');
    expect(matched.map((s: AgentSession) => s.name)).toEqual(['rocky-todo-1e', 'eelpout-a3']);
  });

  test('basename 만 맞는 게 아니라 중간 세그먼트도 센다', () => {
    expect(matchBoard(sessions, 'eelpout').map((s: AgentSession) => s.name)).toEqual(['eelpout-a3']);
  });

  test('일치가 없으면 빈 배열', () => {
    expect(matchBoard(sessions, 'forses')).toEqual([]);
  });

  test('부분 문자열은 일치로 치지 않는다', () => {
    expect(matchBoard(sessions, 'rocky')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/sessions.test.ts`
Expected: FAIL — `Cannot find module './sessions'`

- [ ] **Step 3: Write the implementation**

Create `src/sessions.ts`:

```ts
/**
 * 활성 Claude Code 세션 목록 — `claude agents --json` 을 감싼다.
 *
 * 데몬은 세션에 아무것도 밀 수 없으므로(훅으로 유휴 세션을 깨울 수단이 없다) 세션을
 * "고르는" 일만 여기서 한다. 세션이 자기를 데몬에 등록하는 프로토콜을 따로 만들지 않는
 * 이유가 이것 — CLI 가 이미 pid/cwd/sessionId/name/status 를 다 준다.
 *
 * `src/tailscale.ts` 와 같은 형태로 외부 명령은 주입 가능한 `RunCommand` 를 거친다 —
 * `claude` 가 없는 머신에서도 전 테스트가 통과한다.
 */

export interface AgentSession {
  pid: number;
  cwd: string;
  /** 'interactive' | 'background' — CLI 가 주는 값을 그대로 둔다. */
  kind: string;
  sessionId: string;
  /** 사람이 읽는 세션 이름 (예: `eelpout-a3`). */
  name: string;
  /** 'idle' | 'busy' — CLI 가 주는 값을 그대로 둔다. */
  status: string;
  startedAt: number;
}

export interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export type RunCommand = (cmd: string[], timeoutMs: number) => RunResult;

export interface SessionsResult {
  /** 세션 목록을 얻을 수 있었는가. false 면 이 기능 전체가 비활성이다. */
  available: boolean;
  sessions: AgentSession[];
  /** available 이 false 인 이유 — 사용자에게 그대로 보여준다. */
  reason?: string;
}

/** 기본 실행기 — Bun 참조를 이 함수 본문 안에만 둬서 다른 번들 타깃에서 안전하다. */
const defaultRun: RunCommand = (cmd, timeoutMs) => {
  try {
    const proc = Bun.spawnSync({ cmd, stdout: 'pipe', stderr: 'pipe', timeout: timeoutMs });
    return {
      ok: proc.exitCode === 0,
      stdout: proc.stdout.toString(),
      stderr: proc.stderr.toString(),
    };
  } catch (error) {
    return { ok: false, stdout: '', stderr: error instanceof Error ? error.message : String(error) };
  }
};

function toSession(value: unknown): AgentSession | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const row = value as Record<string, unknown>;
  if (
    typeof row.pid !== 'number' ||
    typeof row.cwd !== 'string' ||
    typeof row.sessionId !== 'string' ||
    typeof row.name !== 'string'
  ) {
    return null;
  }
  return {
    pid: row.pid,
    cwd: row.cwd,
    kind: typeof row.kind === 'string' ? row.kind : 'interactive',
    sessionId: row.sessionId,
    name: row.name,
    status: typeof row.status === 'string' ? row.status : 'idle',
    startedAt: typeof row.startedAt === 'number' ? row.startedAt : 0,
  };
}

/**
 * 활성 세션(interactive + background)을 나열한다.
 * @param run 테스트 주입용. 기본은 `claude agents --json` 을 실제로 실행한다.
 */
export function listSessions(run: RunCommand = defaultRun): SessionsResult {
  const result = run(['claude', 'agents', '--json'], 5_000);
  if (!result.ok) {
    const reason = `${result.stderr || result.stdout}`.trim() || 'claude CLI 를 실행할 수 없다';
    return { available: false, sessions: [], reason };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return { available: false, sessions: [], reason: 'claude agents --json 출력을 읽을 수 없다' };
  }
  if (!Array.isArray(parsed)) {
    return { available: false, sessions: [], reason: 'claude agents --json 출력이 배열이 아니다' };
  }
  const sessions: AgentSession[] = [];
  for (const item of parsed) {
    const session = toSession(item);
    if (session) {
      sessions.push(session);
    }
  }
  return { available: true, sessions };
}

/**
 * 보드 key 로 후보 세션을 고른다 — **cwd 의 경로 세그먼트 중 하나가 key 와 정확히
 * 일치**하면 후보다.
 *
 * basename 만 보면 워크트리를 놓친다: `/Users/x/orca/workspaces/rocky-todo/eelpout` 의
 * basename 은 `eelpout` 이다. 세그먼트로 보면 원본 레포와 워크트리가 둘 다 잡히고,
 * 후보가 2개면 호출자가 사용자에게 묻는다 — 의도한 동작이다.
 */
export function matchBoard(sessions: AgentSession[], boardKey: string): AgentSession[] {
  if (boardKey === '') {
    return [];
  }
  return sessions.filter((session) => session.cwd.split('/').includes(boardKey));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/sessions.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Gate + commit**

```bash
bun run check && bun run typecheck && bun test
git add src/sessions.ts src/sessions.test.ts
git commit -m "feat(sessions): claude agents --json 으로 활성 세션 목록"
```

---

### Task 2: `handoffs` 테이블 + 스토어 연산

**Files:**
- Modify: `src/store.ts` (SCHEMA 에 테이블 추가, 타입/Row 정의, handoff 연산 추가, `listChangesSince` 필터)
- Modify: `src/migrations.ts` (마이그레이션 2 추가)
- Test: `src/store.test.ts` (추가), `src/migrations.test.ts` (추가)

**Interfaces:**
- Consumes: Task 1 의 `AgentSession` (스냅샷 필드를 채우는 쪽은 Task 4 — 여기서는 문자열만 받는다)
- Produces (모두 `TodoStore` 의 메서드):
  - `interface Handoff { id: string; todoId: string; sessionId: string; sessionName?: string; sessionCwd?: string; note: string; actor: string; status: HandoffStatus; createdAt: string; deliveredAt?: string; deliveredVia?: HandoffVia }`
  - `type HandoffStatus = 'pending' | 'delivered' | 'cancelled'`
  - `type HandoffVia = 'stop' | 'prompt'`
  - `createHandoff(input: CreateHandoffInput): Handoff`
  - `listHandoffs(filter?: { boardId?: string; todoId?: string; status?: HandoffStatus }): Handoff[]`
  - `pendingHandoffOf(todoId: string): Handoff | undefined`
  - `claimHandoff(sessionId: string, via: HandoffVia): ClaimedHandoff | null`
  - `cancelHandoff(id: string, actor: string): Handoff`
  - `interface ClaimedHandoff { handoff: Handoff; todoRef: string; todoTitle: string; remaining: number }`

- [ ] **Step 1: Write the failing tests**

Append to `src/store.test.ts`. 이 파일은 상단 `beforeEach` 가 만드는 **모듈 스코프 `store`** 를 쓰고, `createTodo` 의 actor 는 **두 번째 인자**다 (`createTodo(input, actor)`):

```ts
describe('handoffs', () => {
  test('생성하면 pending 이고 todo 히스토리에 남는다', () => {
    const todo = store.createTodo({ board: 'rocky-todo', title: '핸드오프 대상' }, 'logan');

    const handoff = store.createHandoff({
      ref: todo.id,
      sessionId: 'sess-1',
      sessionName: 'eelpout-a3',
      sessionCwd: '/w/rocky-todo/eelpout',
      note: '테스트부터',
      actor: 'logan',
    });

    expect(handoff.status).toBe('pending');
    expect(handoff.todoId).toBe(todo.id);
    expect(handoff.note).toBe('테스트부터');
    const history = store.listHistory({ entityId: todo.id });
    expect(history.some((h) => h.action === 'handoff')).toBe(true);
  });

  test('같은 todo 에 pending 이 이미 있으면 pendingHandoffOf 가 그것을 준다', () => {
    const todo = store.createTodo({ board: 'rocky-todo', title: 'x' }, 'logan');
    const first = store.createHandoff({ ref: todo.id, sessionId: 'sess-1', actor: 'logan' });
    expect(store.pendingHandoffOf(todo.id)?.id).toBe(first.id);
  });

  test('아카이브된 todo 로는 만들 수 없다', () => {
    const todo = store.createTodo({ board: 'rocky-todo', title: 'x' }, 'logan');
    store.setTodoStatus(todo.id, 'archive', 'logan');
    expect(() => store.createHandoff({ ref: todo.id, sessionId: 's', actor: 'logan' })).toThrow(
      /archived/i,
    );
  });

  test('claim 은 가장 오래된 한 건만 가져가고 잔여 수를 알려준다', () => {
    const a = store.createTodo({ board: 'rocky-todo', title: '첫째' }, 'logan');
    const b = store.createTodo({ board: 'rocky-todo', title: '둘째' }, 'logan');
    store.createHandoff({ ref: a.id, sessionId: 'sess-1', actor: 'logan' });
    store.createHandoff({ ref: b.id, sessionId: 'sess-1', actor: 'logan' });

    const claimed = store.claimHandoff('sess-1', 'stop');
    expect(claimed?.todoTitle).toBe('첫째');
    expect(claimed?.todoRef).toBe('rocky-todo#1');
    expect(claimed?.remaining).toBe(1);
    expect(claimed?.handoff.status).toBe('delivered');
    expect(claimed?.handoff.deliveredVia).toBe('stop');

    const second = store.claimHandoff('sess-1', 'prompt');
    expect(second?.todoTitle).toBe('둘째');
    expect(second?.remaining).toBe(0);

    expect(store.claimHandoff('sess-1', 'stop')).toBeNull();
  });

  test('claim 은 다른 세션 앞의 요청을 가져가지 않는다', () => {
    const todo = store.createTodo({ board: 'rocky-todo', title: 'x' }, 'logan');
    store.createHandoff({ ref: todo.id, sessionId: 'sess-1', actor: 'logan' });
    expect(store.claimHandoff('sess-2', 'stop')).toBeNull();
  });

  test('취소하면 cancelled 가 되고 다시 claim 되지 않는다', () => {
    const todo = store.createTodo({ board: 'rocky-todo', title: 'x' }, 'logan');
    const handoff = store.createHandoff({ ref: todo.id, sessionId: 'sess-1', actor: 'logan' });
    const cancelled = store.cancelHandoff(handoff.id, 'logan');
    expect(cancelled.status).toBe('cancelled');
    expect(store.claimHandoff('sess-1', 'stop')).toBeNull();
    expect(store.pendingHandoffOf(todo.id)).toBeUndefined();
  });

  test('이미 배달된 건은 취소할 수 없다', () => {
    const todo = store.createTodo({ board: 'rocky-todo', title: 'x' }, 'logan');
    const handoff = store.createHandoff({ ref: todo.id, sessionId: 'sess-1', actor: 'logan' });
    store.claimHandoff('sess-1', 'stop');
    expect(() => store.cancelHandoff(handoff.id, 'logan')).toThrow(/pending/i);
  });

  test('listHandoffs 는 보드로 거를 수 있다', () => {
    const mine = store.createTodo({ board: 'rocky-todo', title: 'x' }, 'logan');
    const other = store.createTodo({ board: 'forses', title: 'y' }, 'logan');
    store.createHandoff({ ref: mine.id, sessionId: 's1', actor: 'logan' });
    store.createHandoff({ ref: other.id, sessionId: 's2', actor: 'logan' });

    const boardId = store.boardIdOf('rocky-todo');
    const listed = store.listHandoffs({ boardId, status: 'pending' });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.todoId).toBe(mine.id);
  });

  test('handoff 액션은 /api/changes 피드에서 빠진다 — 다른 세션에 노이즈를 뿌리지 않는다', () => {
    const todo = store.createTodo({ board: 'rocky-todo', title: 'x' }, 'logan');
    const before = store.listChangesSince(0).lastId;
    store.createHandoff({ ref: todo.id, sessionId: 'sess-1', actor: 'logan' });

    const feed = store.listChangesSince(before);
    expect(feed.entries.some((e) => e.action.startsWith('handoff'))).toBe(false);
    // 커서는 그래도 전진해야 한다 — 아니면 같은 항목을 영원히 다시 읽는다.
    expect(feed.lastId).toBeGreaterThan(before);
  });
});
```

Append to `src/migrations.test.ts`:

```ts
test('마이그레이션 2 — 기존 DB 에 handoffs 테이블을 만든다', () => {
  const db = new Database(':memory:');
  db.run(`CREATE TABLE todos (id TEXT PRIMARY KEY, board_id TEXT, created_at TEXT)`);
  db.run(`CREATE TABLE notes (id TEXT PRIMARY KEY, board_id TEXT, created_at TEXT)`);
  db.run('PRAGMA user_version = 1');

  const version = runMigrations(db, { migrations: MIGRATIONS });

  expect(version).toBe(MIGRATIONS.length);
  const table = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='handoffs'",
    )
    .get();
  expect(table?.name).toBe('handoffs');
  db.close();
});

test('마이그레이션 2 — 테이블이 이미 있어도(신규 DB) 실패하지 않는다', () => {
  const db = new Database(':memory:');
  db.run(`CREATE TABLE todos (id TEXT PRIMARY KEY, board_id TEXT, created_at TEXT)`);
  db.run(`CREATE TABLE notes (id TEXT PRIMARY KEY, board_id TEXT, created_at TEXT)`);
  db.run('CREATE TABLE handoffs (id TEXT PRIMARY KEY)');
  db.run('PRAGMA user_version = 1');

  expect(() => runMigrations(db, { migrations: MIGRATIONS })).not.toThrow();
  db.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/store.test.ts src/migrations.test.ts`
Expected: FAIL — `store.createHandoff is not a function`, `handoffs` 테이블 없음

- [ ] **Step 3: Add the schema**

In `src/store.ts`, add to the `SCHEMA` template literal, right after the `comments` table (before the `CREATE INDEX` lines):

```sql
CREATE TABLE IF NOT EXISTS handoffs (
  id            TEXT PRIMARY KEY,
  todo_id       TEXT NOT NULL REFERENCES todos(id),
  session_id    TEXT NOT NULL,
  session_name  TEXT,
  session_cwd   TEXT,
  note          TEXT NOT NULL DEFAULT '',
  actor         TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('pending','delivered','cancelled')),
  created_at    TEXT NOT NULL,
  delivered_at  TEXT,
  delivered_via TEXT
);
```

And add to the index block at the end of `SCHEMA`:

```sql
CREATE INDEX IF NOT EXISTS idx_handoffs_session ON handoffs(session_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_handoffs_todo ON handoffs(todo_id, status);
```

- [ ] **Step 4: Add the migration**

In `src/migrations.ts`, add before the `MIGRATIONS` export:

```ts
/**
 * 마이그레이션 3: 핸드오프 큐 테이블.
 *
 * 신규 DB 는 `SCHEMA` 로 이 테이블을 갖고 태어나므로 `IF NOT EXISTS` 가드가 필요하다 —
 * 마이그레이션은 신규/기존 DB 양쪽에서 실행된다.
 */
const addHandoffs: Migration = (db) => {
  db.run(`
    CREATE TABLE IF NOT EXISTS handoffs (
      id            TEXT PRIMARY KEY,
      todo_id       TEXT NOT NULL REFERENCES todos(id),
      session_id    TEXT NOT NULL,
      session_name  TEXT,
      session_cwd   TEXT,
      note          TEXT NOT NULL DEFAULT '',
      actor         TEXT NOT NULL,
      status        TEXT NOT NULL CHECK (status IN ('pending','delivered','cancelled')),
      created_at    TEXT NOT NULL,
      delivered_at  TEXT,
      delivered_via TEXT
    )
  `);
  db.run(
    'CREATE INDEX IF NOT EXISTS idx_handoffs_session ON handoffs(session_id, status, created_at)',
  );
  db.run('CREATE INDEX IF NOT EXISTS idx_handoffs_todo ON handoffs(todo_id, status)');
};
```

Change the export:

```ts
export const MIGRATIONS: Migration[] = [addNumbers, addHandoffs];
```

- [ ] **Step 5: Add types and row mapper to `src/store.ts`**

Add near the other exported interfaces (after `Comment`):

```ts
export type HandoffStatus = 'pending' | 'delivered' | 'cancelled';
/** 어느 훅이 집어갔는지 — `Stop`(자동 착수) 인지 `UserPromptSubmit`(사용자가 말을 걸 때) 인지. */
export type HandoffVia = 'stop' | 'prompt';

/** 보드에서 실행 중인 Claude Code 세션으로 넘긴 작업 요청 한 건. */
export interface Handoff {
  id: string;
  todoId: string;
  sessionId: string;
  /** 표시용 스냅샷 — 세션이 사라지면 sessionId 만으로는 어디로 보냈는지 읽을 수 없다. */
  sessionName?: string;
  sessionCwd?: string;
  note: string;
  actor: string;
  status: HandoffStatus;
  createdAt: string;
  deliveredAt?: string;
  deliveredVia?: HandoffVia;
}

export interface CreateHandoffInput {
  /** todo 참조 문법 (`#12` / `rocky#12` / id / id prefix). */
  ref: string;
  sessionId: string;
  sessionName?: string;
  sessionCwd?: string;
  note?: string;
  actor: string;
  currentBoardId?: string;
}

/** claim 결과 — 훅이 주입문을 만드는 데 필요한 것을 한 번에 준다. */
export interface ClaimedHandoff {
  handoff: Handoff;
  /** `rocky-todo#11` 형태의 사람이 읽는 참조. */
  todoRef: string;
  todoTitle: string;
  /** 이 세션 앞에 아직 남은 pending 건수. */
  remaining: number;
}

interface HandoffRow {
  id: string;
  todo_id: string;
  session_id: string;
  session_name: string | null;
  session_cwd: string | null;
  note: string;
  actor: string;
  status: HandoffStatus;
  created_at: string;
  delivered_at: string | null;
  delivered_via: string | null;
}

function toHandoff(row: HandoffRow): Handoff {
  return {
    id: row.id,
    todoId: row.todo_id,
    sessionId: row.session_id,
    sessionName: row.session_name ?? undefined,
    sessionCwd: row.session_cwd ?? undefined,
    note: row.note,
    actor: row.actor,
    status: row.status,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at ?? undefined,
    deliveredVia: (row.delivered_via as HandoffVia | null) ?? undefined,
  };
}
```

- [ ] **Step 6: Add the store methods**

Add a new section to the `TodoStore` class, after the comments section:

```ts
  // ── handoffs ──────────────────────────────────────────────────────────────

  /**
   * todo 를 실행 중인 세션 앞으로 넘긴다.
   *
   * 히스토리는 댓글과 같은 방식으로 **부모 todo 의 것으로**(`entity='todo'`) 기록해
   * 상세 타임라인과 SSE 를 그대로 탄다. 다만 `/api/changes` 피드에서는 빠진다 —
   * `listChangesSince` 참고.
   * @throws todo 를 못 찾거나, 아카이브됐거나, 이미 pending 이 있으면.
   */
  createHandoff(input: CreateHandoffInput): Handoff {
    const todo = this.mustGetTodo(input.ref, input.currentBoardId);
    if (todo.archivedAt) {
      throw new Error(`todo is archived: ${todo.id}`);
    }
    if (this.pendingHandoffOf(todo.id)) {
      throw new Error(`handoff already pending for todo: ${todo.id}`);
    }
    const handoff: Handoff = {
      id: newId(),
      todoId: todo.id,
      sessionId: input.sessionId,
      sessionName: input.sessionName,
      sessionCwd: input.sessionCwd,
      note: (input.note ?? '').trim(),
      actor: input.actor,
      status: 'pending',
      createdAt: nowIso(),
    };
    this.db
      .query(
        `INSERT INTO handoffs
           (id, todo_id, session_id, session_name, session_cwd, note, actor, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      );
    this.recordHistory(
      'todo',
      todo.id,
      input.actor,
      'handoff',
      { handoff: [null, handoff.sessionName ?? handoff.sessionId] },
      todo.boardId,
    );
    return handoff;
  }

  /** 이 todo 앞으로 아직 배달되지 않은 요청. 없으면 undefined. */
  pendingHandoffOf(todoId: string): Handoff | undefined {
    const row = this.db
      .query<HandoffRow, [string]>(
        "SELECT * FROM handoffs WHERE todo_id = ? AND status = 'pending' ORDER BY created_at ASC, rowid ASC LIMIT 1",
      )
      .get(todoId);
    return row ? toHandoff(row) : undefined;
  }

  /** 큐 조회 — 최신순. boardId 로 거르면 그 보드 todo 의 요청만 나온다. */
  listHandoffs(filter: { boardId?: string; todoId?: string; status?: HandoffStatus } = {}): Handoff[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.boardId) {
      clauses.push('h.todo_id IN (SELECT id FROM todos WHERE board_id = ?)');
      params.push(filter.boardId);
    }
    if (filter.todoId) {
      clauses.push('h.todo_id = ?');
      params.push(filter.todoId);
    }
    if (filter.status) {
      clauses.push('h.status = ?');
      params.push(filter.status);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    return this.db
      .query<HandoffRow, unknown[]>(
        `SELECT h.* FROM handoffs h${where} ORDER BY h.created_at DESC, h.rowid DESC`,
      )
      .all(...params)
      .map(toHandoff);
  }

  /**
   * 이 세션 앞의 pending 중 **가장 오래된 한 건만** 배달 처리하고 돌려준다.
   *
   * 한 번에 하나인 이유: 여러 건을 한꺼번에 주면 에이전트가 섞어서 착수하거나 병렬로
   * 벌린다 — 보드의 start→done 에티켓과 어긋난다. 하나를 끝내면 `Stop` 훅이 다시
   * 발동해 다음 것을 집으므로 큐는 저절로 직렬로 소화된다.
   * @returns 대기 중인 것이 없으면 null.
   */
  claimHandoff(sessionId: string, via: HandoffVia): ClaimedHandoff | null {
    const claim = this.db.transaction((): ClaimedHandoff | null => {
      const row = this.db
        .query<HandoffRow, [string]>(
          "SELECT * FROM handoffs WHERE session_id = ? AND status = 'pending' ORDER BY created_at ASC, rowid ASC LIMIT 1",
        )
        .get(sessionId);
      if (!row) {
        return null;
      }
      const at = nowIso();
      this.db
        .query(
          "UPDATE handoffs SET status = 'delivered', delivered_at = ?, delivered_via = ? WHERE id = ? AND status = 'pending'",
        )
        .run(at, via, row.id);
      const todo = this.getTodo(row.todo_id);
      if (!todo) {
        // todo 가 사라진 요청은 배달할 수 없다 — delivered 로 닫고 넘어간다.
        return null;
      }
      const remaining =
        this.db
          .query<{ n: number }, [string]>(
            "SELECT COUNT(*) AS n FROM handoffs WHERE session_id = ? AND status = 'pending'",
          )
          .get(sessionId)?.n ?? 0;
      return {
        handoff: { ...toHandoff(row), status: 'delivered', deliveredAt: at, deliveredVia: via },
        todoRef: this.refOfTodo(todo),
        todoTitle: todo.title,
        remaining,
      };
    });
    const claimed = claim();
    if (claimed) {
      this.recordHistory(
        'todo',
        claimed.handoff.todoId,
        claimed.handoff.sessionName ?? claimed.handoff.sessionId,
        'handoff-delivered',
        undefined,
        undefined,
      );
    }
    return claimed;
  }

  /**
   * 대기 중인 요청을 취소한다.
   * @throws 없거나 이미 배달/취소된 건이면.
   */
  cancelHandoff(id: string, actor: string): Handoff {
    const row = this.db.query<HandoffRow, [string]>('SELECT * FROM handoffs WHERE id = ?').get(id);
    if (!row) {
      throw new Error(`handoff not found: ${id}`);
    }
    if (row.status !== 'pending') {
      throw new Error(`handoff is not pending: ${id}`);
    }
    this.db.query("UPDATE handoffs SET status = 'cancelled' WHERE id = ?").run(id);
    this.recordHistory('todo', row.todo_id, actor, 'handoff-cancel', undefined, undefined);
    return { ...toHandoff(row), status: 'cancelled' };
  }
```

`refOfTodo` 는 이미 있는 참조 렌더 경로를 쓴다. `src/refs.ts` 의 `refOf` 를 감싸는 private 헬퍼가 스토어에 없다면 다음을 같은 섹션 위에 추가한다:

```ts
  /** `<boardKey>#<number>` 형태의 사람이 읽는 참조. */
  private refOfTodo(todo: Todo): string {
    const board = this.listBoards(true).find((b) => b.id === todo.boardId);
    return board ? `${board.key}#${todo.number}` : String(todo.number);
  }
```

- [ ] **Step 7: Exclude handoff actions from the changes feed**

In `listChangesSince`, change the row query so handoff actions never reach the `UserPromptSubmit` injection path. `lastId` is computed separately from `MAX(id)`, so the cursor still advances past skipped rows:

```ts
    const rows = this.db
      .query<HistoryRow, [number, number]>(
        `SELECT * FROM history
          WHERE id > ?
            AND action NOT IN ('handoff', 'handoff-delivered', 'handoff-cancel')
          ORDER BY id ASC LIMIT ?`,
      )
      .all(sinceId, limit);
```

Add a comment above it:

```ts
    // handoff 계열은 뺀다 — A 세션 앞으로 보낸 요청이 B·C 세션의 프롬프트 주입에까지
    // "logan 이 handoff 했다"로 실리면 노이즈다. 배달에는 전용 경로(claimHandoff)가 있다.
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `bun test src/store.test.ts src/migrations.test.ts`
Expected: PASS

- [ ] **Step 9: Gate + commit**

```bash
bun run check && bun run typecheck && bun test
git add src/store.ts src/store.test.ts src/migrations.ts src/migrations.test.ts
git commit -m "feat(store): handoff 큐 — 생성·claim·취소와 마이그레이션 2"
```

---

### Task 3: `src/handoff.ts` — 주입문 생성

**Files:**
- Create: `src/handoff.ts`
- Test: `src/handoff.test.ts`

**Interfaces:**
- Consumes: Task 2 의 `ClaimedHandoff`
- Produces: `function buildHandoffPrompt(claimed: ClaimedHandoff): string`

- [ ] **Step 1: Write the failing test**

Create `src/handoff.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { buildHandoffPrompt } from './handoff';
import type { ClaimedHandoff } from './store';

const base: ClaimedHandoff = {
  handoff: {
    id: 'h1',
    todoId: 't1',
    sessionId: 'sess-1',
    sessionName: 'eelpout-a3',
    note: '',
    actor: 'logan',
    status: 'delivered',
    createdAt: '2026-07-26T12:00:00.000Z',
  },
  todoRef: 'rocky-todo#11',
  todoTitle: 'todo - 에이전트 작업 요청',
  remaining: 0,
};

describe('buildHandoffPrompt', () => {
  test('보낸 사람·참조·제목을 담는다', () => {
    const prompt = buildHandoffPrompt(base);
    expect(prompt).toContain('logan → rocky-todo#11');
    expect(prompt).toContain('todo - 에이전트 작업 요청');
    expect(prompt).toContain('todo_status');
  });

  test('메모가 있으면 실어 보낸다', () => {
    const prompt = buildHandoffPrompt({
      ...base,
      handoff: { ...base.handoff, note: '테스트부터 짜줘' },
    });
    expect(prompt).toContain('메모: 테스트부터 짜줘');
  });

  test('메모가 없으면 메모 줄 자체가 없다', () => {
    expect(buildHandoffPrompt(base)).not.toContain('메모:');
  });

  test('잔여 건수가 있으면 알린다', () => {
    expect(buildHandoffPrompt({ ...base, remaining: 2 })).toContain('2건');
  });

  test('잔여가 0이면 잔여 줄이 없다', () => {
    expect(buildHandoffPrompt(base)).not.toContain('대기 중인 요청이');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/handoff.test.ts`
Expected: FAIL — `Cannot find module './handoff'`

- [ ] **Step 3: Write the implementation**

Create `src/handoff.ts`:

```ts
import type { ClaimedHandoff } from './store';

/**
 * 핸드오프 훅의 순수 로직 — claim 결과를 세션에 넣을 한국어 지시문으로 만든다.
 * 훅 엔트리(`hooks/handoff-stop.ts`, `hooks/notify-todo.ts`)는 HTTP 왕복과
 * stdin/stdout 배선만 담당한다 — `src/notify.ts` 와 같은 구조다.
 */

/**
 * 세션에 주입할 지시문.
 *
 * todo 본문은 싣지 않는다 — 세션이 `todo_list` 로 직접 읽으면 댓글·히스토리까지
 * 최신으로 본다. 복사하면 그 시점에 굳어버린다.
 */
export function buildHandoffPrompt(claimed: ClaimedHandoff): string {
  const { handoff, todoRef, todoTitle, remaining } = claimed;
  const lines = [
    '# rocky-todo: 보드에서 도착한 작업 요청',
    '',
    `${handoff.actor} → ${todoRef} "${todoTitle}"`,
  ];
  if (handoff.note !== '') {
    lines.push(`메모: ${handoff.note}`);
  }
  lines.push(
    '',
    `이 항목을 지금 착수해라. 상세는 todo_list { id: "${todoRef}" } 로 읽고,`,
    `착수할 때 todo_status { id: "${todoRef}", action: "start" } 로 표시한다.`,
  );
  if (remaining > 0) {
    lines.push(`(대기 중인 요청이 ${remaining}건 더 있다 — 이 건을 마치면 이어서 도착한다.)`);
  }
  return lines.join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/handoff.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Gate + commit**

```bash
bun run check && bun run typecheck && bun test
git add src/handoff.ts src/handoff.test.ts
git commit -m "feat(handoff): 세션 주입문 생성"
```

---

### Task 4: REST 라우트

**Files:**
- Modify: `src/server.ts`
- Test: `src/server.test.ts` (추가)

**Interfaces:**
- Consumes: Task 1 `listSessions` / `matchBoard` / `SessionsResult`, Task 2 스토어 메서드
- Produces:
  - `TodoServerOptions` 에 `sessions?: () => SessionsResult` 추가 (테스트 주입용, 기본은 실제 `listSessions`)
  - 라우트: `GET /api/sessions`, `POST /api/todos/:ref/handoff`, `GET /api/handoffs`, `POST /api/handoffs/claim`, `POST /api/handoffs/:id/cancel`

- [ ] **Step 1: Write the failing tests**

Append to `src/server.test.ts`. 이 파일은 모듈 스코프 `store` / `handle` 과 `req()` 헬퍼를 쓴다. `sessions` 주입이 필요한 테스트만 별도 핸들을 만든다 — 기존 전역 `handle` 은 그대로 둔다:

```ts
describe('handoff routes', () => {
  /** sessions 를 주입한 핸들. store 는 beforeEach 가 만든 것을 공유한다. */
  const handleWith = (sessions: () => SessionsResult) => buildTodoServer({ store, sessions }).fetch;

  const reqTo = (
    h: (request: Request) => Promise<Response>,
    path: string,
    init?: RequestInit & { actor?: string },
  ): Promise<Response> => {
    const headers = new Headers(init?.headers);
    if (init?.body !== undefined) {
      headers.set('content-type', 'application/json');
    }
    headers.set('x-rocky-actor', init?.actor ?? 'tester');
    return h(new Request(`${BASE}${path}`, { ...init, headers }));
  };

  const SESSIONS = {
    available: true as const,
    sessions: [
      {
        pid: 1,
        cwd: '/w/rocky-todo',
        kind: 'interactive',
        sessionId: 'sess-1',
        name: 'rocky-todo-1e',
        status: 'idle',
        startedAt: 1,
      },
      {
        pid: 2,
        cwd: '/w/forses',
        kind: 'interactive',
        sessionId: 'sess-2',
        name: 'forses-90',
        status: 'busy',
        startedAt: 2,
      },
    ],
  };

  test('GET /api/sessions 는 목록과 보드 매칭을 준다', async () => {
    const res = await reqTo(handleWith(() => SESSIONS), '/api/sessions?board=rocky-todo');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      available: boolean;
      sessions: Array<{ name: string; matched: boolean }>;
    };
    expect(body.available).toBe(true);
    expect(body.sessions.find((s) => s.name === 'rocky-todo-1e')?.matched).toBe(true);
    expect(body.sessions.find((s) => s.name === 'forses-90')?.matched).toBe(false);
  });

  test('claude 를 못 쓰면 available:false 를 그대로 알린다', async () => {
    const h = handleWith(() => ({ available: false, sessions: [], reason: 'claude CLI 없음' }));
    const res = await reqTo(h, '/api/sessions');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { available: boolean; reason: string };
    expect(body.available).toBe(false);
    expect(body.reason).toBe('claude CLI 없음');
  });

  test('POST handoff — sessionId 를 주면 스냅샷과 함께 201', async () => {
    const todo = store.createTodo({ board: 'rocky-todo', title: 'x' }, 'logan');
    const res = await reqTo(handleWith(() => SESSIONS), `/api/todos/${todo.id}/handoff`, {
      method: 'POST',
      body: JSON.stringify({ sessionId: 'sess-1', note: '테스트부터' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { sessionName: string; sessionCwd: string; note: string };
    expect(body.sessionName).toBe('rocky-todo-1e');
    expect(body.sessionCwd).toBe('/w/rocky-todo');
    expect(body.note).toBe('테스트부터');
  });

  test('POST handoff — sessionId 를 생략하면 보드로 자동 매칭', async () => {
    const todo = store.createTodo({ board: 'rocky-todo', title: 'x' }, 'logan');
    const res = await reqTo(handleWith(() => SESSIONS), `/api/todos/${todo.id}/handoff`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { sessionId: string }).sessionId).toBe('sess-1');
  });

  test('후보가 없거나 여럿이면 409 + 후보 목록', async () => {
    const todo = store.createTodo({ board: 'gotgan', title: 'x' }, 'logan');
    const res = await reqTo(handleWith(() => SESSIONS), `/api/todos/${todo.id}/handoff`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; candidates: unknown[] };
    expect(body.error).toBeTruthy();
    expect(Array.isArray(body.candidates)).toBe(true);
  });

  test('이미 pending 이 있으면 409', async () => {
    const todo = store.createTodo({ board: 'rocky-todo', title: 'x' }, 'logan');
    store.createHandoff({ ref: todo.id, sessionId: 'sess-1', actor: 'logan' });
    const res = await reqTo(handleWith(() => SESSIONS), `/api/todos/${todo.id}/handoff`, {
      method: 'POST',
      body: JSON.stringify({ sessionId: 'sess-1' }),
    });
    expect(res.status).toBe(409);
  });

  test('없는 todo 는 404', async () => {
    const res = await reqTo(handleWith(() => SESSIONS), '/api/todos/zzzzzzzz/handoff', {
      method: 'POST',
      body: JSON.stringify({ sessionId: 'sess-1' }),
    });
    expect(res.status).toBe(404);
  });

  test('목록에 없는 sessionId 는 400', async () => {
    const todo = store.createTodo({ board: 'rocky-todo', title: 'x' }, 'logan');
    const res = await reqTo(handleWith(() => SESSIONS), `/api/todos/${todo.id}/handoff`, {
      method: 'POST',
      body: JSON.stringify({ sessionId: 'ghost' }),
    });
    expect(res.status).toBe(400);
  });

  test('claim 은 한 건을 주고, 비면 204', async () => {
    const todo = store.createTodo({ board: 'rocky-todo', title: '핸드오프' }, 'logan');
    store.createHandoff({ ref: todo.id, sessionId: 'sess-1', actor: 'logan' });
    const h = handleWith(() => SESSIONS);

    const first = await reqTo(h, '/api/handoffs/claim', {
      method: 'POST',
      body: JSON.stringify({ sessionId: 'sess-1', via: 'stop' }),
    });
    expect(first.status).toBe(200);
    const body = (await first.json()) as { todoTitle: string; remaining: number };
    expect(body.todoTitle).toBe('핸드오프');
    expect(body.remaining).toBe(0);

    const second = await reqTo(h, '/api/handoffs/claim', {
      method: 'POST',
      body: JSON.stringify({ sessionId: 'sess-1', via: 'stop' }),
    });
    expect(second.status).toBe(204);
  });

  test('GET /api/handoffs 는 대상 세션이 사라진 건을 stale 로 표시한다', async () => {
    const todo = store.createTodo({ board: 'rocky-todo', title: 'x' }, 'logan');
    store.createHandoff({ ref: todo.id, sessionId: 'ghost-session', actor: 'logan' });
    const res = await reqTo(handleWith(() => SESSIONS), '/api/handoffs?status=pending');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ stale: boolean }>;
    expect(body[0]?.stale).toBe(true);
  });

  test('취소는 200, 두 번째는 400', async () => {
    const todo = store.createTodo({ board: 'rocky-todo', title: 'x' }, 'logan');
    const handoff = store.createHandoff({ ref: todo.id, sessionId: 'sess-1', actor: 'logan' });
    const h = handleWith(() => SESSIONS);

    expect((await reqTo(h, `/api/handoffs/${handoff.id}/cancel`, { method: 'POST' })).status).toBe(
      200,
    );
    expect((await reqTo(h, `/api/handoffs/${handoff.id}/cancel`, { method: 'POST' })).status).toBe(
      400,
    );
  });
});
```

`SessionsResult` 를 `./sessions` 에서 type import 로 추가한다.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/server.test.ts`
Expected: FAIL — 404 (라우트 없음)

- [ ] **Step 3: Wire the option**

In `src/server.ts`, extend the options and imports:

```ts
import { listSessions as defaultListSessions, matchBoard, type SessionsResult } from './sessions';
```

```ts
export interface TodoServerOptions {
  store: TodoStore;
  /** 활성 세션 조회 — 테스트에서 주입한다. 기본은 `claude agents --json`. */
  sessions?: () => SessionsResult;
}
```

```ts
export function buildTodoServer(options: TodoServerOptions): TodoServer {
  const { store } = options;
  const sessionsOf = options.sessions ?? (() => defaultListSessions());
```

- [ ] **Step 4: Add the routes**

Insert before the `// ── changes ──` block in `src/server.ts`:

```ts
      // ── sessions ──
      if (method === 'GET' && path === '/api/sessions') {
        const result = sessionsOf();
        const boardKey = url.searchParams.get('board');
        const matched = boardKey ? new Set(matchBoard(result.sessions, boardKey).map((s) => s.sessionId)) : null;
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
        const live = new Set(sessionsOf().sessions.map((s) => s.sessionId));
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
```

Add the todo-scoped route next to the other `/api/todos/:ref/...` routes (right after the `/status` route):

```ts
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
          if (candidates.length !== 1) {
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
          target = candidates[0];
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
```

Add `HandoffStatus` to the type import from `./store`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test src/server.test.ts`
Expected: PASS

- [ ] **Step 6: Gate + commit**

```bash
bun run check && bun run typecheck && bun test
git add src/server.ts src/server.test.ts
git commit -m "feat(server): handoff REST 라우트 + 세션 목록"
```

---

### Task 5: `Stop` 훅 — 자동 착수

**Files:**
- Create: `hooks/handoff-stop.ts`
- Create: `hooks/handoff-stop.test.ts`
- Modify: `hooks/hooks.json`

**Interfaces:**
- Consumes: Task 3 `buildHandoffPrompt`, Task 4 `POST /api/handoffs/claim`
- Produces: `export async function run(deps: StopDeps): Promise<string | null>` — 주입할 reason 문자열 또는 null

- [ ] **Step 1: Write the failing test**

Create `hooks/handoff-stop.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { run, type StopDeps } from './handoff-stop';
import type { ClaimedHandoff } from '../src/store';

const CLAIMED: ClaimedHandoff = {
  handoff: {
    id: 'h1',
    todoId: 't1',
    sessionId: 'sess-1',
    sessionName: 'eelpout-a3',
    note: '',
    actor: 'logan',
    status: 'delivered',
    createdAt: '2026-07-26T12:00:00.000Z',
  },
  todoRef: 'rocky-todo#11',
  todoTitle: '핸드오프 대상',
  remaining: 0,
};

const deps = (over: Partial<StopDeps> = {}): StopDeps => ({
  claim: async () => CLAIMED,
  ...over,
});

describe('handoff-stop', () => {
  test('claim 이 있으면 주입문을 돌려준다', async () => {
    const reason = await run({ session_id: 'sess-1' }, deps());
    expect(reason).toContain('rocky-todo#11');
    expect(reason).toContain('핸드오프 대상');
  });

  test('claim 이 없으면 null — 세션을 막지 않는다', async () => {
    const reason = await run({ session_id: 'sess-1' }, deps({ claim: async () => null }));
    expect(reason).toBeNull();
  });

  test('서브에이전트 컨텍스트에서는 claim 자체를 하지 않는다', async () => {
    let called = false;
    const reason = await run(
      { session_id: 'sess-1', agent_type: 'Explore' },
      deps({
        claim: async () => {
          called = true;
          return CLAIMED;
        },
      }),
    );
    expect(reason).toBeNull();
    expect(called).toBe(false);
  });

  test('session_id 가 없으면 아무것도 하지 않는다', async () => {
    expect(await run({}, deps())).toBeNull();
  });

  test('claim 이 던져도 fail-open — null 을 돌려준다', async () => {
    const reason = await run(
      { session_id: 'sess-1' },
      deps({
        claim: async () => {
          throw new Error('daemon down');
        },
      }),
    );
    expect(reason).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test hooks/handoff-stop.test.ts`
Expected: FAIL — `Cannot find module './handoff-stop'`

- [ ] **Step 3: Write the implementation**

Create `hooks/handoff-stop.ts`:

```ts
import { resolveTodoRuntimeConfig } from '../src/config';
import { buildHandoffPrompt } from '../src/handoff';
import { loadTodoConfig } from '../src/rocky-config';
import type { ClaimedHandoff } from '../src/store';

/**
 * Stop hook: 이 세션 앞으로 온 보드 작업 요청이 있으면 턴을 끝내지 못하게 막고
 * (`decision: "block"`) 그 자리에서 착수시킨다.
 *
 * 원칙:
 * - fail-open: 데몬이 죽어 있거나 어떤 에러든 조용히 exit 0 (턴 종료를 막지 않는다).
 * - **서브에이전트에서는 빠진다** — 서브에이전트가 보드 요청을 가로채면 사용자가 보낸
 *   대상과 실제 처리 주체가 갈린다.
 * - 무한 루프는 구조적으로 없다: claim 된 건은 delivered 라 다시 나오지 않고, 큐가
 *   비면 block 하지 않는다. 큐가 유한하므로 반드시 끝난다.
 */

export interface StopHookInput {
  session_id?: string;
  /** 서브에이전트 컨텍스트에서만 채워진다. */
  agent_id?: string;
  agent_type?: string;
}

export interface StopDeps {
  claim: (sessionId: string) => Promise<ClaimedHandoff | null>;
}

async function readStdin(): Promise<string> {
  let raw = '';
  for await (const chunk of process.stdin) {
    raw += chunk;
  }
  return raw;
}

/** 데몬에서 이 세션 앞의 요청 한 건을 집어온다. 없거나 실패하면 null. */
async function defaultClaim(sessionId: string): Promise<ClaimedHandoff | null> {
  const { todo } = loadTodoConfig();
  const runtime = resolveTodoRuntimeConfig(process.env, todo);
  const res = await fetch(`http://127.0.0.1:${runtime.port}/api/handoffs/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, via: 'stop' }),
    signal: AbortSignal.timeout(1500),
  });
  if (res.status !== 200) {
    return null;
  }
  return (await res.json()) as ClaimedHandoff;
}

/**
 * 주입할 reason 을 만든다.
 * @returns 대기 중인 요청이 없거나 여기서 처리하면 안 되는 상황이면 null.
 */
export async function run(
  input: StopHookInput,
  deps: StopDeps = { claim: defaultClaim },
): Promise<string | null> {
  if (!input.session_id) {
    return null;
  }
  if (input.agent_id || input.agent_type) {
    return null;
  }
  try {
    const claimed = await deps.claim(input.session_id);
    return claimed ? buildHandoffPrompt(claimed) : null;
  } catch {
    return null;
  }
}

if (import.meta.main) {
  (async () => {
    let input: StopHookInput = {};
    try {
      input = JSON.parse(await readStdin()) as StopHookInput;
    } catch {
      // stdin 이 비어도 진행 — session_id 없으면 run 이 null 을 낸다.
    }
    const reason = await run(input);
    if (reason) {
      process.stdout.write(JSON.stringify({ decision: 'block', reason }));
    }
  })()
    .catch(() => {
      // fail-open — 훅 실패가 턴 종료를 막지 않는다.
    })
    .finally(() => {
      process.exit(0);
    });
}
```

- [ ] **Step 4: Register the hook**

Modify `hooks/hooks.json` — add the `Stop` block:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup",
        "hooks": [
          {
            "type": "command",
            "command": "bun run \"${CLAUDE_PLUGIN_ROOT}/hooks/ensure-daemon.ts\""
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bun run \"${CLAUDE_PLUGIN_ROOT}/hooks/notify-todo.ts\"",
            "timeout": 5
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bun run \"${CLAUDE_PLUGIN_ROOT}/hooks/handoff-stop.ts\"",
            "timeout": 3
          }
        ]
      }
    ]
  }
}
```

timeout 이 3초인 이유: 기본값(600초)이면 데몬이 이상할 때 턴 종료 자체가 멈춘다.

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test hooks/handoff-stop.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 6: Gate + commit**

```bash
bun run check && bun run typecheck && bun test
git add hooks/handoff-stop.ts hooks/handoff-stop.test.ts hooks/hooks.json
git commit -m "feat(hooks): Stop 훅으로 보드 작업 요청 자동 착수"
```

---

### Task 6: `UserPromptSubmit` 경로 — 사용자가 말을 걸 때 배달

**Files:**
- Modify: `hooks/notify-todo.ts`
- Test: `src/notify.test.ts` (추가)
- Modify: `src/notify.ts` (합성 함수 추가)

**Interfaces:**
- Consumes: Task 3 `buildHandoffPrompt`, Task 4 claim 라우트
- Produces: `function mergeContext(parts: Array<string | null>): string | null` in `src/notify.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/notify.test.ts`:

```ts
describe('mergeContext', () => {
  test('둘 다 있으면 빈 줄로 잇는다', () => {
    expect(mergeContext(['A', 'B'])).toBe('A\n\nB');
  });

  test('하나만 있으면 그것만', () => {
    expect(mergeContext([null, 'B'])).toBe('B');
    expect(mergeContext(['A', null])).toBe('A');
  });

  test('둘 다 없으면 null — 아무것도 주입하지 않는다', () => {
    expect(mergeContext([null, null])).toBeNull();
  });

  test('빈 문자열은 없는 것으로 친다', () => {
    expect(mergeContext(['', 'B'])).toBe('B');
  });
});
```

Add `mergeContext` to the import at the top of `src/notify.test.ts`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/notify.test.ts`
Expected: FAIL — `mergeContext is not a function`

- [ ] **Step 3: Add `mergeContext` to `src/notify.ts`**

```ts
/**
 * 여러 주입 블록을 하나의 additionalContext 로 합친다 — 사람의 보드 변경과 핸드오프
 * 요청이 같은 프롬프트에 함께 도착할 수 있다.
 * @returns 실을 내용이 하나도 없으면 null.
 */
export function mergeContext(parts: Array<string | null>): string | null {
  const kept = parts.filter((part): part is string => typeof part === 'string' && part !== '');
  return kept.length > 0 ? kept.join('\n\n') : null;
}
```

- [ ] **Step 4: Wire it into `hooks/notify-todo.ts`**

Add the import:

```ts
import { buildHandoffPrompt } from '../src/handoff';
import { buildNotifyContext, filterHumanChanges, mergeContext, readCursor, writeCursor } from '../src/notify';
import type { ChangeFeedEntry, ClaimedHandoff } from '../src/store';
```

Add the claim helper next to `fetchChanges`:

```ts
/** 이 세션 앞의 핸드오프 한 건을 집어온다. 없거나 실패하면 null (fail-open). */
async function claimHandoff(baseUrl: string, sessionId: string): Promise<ClaimedHandoff | null> {
  try {
    const res = await fetch(`${baseUrl}/api/handoffs/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, via: 'prompt' }),
      signal: AbortSignal.timeout(1500),
    });
    if (res.status !== 200) {
      return null;
    }
    return (await res.json()) as ClaimedHandoff;
  } catch {
    return null;
  }
}
```

Replace the tail of `run()` (from the first-prompt watermark branch onward) so the handoff is delivered even on the very first prompt of a session — 커서가 없다고 배달까지 미루면 새 세션이 대기 중인 요청을 한 턴 놓친다:

```ts
  const claimed = await claimHandoff(baseUrl, sessionId);
  const handoffContext = claimed ? buildHandoffPrompt(claimed) : null;

  const cursor = readCursor(cursorFile, sessionId);
  let changeContext: string | null = null;
  if (cursor === undefined) {
    // 첫 프롬프트 — 현재 watermark 만 기록하고 과거 히스토리는 주입하지 않는다.
    const head = await fetchChanges(baseUrl, 0, 1);
    if (head) {
      writeCursor(cursorFile, sessionId, head.lastId);
    }
  } else {
    const feed = await fetchChanges(baseUrl, cursor, 100);
    if (feed) {
      if (feed.lastId !== cursor) {
        writeCursor(cursorFile, sessionId, feed.lastId);
      }
      changeContext = buildNotifyContext(filterHumanChanges(feed.entries));
    }
  }

  const context = mergeContext([changeContext, handoffContext]);
  if (!context) {
    return;
  }
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: context,
      },
    }),
  );
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test src/notify.test.ts`
Expected: PASS

- [ ] **Step 6: Gate + commit**

```bash
bun run check && bun run typecheck && bun test
git add src/notify.ts src/notify.test.ts hooks/notify-todo.ts
git commit -m "feat(hooks): UserPromptSubmit 에서도 핸드오프 배달"
```

---

### Task 7: CLI — `sessions` / `handoff`

**Files:**
- Modify: `src/cli.ts` (HELP 문자열, `sessions` / `handoff` case)
- Test: `src/cli.test.ts` (추가)

**Interfaces:**
- Consumes: Task 4 라우트
- Produces: CLI 명령 `rocky-todo sessions`, `rocky-todo handoff REF [--session NAME] [--note "…"] [--cancel]`

- [ ] **Step 1: Write the failing test**

Append to `src/cli.test.ts`. 이 파일은 `runCli` 를 직접 부르지 않고 **순수 포맷 함수**를 검증한다 (`formatTodoLine` / `formatTodoShow` 와 같은 결) — 명령의 HTTP 계약은 Task 4 의 라우트 테스트가 이미 덮는다:

```ts
describe('formatSessions', () => {
  const view = (over: Partial<Parameters<typeof formatSessions>[0]> = {}) => ({
    available: true,
    sessions: [
      {
        pid: 1,
        cwd: '/w/rocky-todo',
        kind: 'interactive',
        sessionId: 'sess-1',
        name: 'rocky-todo-1e',
        status: 'idle',
        startedAt: 1,
        matched: true,
      },
      {
        pid: 2,
        cwd: '/w/forses',
        kind: 'interactive',
        sessionId: 'sess-2',
        name: 'forses-90',
        status: 'busy',
        startedAt: 2,
        matched: false,
      },
    ],
    ...over,
  });

  test('이름·상태·경로를 한 줄씩 렌더한다', () => {
    const out = formatSessions(view());
    expect(out).toContain('rocky-todo-1e');
    expect(out).toContain('idle');
    expect(out).toContain('/w/rocky-todo');
  });

  test('현재 보드와 일치하는 세션에 * 를 붙인다', () => {
    const lines = formatSessions(view()).split('\n');
    expect(lines[0]?.startsWith('*')).toBe(true);
    expect(lines[1]?.startsWith('*')).toBe(false);
  });

  test('claude 를 못 쓰면 이유를 보여준다', () => {
    const out = formatSessions(view({ available: false, sessions: [], reason: 'claude CLI 없음' }));
    expect(out).toContain('claude CLI 없음');
  });

  test('세션이 없으면 그렇게 말한다', () => {
    expect(formatSessions(view({ sessions: [] }))).toContain('실행 중인');
  });
});
```

`formatSessions` 를 `./cli` import 목록에 추가한다.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/cli.test.ts`
Expected: FAIL — 알 수 없는 명령

- [ ] **Step 3: Add the commands**

In `src/cli.ts`, add to the `switch (command)` block after the `comment` case:

```ts
    case 'sessions': {
      const result = await request<SessionsView>(
        ctx,
        'GET',
        `/api/sessions?board=${encodeURIComponent(board)}`,
      );
      print(result, () => formatSessions(result));
      return;
    }

    case 'handoff': {
      const id = rest[0];
      if (!id) {
        throw new Error('usage: rocky-todo handoff REF [--session NAME] [--note "본문"] [--cancel]');
      }
      if (flags.cancel === true) {
        const pending = await request<Array<{ id: string; todoId: string; sessionName?: string }>>(
          ctx,
          'GET',
          `/api/handoffs?board=${encodeURIComponent(board)}&status=pending`,
        );
        const detail = await request<{ todo: TodoView }>(ctx, 'GET', todoRefPath(id, '', board));
        const target = pending.find((h) => h.todoId === detail.todo.id);
        if (!target) {
          throw new Error(`${id} 앞으로 대기 중인 요청이 없다`);
        }
        const cancelled = await request<{ id: string }>(
          ctx,
          'POST',
          `/api/handoffs/${target.id}/cancel`,
        );
        print(cancelled, () => `✓ ${id} 핸드오프 취소`);
        return;
      }

      const sessionName = str(flags.session);
      let sessionId: string | undefined;
      if (sessionName) {
        const result = await request<{
          sessions: Array<{ name: string; sessionId: string }>;
        }>(ctx, 'GET', `/api/sessions?board=${encodeURIComponent(board)}`);
        sessionId = result.sessions.find((s) => s.name === sessionName)?.sessionId;
        if (!sessionId) {
          throw new Error(`활성 세션이 아니다: ${sessionName}`);
        }
      }
      const handoff = await request<{ sessionName?: string; sessionId: string }>(
        ctx,
        'POST',
        todoRefPath(id, '/handoff', board),
        { sessionId, note: str(flags.note) },
      );
      print(handoff, () => `✓ ${id} → ${handoff.sessionName ?? handoff.sessionId} 에게 보냄`);
      return;
    }
```

- [ ] **Step 4: Add the `formatSessions` pure renderer**

Add near the other `format*` functions in `src/cli.ts` (these are exported so tests can reach them):

```ts
import type { AgentSession } from './sessions';

/** `GET /api/sessions` 응답 — CLI 와 테스트가 공유하는 뷰 타입. */
export interface SessionsView {
  available: boolean;
  reason?: string;
  sessions: Array<AgentSession & { matched: boolean }>;
}

/** 세션 목록을 컴팩트하게 렌더한다. `*` 는 현재 보드와 일치하는 세션. */
export function formatSessions(view: SessionsView): string {
  if (!view.available) {
    return `활성 세션 목록을 가져올 수 없다: ${view.reason ?? '알 수 없는 이유'}`;
  }
  if (view.sessions.length === 0) {
    return '실행 중인 Claude Code 세션이 없다';
  }
  return view.sessions
    .map((s) => `${s.matched ? '*' : ' '} ${s.name}  ${s.status}  ${s.cwd}`)
    .join('\n');
}
```

- [ ] **Step 5: Update the HELP string**

In the `HELP` constant, add under the todo commands:

```
  handoff REF [--session NAME] [--note "본문"]  실행 중인 세션에 작업 요청 보내기
  handoff REF --cancel                          대기 중인 요청 취소
  sessions                                      실행 중인 Claude Code 세션 (* = 이 보드)
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test src/cli.test.ts`
Expected: PASS

- [ ] **Step 7: Gate + commit**

```bash
bun run check && bun run typecheck && bun test
git add src/cli.ts src/cli.test.ts
git commit -m "feat(cli): handoff / sessions 명령"
```

---

### Task 8: 웹 UI — 보내기 패널과 대기 뱃지

**Files:**
- Modify: `src/ui/store.ts` (상태 `handoffs`, `sessions`; 액션 `fetchSessions` / `sendHandoff` / `cancelHandoff`)
- Modify: `src/ui/components/DetailDrawer.tsx` (보내기 패널)
- Modify: `src/ui/components/TodoItem.tsx` (대기 뱃지)
- Modify: `src/ui/styles.css` (뱃지·패널 스타일)

**Interfaces:**
- Consumes: Task 4 라우트, Task 2 `Handoff` 타입
- Produces: 스토어 액션 세 개. 다른 태스크가 의존하지 않는 최종 표면이다.

- [ ] **Step 1: Extend the store**

In `src/ui/store.ts`, add to `UiState`:

```ts
  /** 현재 보드의 대기 중 핸드오프 — refetch 가 함께 갱신한다. */
  handoffs: Array<Handoff & { stale: boolean }>;
  /** 보내기 패널을 열 때만 채운다. */
  sessions: { available: boolean; reason?: string; list: Array<AgentSession & { matched: boolean }> };

  fetchSessions: () => Promise<void>;
  /** @throws 서버가 거절한 이유를 그대로 던진다 — 호출자가 화면에 보여줘야 한다. */
  sendHandoff: (todoId: string, input: { sessionId?: string; note?: string }) => Promise<void>;
  cancelHandoff: (handoffId: string) => Promise<void>;
```

Add the imports:

```ts
import type { AgentSession } from '../sessions';
import type { Board, Comment, Handoff, HistoryEntry, Section, StatusAction } from '../store';
```

Add the initial state (`handoffs: []`, `sessions: { available: true, list: [] }`) and the actions:

```ts
  fetchSessions: async () => {
    const { actor, selected } = get();
    // `selected` 는 'all' 이거나 board key 문자열이다 (객체가 아니다).
    const board = selected === 'all' ? '' : selected;
    const result = await api<{
      available: boolean;
      reason?: string;
      sessions: Array<AgentSession & { matched: boolean }>;
    }>(`/api/sessions?board=${encodeURIComponent(board)}`, actor);
    set({ sessions: { available: result.available, reason: result.reason, list: result.sessions } });
  },

  sendHandoff: async (todoId, input) => {
    const { actor } = get();
    await api(`/api/todos/${todoId}/handoff`, actor, {
      method: 'POST',
      body: JSON.stringify(input),
    });
    await get().refetch();
  },

  cancelHandoff: async (handoffId) => {
    const { actor } = get();
    await api(`/api/handoffs/${handoffId}/cancel`, actor, { method: 'POST' });
    await get().refetch();
  },
```

In `refetch`, add the pending queue to the existing `Promise.all` and include it in the `set`:

```ts
    const [boards, todos, notes, sections, handoffs] = await Promise.all([
      api<Board[]>('/api/boards', actor),
      api<TodoView[]>(`/api/todos${qs}`, actor),
      api<NoteView[]>(`/api/notes${qs}`, actor),
      selected === 'all'
        ? Promise.resolve([] as Section[])
        : api<Section[]>(`/api/sections?board=${encodeURIComponent(selected)}`, actor),
      api<Array<Handoff & { stale: boolean }>>(
        `/api/handoffs?status=pending${
          selected === 'all' ? '' : `&board=${encodeURIComponent(selected)}`
        }`,
        actor,
      ),
    ]);
    set({ boards, todos, notes, sections, handoffs });
```

- [ ] **Step 2: Add the drawer panel**

In `src/ui/components/DetailDrawer.tsx`, pull the new store slices (컴포넌트 상단의 기존 `useStore` 사용 방식을 따른다):

```tsx
  const handoffs = useStore((s) => s.handoffs);
  const sessions = useStore((s) => s.sessions);
  const fetchSessions = useStore((s) => s.fetchSessions);
  const sendHandoff = useStore((s) => s.sendHandoff);
  const cancelHandoff = useStore((s) => s.cancelHandoff);
```

Then add local state and render an action button plus the panel. 실패해도 패널과 입력이 열린 채 남아야 한다 — PR #11 의 one-shot 입력 회귀를 반복하지 않는다.

```tsx
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [handoffNote, setHandoffNote] = useState('');
  const [handoffSession, setHandoffSession] = useState('');
  const [handoffBusy, setHandoffBusy] = useState(false);
  const [handoffError, setHandoffError] = useState<string | null>(null);

  const pending = handoffs.find((h) => h.todoId === todo.id && h.status === 'pending');

  const openHandoff = async () => {
    setHandoffOpen(true);
    setHandoffError(null);
    try {
      await fetchSessions();
    } catch (error) {
      setHandoffError(error instanceof Error ? error.message : String(error));
    }
  };

  const submitHandoff = async () => {
    setHandoffBusy(true);
    setHandoffError(null);
    try {
      await sendHandoff(todo.id, {
        sessionId: handoffSession || undefined,
        note: handoffNote || undefined,
      });
      // 성공했을 때만 닫는다 — 실패하면 고쳐서 다시 낼 수 있어야 한다.
      setHandoffOpen(false);
      setHandoffNote('');
      setHandoffSession('');
    } catch (error) {
      setHandoffError(error instanceof Error ? error.message : String(error));
    } finally {
      setHandoffBusy(false);
    }
  };
```

Render:

```tsx
{pending ? (
  <div className="handoff-pending">
    <span>대기 중 · {pending.sessionName ?? pending.sessionId} 에게</span>
    {pending.stale ? <span className="handoff-stale">세션 없음</span> : null}
    <button type="button" onClick={() => cancelHandoff(pending.id)}>
      취소
    </button>
  </div>
) : (
  <button type="button" onClick={openHandoff}>
    에이전트에게 보내기
  </button>
)}

{handoffOpen && !pending ? (
  <div className="handoff-panel">
    {sessions.available ? (
      <>
        <select value={handoffSession} onChange={(e) => setHandoffSession(e.target.value)}>
          <option value="">자동 (이 보드의 세션)</option>
          {sessions.list.map((session) => (
            <option key={session.sessionId} value={session.sessionId}>
              {session.name} · {session.status} · {session.cwd}
            </option>
          ))}
        </select>
        <input
          value={handoffNote}
          placeholder="메모 (선택)"
          onChange={(e) => setHandoffNote(e.target.value)}
        />
        <button type="button" onClick={submitHandoff} disabled={handoffBusy}>
          보내기
        </button>
      </>
    ) : (
      <p>세션 목록을 가져올 수 없다: {sessions.reason}</p>
    )}
    {handoffError ? (
      <p className="handoff-error" role="alert">
        {handoffError}
      </p>
    ) : null}
  </div>
) : null}
```

- [ ] **Step 3: Add the list badge**

In `src/ui/components/TodoItem.tsx`, look the pending handoff up from the store and render a badge:

```tsx
  const pendingHandoff = useStore((s) =>
    s.handoffs.find((h) => h.todoId === todo.id && h.status === 'pending'),
  );
```

```tsx
{pendingHandoff ? (
  <span className="chip chip-handoff" title={`${pendingHandoff.sessionName ?? ''} 에게 보냄`}>
    → {pendingHandoff.sessionName ?? '세션'}
  </span>
) : null}
```

- [ ] **Step 4: Add styles**

In `src/ui/styles.css`, add near the existing chip/doing styles. `doing` 앰버와 색을 구분한다 — "보냈다"와 "처리 중"은 다른 상태다:

```css
.chip-handoff {
  background: #1e3a5f;
  color: #93c5fd;
}
.handoff-panel {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}
.handoff-pending {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  color: #93c5fd;
}
.handoff-stale {
  color: #f87171;
}
.handoff-error {
  color: #f87171;
  width: 100%;
}
```

- [ ] **Step 5: Verify by hand**

이 레포에는 React 컴포넌트 렌더 테스트 도구가 없다(`rocky-todo#14` 로 검토 중). 격리 데몬을 띄워 브라우저로 확인한다:

```bash
ROCKY_TODO_PORT=8637 ROCKY_TODO_DIR=/tmp/rocky-todo-handoff bun run src/daemon.ts
```

확인할 것:
1. 드로어에 "에이전트에게 보내기" 가 보인다.
2. 누르면 세션 목록이 뜬다 (`claude` 가 없으면 이유가 보인다).
3. 존재하지 않는 세션으로 보내면 에러가 `role="alert"` 로 뜨고 **패널이 닫히지 않는다**.
4. 보낸 뒤 드로어에 "대기 중 · <세션> 에게" + 취소 버튼, 목록에 뱃지가 보인다.
5. 취소하면 둘 다 사라진다.

- [ ] **Step 6: Gate + commit**

```bash
bun run check && bun run typecheck && bun test
git add src/ui
git commit -m "feat(ui): 에이전트에게 보내기 패널과 대기 뱃지"
```

---

### Task 9: 문서 동기화 + changeset

**Files:**
- Modify: `FEATURES.md`, `AGENTS.md`, `README.md`, `docs/rocky-todo.md`
- Modify: `skills/board/SKILL.md`
- Create: `.changeset/<generated>.md`

**Interfaces:**
- Consumes: 앞선 모든 태스크의 최종 표면
- Produces: 없음 (문서)

- [ ] **Step 1: Update `AGENTS.md`**

Layout 트리에 새 파일을 넣는다:

```
│   ├── sessions.ts                 # claude agents --json 래퍼 (활성 세션 목록 + 보드 매칭)
│   ├── handoff.ts                  # 핸드오프 주입문 생성 (순수)
```

```
│   ├── handoff-stop.ts (+test)     # Stop 훅 — 대기 중인 보드 요청을 집어 자동 착수 (fail-open, DI)
```

"데몬/설치 모델 (핵심)" 아래에 한 항목을 추가한다:

```markdown
- **핸드오프(보드 → 세션)**: 보드에서 todo 를 실행 중인 Claude Code 세션에 넘긴다.
  데몬은 세션에 밀 수 없다(훅으로 유휴 세션을 깨울 수단이 없다) — `handoffs` 큐에 쌓고
  세션 훅이 당겨간다. `Stop` 훅이 집으면 `decision: block` 으로 그 자리에서 착수하고,
  `UserPromptSubmit` 훅은 사용자가 말을 걸 때 같은 큐를 본다. 한 번에 한 건만 배달한다.
  세션 목록은 `claude agents --json` (`src/sessions.ts`, 주입 가능 `RunCommand`).
  대상은 보드 key ↔ 세션 cwd **경로 세그먼트** 매칭 — 후보가 정확히 1개일 때만 자동으로
  보내고 아니면 사용자가 고른다. **MCP 도구는 늘리지 않았다(5개 유지)** — 사람이
  에이전트에게 넘기는 기능이지 에이전트끼리 일을 미루는 경로가 아니다.
```

- [ ] **Step 2: Update `FEATURES.md`**

CLI 표에 두 줄을 넣는다:

```
| `rocky-todo handoff REF [--session NAME] [--note "본문"]` | 실행 중인 Claude Code 세션에 작업 요청을 보낸다 |
| `rocky-todo sessions` | 실행 중인 세션 목록 (`*` = 현재 보드와 일치) |
```

그리고 기능 목록에 다음 문단을 넣는다:

```markdown
### 에이전트에게 작업 넘기기

보드의 todo 를 실행 중인 Claude Code 세션에 넘긴다. 드로어의 "에이전트에게 보내기" 를
누르면 활성 세션 목록이 뜨고(보드 이름과 경로가 맞는 세션에 `*`), 고른 세션이 **턴을
끝내는 순간 자동으로 그 항목에 착수**한다. 사용자가 그 세션에 다음 입력을 넣을 때도
같은 큐가 배달된다. 여러 건을 보내면 한 번에 하나씩 순서대로 소화한다.

세션 목록은 `claude agents --json` 에서 얻으므로 `claude` CLI 가 PATH 에 있어야 한다 —
없으면 이 버튼만 비활성되고 보드는 정상 동작한다. 대기 중인 요청은 만료되지 않으며,
대상 세션이 사라지면 보드에 "세션 없음" 으로 표시된다.
```

- [ ] **Step 3: Update `docs/rocky-todo.md`**

운영 관점 두 가지를 적는다:
- 이 기능은 `claude` CLI 가 PATH 에 있어야 동작한다. 없으면 버튼이 비활성될 뿐 보드는 정상이다.
- `Stop` 훅이 추가되어 플러그인 업데이트 후 첫 세션부터 적용된다.

- [ ] **Step 4: Update `README.md`**

기능 요약 줄에 핸드오프를 더한다 — 기존 나열(계층·섹션·보드, 우선순위, doing 표시, 댓글)의
끝에 다음을 잇는다:

```markdown
실행 중인 Claude Code 세션으로 작업 넘기기(보드 버튼 → 그 세션이 턴을 끝내며 자동 착수)
```

- [ ] **Step 5: Update `skills/board/SKILL.md`**

에티켓에 한 항목을 추가한다:

```markdown
6. **보드에서 넘어온 요청**: `# rocky-todo: 보드에서 도착한 작업 요청` 블록이 보이면
   사용자가 보드에서 명시적으로 넘긴 것이다. 착수 전 재확인은 필요 없지만, `todo_status`
   의 `start` 로 표시는 반드시 남긴다 — 사용자는 그 뱃지로 진행을 확인한다.
```

- [ ] **Step 6: Create the changeset**

```bash
bunx changeset
```

Select `minor`. Summary:

```
보드에서 실행 중인 Claude Code 세션으로 todo 를 넘기는 핸드오프. 웹 UI 버튼 / `rocky-todo handoff` CLI 로 보내면 대상 세션이 턴을 끝내는 순간 자동으로 착수한다. 세션 목록은 `claude agents --json` 에서 얻고, 보드 key 와 세션 cwd 가 애매하면 사용자가 고른다. MCP 도구는 5개 그대로.
```

- [ ] **Step 7: Final gate + commit**

```bash
bun run check && bun run typecheck && bun test
git add -A
git commit -m "docs(handoff): 핸드오프 문서 동기화 + changeset"
```

---

## 완료 조건

- `bun run check` · `bun run typecheck` · `bun test` 전부 통과 — `claude` CLI 가 없는 환경에서도.
- 브라우저 수동 확인(Task 8 Step 5) 다섯 항목 통과.
- 실제 핸드오프 왕복 1회: 다른 워크트리의 세션으로 todo 를 보내고, 그 세션이 턴을 끝낼 때
  자동으로 집어 `start` 표시가 보드에 뜨는 것까지 확인.
