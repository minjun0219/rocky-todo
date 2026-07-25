# 사람이 읽고 쓰는 todo 번호 (`#12`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** todo/note 에 보드별 순번(`#12`)을 부여해 사람이 읽고, 치고, 말할 수 있게 한다.

**Architecture:** 랜덤 8자 base36 `id` 는 PK 로 그대로 두고(히스토리·`parent_id`·링크가 참조),
표시·참조용 `number INTEGER` 컬럼을 더한다. 발급은 보드별 `MAX(number)+1` — 기존
`nextPosition` 과 같은 패턴. 참조 해석은 `rocky#12` → `#12`/`12` → id → id prefix 순.
첫 스키마 변경이므로 `PRAGMA user_version` 기반 마이그레이션 러너를 함께 들인다.

**Tech Stack:** TypeScript (ESM, `type: module`) · Bun (`bun:sqlite`, `bun:test`) · React 19 + zustand (웹 UI) · Biome

## Global Constraints

- 확장자 없는 상대경로 import (`moduleResolution: Bundler`). `src/*` 끼리는 `./`, `hooks/*` 는 `../src/*`.
- `__dirname` 금지 — `import.meta.dir` / `import.meta.url`.
- 신규 런타임 dependency 추가 금지. `bun:sqlite` / `bun:test` 내장 사용.
- 삭제 없음 — 아카이브만. 번호는 아카이브 후에도 회수하지 않는다.
- JSDoc 은 exported 함수/클래스에. 한국어 주석 OK, 식별자/경로/명령은 영어.
- fs 의존 테스트는 `mkdtempSync` 로 격리.
- 게이트: `bun run check` · `bun run typecheck` · `bun test` 셋 다 통과해야 커밋.
- 커밋 제목은 Conventional Commits (`type(scope): 한국어 요약`, 50자 내외).

## File Structure

| 파일 | 책임 | 변경 |
|---|---|---|
| `src/migrations.ts` | 마이그레이션 목록 + 러너 (`user_version` 관리, 백업) | **신규** |
| `src/migrations.test.ts` | 러너 단위 테스트 | **신규** |
| `src/store.ts` | 스키마, 번호 발급, 참조 해석, 모델 매핑 | 수정 |
| `src/server.ts` | `ref` 직렬화, 경로 파라미터가 참조 문법 수용 | 수정 |
| `src/cli.ts` | `#N` 출력, 인자 파싱 | 수정 |
| `src/mcp.ts` | 도구 스키마 설명, 응답 필드 | 수정 |
| `src/ui/lib.ts` | 클립보드 헬퍼(폴백 포함), `formatRef` | 수정 |
| `src/ui/components/TodoItem.tsx` | 제목 앞 `#N` + 클릭 복사 | 수정 |
| `src/ui/components/DetailDrawer.tsx` | `drawer-id` → `rocky#12`, 랜덤 id 병기 | 수정 |
| `src/ui/components/NotesRail.tsx` | 노트 카드 번호 + 복사 | 수정 |
| `src/ui/styles.css` | `.todo-ref` 스타일, 모바일 터치 타깃 | 수정 |

마이그레이션을 `store.ts` 에 넣지 않고 파일을 분리하는 이유: `store.ts` 는 이미 900줄이 넘고,
마이그레이션은 앞으로 계속 늘어나는 목록이라 책임이 다르다.

---

### Task 1: 마이그레이션 러너 + `number` 컬럼

**Files:**
- Create: `src/migrations.ts`
- Create: `src/migrations.test.ts`
- Modify: `src/store.ts` (생성자에서 러너 호출)

**Interfaces:**
- Consumes: `Database` from `bun:sqlite`
- Produces: `runMigrations(db: Database, opts?: { backupPath?: string }): number` — 적용 후 최종 `user_version` 반환. `MIGRATIONS: Migration[]` (인덱스+1 = 버전).

- [ ] **Step 1: 러너 실패 테스트 작성**

`src/migrations.test.ts`:

```ts
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { type Migration, runMigrations } from './migrations';

function memDb(): Database {
  const db = new Database(':memory:');
  db.run('CREATE TABLE t (id TEXT PRIMARY KEY)');
  return db;
}

describe('runMigrations', () => {
  test('user_version 0 에서 모든 마이그레이션을 순서대로 적용한다', () => {
    const db = memDb();
    const applied: number[] = [];
    const migrations: Migration[] = [
      (d) => {
        applied.push(1);
        d.run('ALTER TABLE t ADD COLUMN a INTEGER');
      },
      (d) => {
        applied.push(2);
        d.run('ALTER TABLE t ADD COLUMN b INTEGER');
      },
    ];
    expect(runMigrations(db, { migrations })).toBe(2);
    expect(applied).toEqual([1, 2]);
    db.close();
  });

  test('재실행하면 아무것도 적용하지 않는다 (멱등)', () => {
    const db = memDb();
    const applied: number[] = [];
    const migrations: Migration[] = [
      (d) => {
        applied.push(1);
        d.run('ALTER TABLE t ADD COLUMN a INTEGER');
      },
    ];
    runMigrations(db, { migrations });
    runMigrations(db, { migrations });
    expect(applied).toEqual([1]);
    db.close();
  });

  test('마이그레이션이 던지면 롤백하고 user_version 을 올리지 않는다', () => {
    const db = memDb();
    const migrations: Migration[] = [
      (d) => {
        d.run('ALTER TABLE t ADD COLUMN a INTEGER');
        throw new Error('boom');
      },
    ];
    expect(() => runMigrations(db, { migrations })).toThrow('boom');
    const version = db.query<{ user_version: number }, []>('PRAGMA user_version').get();
    expect(version?.user_version).toBe(0);
    const cols = db.query<{ name: string }, []>('PRAGMA table_info(t)').all();
    expect(cols.some((c) => c.name === 'a')).toBe(false);
    db.close();
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `bun test ./src/migrations.test.ts`
Expected: FAIL — `Cannot find module './migrations'`

- [ ] **Step 3: 러너 구현**

`src/migrations.ts`:

```ts
import { copyFileSync, existsSync } from 'node:fs';
import type { Database } from 'bun:sqlite';

/** 스키마 마이그레이션 하나 — 같은 트랜잭션 안에서 실행된다. */
export type Migration = (db: Database) => void;

/**
 * 마이그레이션 1: todo/note 에 보드별 순번(number)을 부여한다.
 *
 * 랜덤 id 는 PK 로 그대로 두고 표시·참조용 번호만 더한다. 기존 행에는 보드별로
 * created_at 순(동률이면 id 순 — 같은 밀리초 생성의 결정성)으로 1부터 소급 부여한다.
 */
const addNumbers: Migration = (db) => {
  db.run('ALTER TABLE todos ADD COLUMN number INTEGER');
  db.run('ALTER TABLE notes ADD COLUMN number INTEGER');

  for (const table of ['todos', 'notes'] as const) {
    const rows = db
      .query<{ id: string; board_id: string | null }, []>(
        `SELECT id, board_id FROM ${table} ORDER BY board_id, created_at ASC, id ASC`,
      )
      .all();
    const counters = new Map<string, number>();
    const update = db.query(`UPDATE ${table} SET number = ? WHERE id = ?`);
    for (const row of rows) {
      const key = row.board_id ?? '';
      const next = (counters.get(key) ?? 0) + 1;
      counters.set(key, next);
      update.run(next, row.id);
    }
  }

  db.run('CREATE UNIQUE INDEX idx_todos_number ON todos(board_id, number)');
  db.run('CREATE UNIQUE INDEX idx_notes_number ON notes(board_id, number)');
  // notes.board_id 는 nullable 이고 SQLite 는 유니크 인덱스에서 NULL 을 서로 다른 값으로
  // 취급한다 — 글로벌 메모끼리의 유일성은 부분 인덱스로 따로 건다.
  db.run('CREATE UNIQUE INDEX idx_notes_number_global ON notes(number) WHERE board_id IS NULL');
};

/** 적용 순서 = 배열 순서. 인덱스+1 이 곧 user_version. 기존 항목은 절대 수정하지 않는다. */
export const MIGRATIONS: Migration[] = [addNumbers];

export interface RunMigrationsOptions {
  /** 테스트에서 목록을 주입한다. 기본은 MIGRATIONS. */
  migrations?: Migration[];
  /**
   * 적용 전 DB 를 복사해 둘 경로. dbPath 가 없거나(:memory: 등) 파일이 없거나, todos/notes
   * 에 아직 아무 행도 없는 신규 DB(백업할 내용이 없음)면 생략한다.
   */
  backupPath?: string;
  /** 백업 원본 경로. backupPath 와 함께 줄 때만 백업한다. */
  dbPath?: string;
}

/**
 * todos/notes 에 백업할 만한 데이터가 있는지 본다.
 *
 * 두 테이블 다 비어 있으면(막 만든 신규 DB) 백업이 무의미하다 — 신규 설치·임시 디렉터리
 * 테스트마다 `*.bak-v0` 잔재가 남는 걸 막는다. 테이블 자체가 없는 등 판단할 수 없는 경우는
 * 보수적으로 true(백업함) 를 반환한다.
 */
function hasDataWorthBackingUp(db: Database): boolean {
  try {
    const todos = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM todos').get()?.n ?? 0;
    if (todos > 0) {
      return true;
    }
    const notes = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM notes').get()?.n ?? 0;
    return notes > 0;
  } catch {
    return true;
  }
}

/**
 * user_version 보다 뒤에 있는 마이그레이션만 순서대로 적용한다.
 *
 * 각 마이그레이션은 트랜잭션 안에서 실행되며, 던지면 롤백하고 user_version 도 올리지
 * 않는다 — 실패한 마이그레이션은 다음 기동에서 다시 시도된다. user_version 갱신은 같은
 * 트랜잭션 안에서 스키마 변경과 함께 커밋된다 — COMMIT 뒤 별도로 쓰면 그 사이 프로세스가
 * 죽었을 때 스키마는 적용됐는데 user_version 은 0 인 상태가 남아, 다음 기동에서 같은
 * 마이그레이션이 재실행되며 (예: ALTER TABLE 의 duplicate column) 영구히 기동 불가에 빠진다.
 * @returns 적용 후 최종 user_version.
 */
export function runMigrations(db: Database, options: RunMigrationsOptions = {}): number {
  const migrations = options.migrations ?? MIGRATIONS;
  const current =
    db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version ?? 0;
  if (current >= migrations.length) {
    return current;
  }

  if (
    options.backupPath &&
    options.dbPath &&
    existsSync(options.dbPath) &&
    hasDataWorthBackingUp(db)
  ) {
    copyFileSync(options.dbPath, options.backupPath);
  }

  let version = current;
  for (let i = current; i < migrations.length; i++) {
    const migration = migrations[i];
    if (!migration) {
      continue;
    }
    db.run('BEGIN');
    try {
      migration(db);
      version = i + 1;
      // PRAGMA 는 바인딩을 받지 않는다 — 값이 정수임은 루프 인덱스로 보장된다.
      // COMMIT 전에 실행해야 스키마 변경과 원자적으로 묶인다(SQLite user_version 은
      // 데이터베이스 헤더에 있고 트랜잭션에 참여한다).
      db.run(`PRAGMA user_version = ${version}`);
      db.run('COMMIT');
    } catch (error) {
      db.run('ROLLBACK');
      throw error;
    }
  }
  return version;
}
```

- [ ] **Step 4: 통과 확인**

Run: `bun test ./src/migrations.test.ts`
Expected: PASS (6 tests — 원래 3개 + user_version/COMMIT 원자성 회귀 1개 + 백업 스킵/수행 2개)

- [ ] **Step 5: store 생성자에서 러너 호출**

`src/store.ts` 상단 import 에 추가:

```ts
import { runMigrations } from './migrations';
```

생성자(`src/store.ts:295-301`)를 이렇게 바꾼다:

```ts
  constructor(options: TodoStoreOptions) {
    mkdirSync(dirname(options.dbPath), { recursive: true });
    this.db = new Database(options.dbPath, { create: true });
    this.db.run('PRAGMA journal_mode = WAL');
    this.db.run('PRAGMA foreign_keys = ON');
    this.db.run(SCHEMA);
    runMigrations(this.db, {
      dbPath: options.dbPath,
      backupPath: `${options.dbPath}.bak-v0`,
    });
  }
```

- [ ] **Step 6: 기존 테스트 회귀 확인**

Run: `bun test`
Expected: PASS — 기존 테스트가 전부 통과해야 한다 (신규 DB 는 마이그레이션이 즉시 적용됨)

- [ ] **Step 7: 게이트 + 커밋**

```bash
bun run check && bun run typecheck && bun test
git add src/migrations.ts src/migrations.test.ts src/store.ts
git commit -m "feat(todo): user_version 마이그레이션 러너 + number 컬럼"
```

---

### Task 2: 번호 발급 + 모델 노출

**Files:**
- Modify: `src/store.ts` (`TodoRow`/`NoteRow` 타입, `Todo`/`Note` 인터페이스, `nextNumber`, `createTodo`, `createNote`, `toTodo`, `toNote`)
- Test: `src/store.test.ts`

**Interfaces:**
- Consumes: Task 1 의 `number` 컬럼
- Produces: `Todo.number: number` · `Note.number: number` · `TodoStore.boardKeyOf(boardId: string): string`

- [ ] **Step 1: 실패 테스트 작성**

`src/store.test.ts` 끝에 추가:

```ts
describe('number 발급', () => {
  test('보드 안에서 1부터 연속으로 매겨진다', () => {
    const a = store.createTodo({ board: 'alpha', title: '첫째' }, 'tester');
    const b = store.createTodo({ board: 'alpha', title: '둘째' }, 'tester');
    expect(a.number).toBe(1);
    expect(b.number).toBe(2);
  });

  test('보드마다 번호 공간이 독립이다', () => {
    store.createTodo({ board: 'alpha', title: '첫째' }, 'tester');
    const other = store.createTodo({ board: 'beta', title: '다른 보드 첫째' }, 'tester');
    expect(other.number).toBe(1);
  });

  test('아카이브해도 번호를 회수하지 않는다', () => {
    const a = store.createTodo({ board: 'alpha', title: '첫째' }, 'tester');
    store.setTodoStatus(a.id, 'archive', 'tester');
    const b = store.createTodo({ board: 'alpha', title: '둘째' }, 'tester');
    expect(b.number).toBe(2);
  });

  test('노트도 보드별로 번호를 받는다', () => {
    const n = store.createNote({ board: 'alpha', title: '메모' }, 'tester');
    expect(n.number).toBe(1);
  });

  test('글로벌 노트는 보드 노트와 독립된 번호 공간을 쓴다', () => {
    store.createNote({ board: 'alpha', title: '보드 메모' }, 'tester');
    const g = store.createNote({ title: '글로벌 메모' }, 'tester');
    expect(g.number).toBe(1);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `bun test ./src/store.test.ts`
Expected: FAIL — `expect(received).toBe(expected)` / `number` 가 `undefined`

- [ ] **Step 3: 타입에 number 추가**

`src/store.ts` 의 `Todo` 인터페이스에서 `id: string;` 바로 아래에 추가:

```ts
  /** 보드별 순번 — 사람이 읽고 부르는 참조(#12). id 와 달리 보드 안에서만 유일하다. */
  number: number;
```

`Note` 인터페이스에도 `id: string;` 아래에 같은 줄을 추가한다.

`TodoRow` 와 `NoteRow` 타입에도 `number: number;` 를 추가한다(컬럼명이 그대로 `number`).

- [ ] **Step 4: nextNumber 구현**

`src/store.ts` 의 `nextPosition`(410-418행) 바로 아래에 추가:

```ts
  /**
   * 보드 안에서 다음 번호 — MAX(number)+1 이라 아카이브된 항목이 있어도 회수하지 않는다.
   * @param boardId null 이면 글로벌 노트 공간.
   */
  private nextNumber(table: 'todos' | 'notes', boardId: string | null): number {
    const where = boardId === null ? 'board_id IS NULL' : 'board_id = ?';
    const row = this.db
      .query<{ max: number | null }, string[]>(
        `SELECT MAX(number) AS max FROM ${table} WHERE ${where}`,
      )
      .get(...(boardId === null ? [] : [boardId]));
    return (row?.max ?? 0) + 1;
  }
```

- [ ] **Step 5: createTodo 에 번호 반영**

`src/store.ts:437` 의 `const todo: Todo = {` 객체에서 `id: newId(),` 아래에 추가:

```ts
      number: this.nextNumber('todos', board.id),
```

같은 함수의 INSERT 문(455-457행)을 컬럼과 플레이스홀더를 하나씩 늘려 바꾼다:

```ts
        `INSERT INTO todos (id, number, board_id, section_id, parent_id, title, description, status, priority, due, labels, links, position, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
```

`.run(` 인자 목록에서 `todo.id,` 다음 줄에 `todo.number,` 를 넣는다.

- [ ] **Step 6: createNote 에 같은 방식 적용**

`createNote`(664행 근처)에서 `position: this.nextPosition('notes', boardId),` 옆에
`number: this.nextNumber('notes', boardId),` 를 추가하고, INSERT 문과 `.run()` 인자에도
`number` 를 같은 방식으로 넣는다.

- [ ] **Step 7: 매퍼에 number 추가**

`toTodo`(890행)와 `toNote`(913행)의 반환 객체에서 `id: row.id,` 아래에 각각 추가:

```ts
    number: row.number,
```

- [ ] **Step 8: boardKeyOf 헬퍼 추가**

`ref` 문자열(`rocky#12`)을 만들려면 board key 가 필요하다. `TodoStore` 의 public 메서드로
추가한다 (`nextNumber` 아래):

```ts
  /** boardId → board key. ref(`rocky#12`) 조립에 쓴다. 없는 보드면 빈 문자열. */
  boardKeyOf(boardId: string): string {
    const row = this.db
      .query<{ key: string }, [string]>('SELECT key FROM boards WHERE id = ?')
      .get(boardId);
    return row?.key ?? '';
  }
```

- [ ] **Step 9: 통과 확인**

Run: `bun test ./src/store.test.ts`
Expected: PASS

- [ ] **Step 10: 게이트 + 커밋**

```bash
bun run check && bun run typecheck && bun test
git add src/store.ts src/store.test.ts
git commit -m "feat(todo): 보드별 번호 발급 + 모델 노출"
```

---

### Task 3: 참조 해석 (`rocky#12` / `#12` / id / prefix)

**Files:**
- Modify: `src/store.ts` (`resolveByPrefix` → `resolveRef`, 호출부)
- Test: `src/store.test.ts`

**Interfaces:**
- Consumes: Task 2 의 `number`
- Produces: `TodoStore.getTodo(ref: string, currentBoardId?: string)` · `getNote(ref, currentBoardId?)` 가 참조 문법 수용. `ID_LENGTH` 상수 export.

- [ ] **Step 1: 실패 테스트 작성**

`src/store.test.ts` 에 추가:

```ts
describe('참조 해석', () => {
  test('rocky#12 형태로 보드를 지정해 찾는다', () => {
    const t = store.createTodo({ board: 'alpha', title: '대상' }, 'tester');
    expect(store.getTodo(`alpha#${t.number}`)?.id).toBe(t.id);
  });

  test('#N 과 N 은 현재 보드에서 찾는다', () => {
    const board = store.ensureBoard('alpha', { actor: 'tester' });
    const t = store.createTodo({ board: 'alpha', title: '대상' }, 'tester');
    expect(store.getTodo(`#${t.number}`, board.id)?.id).toBe(t.id);
    expect(store.getTodo(String(t.number), board.id)?.id).toBe(t.id);
  });

  test('8자 base36 입력은 번호가 아니라 id 로 해석한다', () => {
    const t = store.createTodo({ board: 'alpha', title: '대상' }, 'tester');
    expect(store.getTodo(t.id)?.id).toBe(t.id);
  });

  test('짧은 문자열은 기존처럼 id prefix 로 해석한다', () => {
    const t = store.createTodo({ board: 'alpha', title: '대상' }, 'tester');
    expect(store.getTodo(t.id.slice(0, 5))?.id).toBe(t.id);
  });

  test('현재 보드 없이 #N 만 오면 모호성을 에러로 노출한다', () => {
    store.createTodo({ board: 'alpha', title: '대상' }, 'tester');
    expect(() => store.getTodo('#1')).toThrow(/board/i);
  });

  test('없는 번호는 undefined', () => {
    store.createTodo({ board: 'alpha', title: '대상' }, 'tester');
    expect(store.getTodo('alpha#999')).toBeUndefined();
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `bun test ./src/store.test.ts`
Expected: FAIL — `alpha#1` 이 id prefix 로 해석돼 `undefined`

- [ ] **Step 3: ID_LENGTH 상수화**

`src/store.ts:157-167` 의 `newId` 부근을 바꾼다:

```ts
const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** 랜덤 id 길이 — 참조 해석이 "번호냐 id 냐"를 가르는 기준이라 상수로 묶어 둔다. */
export const ID_LENGTH = 8;

/** 8자 base36 랜덤 id — 짧아서 CLI/대화에서 다루기 좋고 prefix 매칭을 허용한다. */
function newId(): string {
  const bytes = randomBytes(ID_LENGTH);
  let id = '';
  for (const b of bytes) {
    id += ID_ALPHABET[b % 36];
  }
  return id;
}
```

- [ ] **Step 4: resolveRef 구현**

`src/store.ts:852-867` 의 `resolveByPrefix` 를 통째로 대체한다:

```ts
  /**
   * 참조 문자열을 행으로 해석한다. 순서대로:
   *   `rocky#12` → 그 보드의 12번 · `#12`/`12` → currentBoardId 의 12번
   *   (notes 이고 currentBoardId 없으면 → 전역 note 공간의 12번)
   *   `921gvwnr`(ID_LENGTH 자 base36) → id 정확 일치 · 그 외 → 유일한 id prefix
   *
   * 길이 기준으로 번호와 id 를 가르므로, id 길이를 바꾸면 ID_LENGTH 만 고치면 된다.
   * notes 는 board_id IS NULL 인 전역 행을 가질 수 있어 자체 번호 시퀀스를 갖지만(부분 유니크
   * 인덱스 `idx_notes_number_global`), todos 는 항상 보드에 속하므로 전역 번호 공간이 없다.
   * @throws 다중 prefix 매칭이거나, todos 에 현재 보드 없이 번호만 온 경우 (모호성 노출)
   */
  private resolveRef<Row>(
    table: 'todos' | 'notes',
    ref: string,
    currentBoardId?: string,
  ): Row | undefined {
    const trimmed = ref.trim();

    const scoped = /^([a-z0-9][\w.-]*)#(\d+)$/i.exec(trimmed);
    if (scoped?.[1] && scoped[2]) {
      const board = this.db
        .query<{ id: string }, [string]>('SELECT id FROM boards WHERE key = ?')
        .get(scoped[1]);
      if (!board) {
        return undefined;
      }
      return this.db
        .query<Row, [string, number]>(`SELECT * FROM ${table} WHERE board_id = ? AND number = ?`)
        .get(board.id, Number(scoped[2]));
    }

    // '#' 가 붙으면 자릿수와 무관하게 무조건 번호다 ('#' 는 id 알파벳에 없다).
    // '#' 없는 bare 숫자만 길이로 가른다 — ID_LENGTH 와 같은 자릿수면 id 로 취급해야
    // 무작위 id 가 전부 숫자로 나온 경우('00000012' 등)와 안전하게 구분된다.
    const bare = /^(#)?(\d+)$/.exec(trimmed);
    if (bare?.[2] && (bare[1] || bare[2].length < ID_LENGTH)) {
      if (!currentBoardId) {
        // notes 는 board_id IS NULL 인 전역 번호 공간이 있다 — 웹 UI 가 글로벌 note 를
        // 보드 접두사 없이 `#3` 으로만 보여주므로, 그 참조가 복붙으로 다시 풀려야 한다.
        // todos 는 전역 번호 공간이 없으므로 그대로 에러를 던진다.
        if (table === 'notes') {
          return this.db
            .query<Row, [number]>(`SELECT * FROM ${table} WHERE board_id IS NULL AND number = ?`)
            .get(Number(bare[2]));
        }
        throw new Error(`board context required to resolve ${trimmed} — use board#number`);
      }
      return this.db
        .query<Row, [string, number]>(`SELECT * FROM ${table} WHERE board_id = ? AND number = ?`)
        .get(currentBoardId, Number(bare[2]));
    }

    const exact = this.db.query<Row, [string]>(`SELECT * FROM ${table} WHERE id = ?`).get(trimmed);
    if (exact) {
      return exact;
    }
    const matches = this.db
      .query<Row, [string]>(`SELECT * FROM ${table} WHERE id LIKE ? || '%' LIMIT 2`)
      .all(trimmed);
    if (matches.length > 1) {
      throw new Error(`ambiguous id prefix: ${trimmed}`);
    }
    return matches[0];
  }
```

- [ ] **Step 5: 호출부 갱신**

`src/store.ts` 에서 `resolveByPrefix` 를 부르던 모든 지점을 `resolveRef` 로 바꾸고,
`getTodo` / `getNote` 및 이들을 경유하는 public 메서드(`updateTodo`, `setTodoStatus`,
`updateNote`, `archiveNote` 등)에 `currentBoardId?: string` 선택 인자를 추가해 그대로 넘긴다.

Run 으로 남은 호출부를 확인한다:

```bash
grep -n "resolveByPrefix" src/*.ts
```

Expected: 결과 없음

- [ ] **Step 6: 통과 확인**

Run: `bun test ./src/store.test.ts`
Expected: PASS

- [ ] **Step 7: 게이트 + 커밋**

```bash
bun run check && bun run typecheck && bun test
git add src/store.ts src/store.test.ts
git commit -m "feat(todo): 번호/id 참조 해석 통합"
```

---

### Task 4: REST + MCP 표면

**Files:**
- Modify: `src/server.ts` (응답 직렬화, 경로 파라미터)
- Modify: `src/mcp.ts` (도구 스키마 설명)
- Test: `src/server.test.ts`, `src/mcp.test.ts`

**Interfaces:**
- Consumes: Task 2 의 `Todo.number`/`boardKeyOf`, Task 3 의 참조 해석
- Produces: `TodoView extends Todo { ref: string }` · `NoteView extends Note { ref: string }`
  (`src/server.ts` 에서 export — Task 5·6·7 이 import 한다) · REST/MCP 응답의 `number`·`ref`

- [ ] **Step 1: 실패 테스트 작성**

`src/server.test.ts` 에 추가:

```ts
describe('number / ref 직렬화', () => {
  test('todo 응답에 number 와 ref 가 실린다', async () => {
    const created = await req('/api/todos', {
      method: 'POST',
      body: JSON.stringify({ board: 'rocky', title: '번호 확인' }),
    });
    const todo = (await created.json()) as { number: number; ref: string };
    expect(todo.number).toBe(1);
    expect(todo.ref).toBe('rocky#1');
  });

  test('번호 참조로 조회된다', async () => {
    await req('/api/todos', {
      method: 'POST',
      body: JSON.stringify({ board: 'rocky', title: '번호 확인' }),
    });
    const res = await req('/api/todos/rocky%231');
    expect(res.status).toBe(200);
    const todo = (await res.json()) as { title: string };
    expect(todo.title).toBe('번호 확인');
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `bun test ./src/server.test.ts`
Expected: FAIL — `ref` 가 `undefined`

- [ ] **Step 3: 뷰 타입 + 직렬화 헬퍼 추가**

`ref` 는 저장 모델(`Todo`/`Note`)이 아니라 **응답에만 있는 파생 필드**다 — `boardKeyOf`
조회가 필요해 순수 매퍼인 `toTodo` 에 넣을 수 없다. 그래서 뷰 타입을 따로 export 하고,
CLI 와 웹 UI 는 이 타입을 쓴다 (Task 5·6·7 이 이 타입에 의존한다).

`src/server.ts` 상단에 추가:

```ts
import type { Note, Todo } from './store';

/** 응답 전용 todo — 저장 모델에 사람이 쓰는 참조(ref)를 얹은 형태. */
export interface TodoView extends Todo {
  /** `rocky#12` — 보드 접두사를 포함한 완전 참조. */
  ref: string;
}

/** 응답 전용 note. 글로벌 메모는 보드 접두사가 없어 `#3` 이 된다. */
export interface NoteView extends Note {
  ref: string;
}
```

`buildTodoServer` 안, `fetch` 정의 위에 추가:

```ts
  const refOf = (boardId: string | undefined, number: number): string =>
    boardId ? `${store.boardKeyOf(boardId)}#${number}` : `#${number}`;

  /** 응답용 직렬화 — 저장 모델에 ref 를 얹는다. */
  const withRef = <T extends Todo | Note>(entity: T): T & { ref: string } => ({
    ...entity,
    ref: refOf(entity.boardId, entity.number),
  });
```

todo/note 를 반환하는 모든 `json(...)` 호출을 `json(withRef(todo))` /
`json(todos.map(withRef))` 형태로 감싼다.

- [ ] **Step 4: 경로 파라미터가 참조를 받게**

`/api/todos/:ref` 계열 핸들러에서 경로 조각을 `decodeURIComponent` 한 뒤 그대로
`store.getTodo(ref, boardId)` 에 넘긴다. `boardId` 는 쿼리스트링 `?board=` 가 있으면
그 보드, 없으면 `undefined`.

- [ ] **Step 5: MCP 스키마 설명 갱신 + board 컨텍스트 배선**

설명만 바꾸는 걸로는 부족하다 — `resolveRef` 는 `#12` 처럼 보드 접두사 없는 맨숫자를
`currentBoardId` 없이 풀면 "board context required" 로 던진다. `id`/ref 인자를 받는
모든 도구(`todo_list`, `todo_write`, `todo_status`, `note_list`, `note_write`)가 실제로
`#12` 를 풀 수 있으려면 호출 시점의 board 를 store 호출에 `currentBoardId` 로 같이
넘겨야 한다:

- 이미 `board` 인자가 있는 도구(`todo_list`, `todo_write`, `note_list`, `note_write`)는
  그 값을 그대로 쓴다.
- `board` 인자가 없는 도구(`todo_status`)는 zod 스키마에 optional `board` 를 추가한다
  (설명: 맨숫자 `#12` 를 스코핑하는 보드 key).
- board key → boardId 변환은 `TodoStore` 에 추가하는 공개 조회(예: `store.boardIdOf(key)`)
  로 한다 — `src/server.ts` 의 `/api/sections` 핸들러도 이미 같은 조회를 인라인으로 하고
  있으니 그 경로도 이 헬퍼로 합친다 (중복 제거).
- 존재하지 않는 board key 는 `boardIdOf` 가 `undefined` 를 반환한다 — 보드를 지어내지
  않고, `currentBoardId` 없이 store 를 호출해 store 자체의 "board context required"
  에러가 그대로 표면화되게 둔다.

```ts
id: z.string().optional().describe('todo ref — number (#12), board-scoped (rocky#12), or raw id'),
```

각 도구의 최상위 description 에도 참조 문법을 한 줄 덧붙이고, 맨숫자 `#12` 를 쓰려면
`board` 를 같이 줘야 한다는 점을 명시한다.

- [ ] **Step 6: 통과 확인**

Run: `bun test ./src/server.test.ts ./src/mcp.test.ts`
Expected: PASS

- [ ] **Step 7: 게이트 + 커밋**

```bash
bun run check && bun run typecheck && bun test
git add src/server.ts src/mcp.ts src/server.test.ts src/mcp.test.ts
git commit -m "feat(todo): REST/MCP 에 number·ref 노출"
```

---

### Task 5: CLI 표시 + 입력

**Files:**
- Modify: `src/cli.ts` (`formatTodoLine`, `show` 상세, HELP)
- Test: `src/cli.test.ts`

**Interfaces:**
- Consumes: Task 4 의 `TodoView` (`import type { TodoView } from './server'`)
- Produces: `formatTodoLine(todo: TodoView, depth: number): string` — id prefix 자리를 `#N` 으로 교체

- [ ] **Step 1: 실패 테스트 작성**

`src/cli.test.ts` 의 `formatTodoLine` describe 안에 추가:

```ts
test('번호를 #N 으로 앞에 붙인다', () => {
  const line = formatTodoLine(
    {
      id: 'a1b2c3d4',
      number: 12,
      boardId: 'b1',
      title: '보드·섹션 생성',
      description: '',
      status: 'todo',
      priority: 'p2',
      labels: [],
      links: [],
      position: 1,
      createdAt: '2026-07-25T00:00:00.000Z',
      updatedAt: '2026-07-25T00:00:00.000Z',
    } as Todo,
    0,
  );
  expect(line).toContain('#12');
  expect(line.indexOf('#12')).toBeLessThan(line.indexOf('보드·섹션 생성'));
});
```

- [ ] **Step 2: 실패 확인**

Run: `bun test ./src/cli.test.ts`
Expected: FAIL — `#12` 없음

- [ ] **Step 3: formatTodoLine 에 번호 추가**

현재 첫 줄이 `todo.id.slice(0, 6)` 으로 id prefix 를 보여준다. **이 자리를 번호로 교체**한다
(둘 다 보여주면 줄이 길어지고, id 는 `show` 상세에 남는다). 시그니처의 타입도
`TodoView` 로 바꾼다.

`src/cli.ts` 의 `formatTodoLine` 첫 줄만 바꾼다:

```ts
export function formatTodoLine(todo: TodoView, depth: number): string {
  const parts: string[] = [
    STATUS_GLYPH[todo.status],
    `#${String(todo.number).padEnd(3)}`,
    todo.title,
  ];
```

`padEnd(3)` 은 `#12 ` 처럼 뒤를 채워 제목 시작 열을 맞춘다. import 에 `TodoView` 를
추가하고(`import type { TodoView } from './server'`), 기존 `Todo` import 가 쓰이지 않게
되면 지운다.

- [ ] **Step 4: show 상세에 ref 와 id 병기**

`show` 커맨드 출력 첫 줄을 `${ref}` 로 바꾸고, 랜덤 id 는 마지막 줄에 `id: ${todo.id}` 로
옮긴다.

- [ ] **Step 5: HELP 갱신**

`src/cli.ts:228` 의 `HELP` 문자열에서 `ID` 로 표기된 자리를 `REF` 로 바꾸고, 상단 설명에
한 줄 추가:

```
REF 는 #12 / 12 (현재 보드) 또는 rocky#12 (보드 지정) 또는 raw id 를 받는다.
```

- [ ] **Step 6: 통과 확인**

Run: `bun test ./src/cli.test.ts`
Expected: PASS

- [ ] **Step 7: 게이트 + 커밋**

```bash
bun run check && bun run typecheck && bun test
git add src/cli.ts src/cli.test.ts
git commit -m "feat(todo): CLI 에 #N 표시 + 참조 입력"
```

---

### Task 6: 웹 UI — 클립보드 헬퍼 + 항목 행

**Files:**
- Modify: `src/ui/lib.ts` (`copyRef`)
- Create: `src/ui/lib.test.ts`
- Modify: `src/ui/components/TodoItem.tsx`
- Modify: `src/ui/styles.css`

**Interfaces:**
- Consumes: Task 4 의 `TodoView`
- Produces: `copyRef(text: string): Promise<boolean>`

**선행 정리:** UI 는 지금 `src/store.ts` 의 `Todo`/`Note` 를 직접 import 한다(`ui/store.ts`,
`components/TodoPane.tsx`, `components/TodoItem.tsx`, `components/NotesRail.tsx`). 이 타입에는
`ref` 가 없으므로, 네 파일의 import 를 `TodoView`/`NoteView`(`../../server`)로 바꾼다.
UI 가 받는 데이터는 REST 응답이라 실제로 `ref` 를 갖고 있다 — 타입만 맞추는 작업이다.

- [ ] **Step 1: 클립보드 헬퍼 실패 테스트**

`src/ui/lib.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { copyRef } from './lib';

describe('copyRef', () => {
  test('navigator.clipboard 가 있으면 그것을 쓴다', async () => {
    const written: string[] = [];
    const original = globalThis.navigator;
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        clipboard: {
          writeText: async (t: string) => {
            written.push(t);
          },
        },
      },
      configurable: true,
    });
    expect(await copyRef('rocky#12')).toBe(true);
    expect(written).toEqual(['rocky#12']);
    Object.defineProperty(globalThis, 'navigator', { value: original, configurable: true });
  });

  test('clipboard 가 없으면 false 를 돌려준다 (호출자가 폴백을 띄운다)', async () => {
    const original = globalThis.navigator;
    Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
    expect(await copyRef('rocky#12')).toBe(false);
    Object.defineProperty(globalThis, 'navigator', { value: original, configurable: true });
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `bun test ./src/ui/lib.test.ts`
Expected: FAIL — `copyRef` export 없음

- [ ] **Step 3: copyRef 구현**

`src/ui/lib.ts` 에 추가:

```ts
/**
 * 참조 문자열을 클립보드에 복사한다.
 *
 * `navigator.clipboard` 는 보안 컨텍스트(HTTPS·루프백)에서만 동작한다 — LAN 평문
 * HTTP(`192.168.x.x:8636`)로 접속하면 없다. 그 경우 execCommand 로 폴백하고,
 * 그마저 실패하면 false 를 돌려줘 호출자가 수동 복사 안내를 띄우게 한다.
 */
export async function copyRef(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // 권한 거부 — 아래 폴백으로 내려간다.
    }
  }
  if (typeof document === 'undefined' || !document.execCommand) {
    return false;
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    document.body.removeChild(area);
  }
}
```

- [ ] **Step 4: 통과 확인**

Run: `bun test ./src/ui/lib.test.ts`
Expected: PASS

- [ ] **Step 5: TodoItem 에 번호 + 복사 붙이기**

`src/ui/components/TodoItem.tsx` 의 체크박스(24-30행)와 제목 버튼(31-33행) 사이에 넣는다.
컴포넌트 상단에 복사 피드백 상태를 둔다:

```tsx
const [copied, setCopied] = useState(false);

const handleCopyRef = async () => {
  const ok = await copyRef(todo.ref);
  setCopied(ok);
  window.setTimeout(() => setCopied(false), 1200);
};
```

```tsx
      <button
        type="button"
        className="todo-ref"
        onClick={handleCopyRef}
        title={copied ? '복사됨' : `${todo.ref} 복사`}
      >
        {copied ? '✓' : `#${todo.number}`}
      </button>
```

import 에 `useState`(react)와 `copyRef`(`../lib`)를 추가한다.

- [ ] **Step 6: 스타일 추가**

`src/ui/styles.css` 에 추가:

```css
.todo-ref {
  flex: 0 0 auto;
  min-width: 3.2em;
  padding: 0;
  border: 0;
  background: none;
  color: var(--muted);
  font-size: 0.85em;
  font-variant-numeric: tabular-nums;
  text-align: right;
  cursor: pointer;
}
.todo-ref:hover {
  color: var(--fg);
  text-decoration: underline;
}
@media (max-width: 900px) {
  /* 터치 타깃 44×44 — 백로그 mxndnikm 1번과 같은 방침 */
  .todo-ref {
    min-height: 44px;
    min-width: 44px;
  }
}
```

- [ ] **Step 7: 게이트 + 커밋**

```bash
bun run check && bun run typecheck && bun test
git add src/ui/lib.ts src/ui/lib.test.ts src/ui/components/TodoItem.tsx src/ui/styles.css
git commit -m "feat(todo): 웹 UI 항목에 #N + 클릭 복사"
```

---

### Task 7: 웹 UI — 드로어 + 노트 레일

**Files:**
- Modify: `src/ui/components/DetailDrawer.tsx`
- Modify: `src/ui/components/NotesRail.tsx`
- Modify: `src/ui/styles.css`

**Interfaces:**
- Consumes: Task 6 의 `copyRef`, Task 4 의 `ref`

- [ ] **Step 1: 드로어 헤더 교체**

`src/ui/components/DetailDrawer.tsx:73` 의 `drawer-id` 줄을 바꾼다:

```tsx
      <button
        type="button"
        className="drawer-ref"
        onClick={() => void copyRef(todo.ref)}
        title="참조 복사"
      >
        {todo.ref}
      </button>
      <h2 className="drawer-title">{todo.title}</h2>
      <div className="drawer-id">{todo.id}</div>
```

`drawer-id` 를 제목 아래로 내리고 더 옅게 만든다 (API/디버깅 용도).

- [ ] **Step 2: 노트 카드에 번호**

`src/ui/components/NotesRail.tsx` 의 `note-card-head`(61행) 안, 제목 앞에 추가:

```tsx
        <button
          type="button"
          className="todo-ref"
          onClick={() => void copyRef(note.ref)}
          title="참조 복사"
        >
          #{note.number}
        </button>
```

- [ ] **Step 3: 스타일**

`src/ui/styles.css` 에 추가:

```css
.drawer-ref {
  padding: 0;
  border: 0;
  background: none;
  color: var(--muted);
  font-size: 0.9em;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
}
.drawer-ref:hover {
  color: var(--fg);
  text-decoration: underline;
}
.drawer-id {
  color: var(--muted);
  font-size: 0.75em;
  opacity: 0.6;
}
```

- [ ] **Step 4: 브라우저 확인**

데몬을 현재 코드로 재기동하고 `http://127.0.0.1:8636` 을 열어 확인한다:

```bash
./bin/rocky-todo daemon stop
bun run src/daemon.ts &
```

확인 항목: 항목 행에 `#N` 이 보이는가 · 클릭하면 `rocky#N` 이 복사되고 `✓` 로 바뀌는가 ·
드로어 상단에 `rocky#N`, 제목 아래 옅게 id 가 있는가 · 노트 카드에 번호가 있는가.

- [ ] **Step 5: 게이트 + 커밋**

```bash
bun run check && bun run typecheck && bun test
git add src/ui/components/DetailDrawer.tsx src/ui/components/NotesRail.tsx src/ui/styles.css
git commit -m "feat(todo): 드로어·노트 레일에 참조 표시"
```

---

### Task 8: 문서 동기화 + changeset

**Files:**
- Modify: `AGENTS.md`, `FEATURES.md`, `docs/rocky-todo.md`, `skills/board/SKILL.md`
- Create: `.changeset/<random-name>.md`

- [ ] **Step 1: AGENTS.md**

`src/` 레이아웃 표에 `migrations.ts` 줄을 추가하고, 데몬/설치 모델 아래에 참조 문법을
한 단락으로 설명한다 (`rocky#12` / `#12` / raw id, 번호는 보드별이며 회수 없음).

- [ ] **Step 2: FEATURES.md**

CLI/MCP 표에서 `ID` 표기를 `REF` 로 바꾸고, 참조 문법 설명을 한 줄 넣는다.

- [ ] **Step 3: docs/rocky-todo.md**

CLI 표면 블록의 `ID` 를 `REF` 로 바꾸고, 웹 UI 절에 번호 클릭 복사 워크플로를 적는다.

- [ ] **Step 4: skills/board/SKILL.md**

"자주 쓰는 호출" 예시를 번호 기반으로 바꾼다 (`todo_status { id: "rocky#12", ... }`).
에이전트가 대화에서 `#12` 로 부르도록 한 줄 덧붙인다.

- [ ] **Step 5: changeset**

```bash
bunx changeset
```

minor 를 고르고 요약을 적는다: "todo/note 에 보드별 번호(#12) 추가 — 웹 UI 클릭 복사 포함".

- [ ] **Step 6: 최종 게이트 + 커밋**

```bash
bun run check && bun run typecheck && bun test
git add AGENTS.md FEATURES.md docs/rocky-todo.md skills/board/SKILL.md .changeset/
git commit -m "docs(todo): 번호 참조 문법 문서화"
```

---

## 완료 조건

- `bun run check` · `bun run typecheck` · `bun test` 통과
- 기존 보드(`~/.config/rocky/todo/todo.db`)가 마이그레이션 후에도 항목/히스토리를 그대로 유지
- 웹 UI 에서 번호 클릭 → `rocky#N` 복사 → 세션에 붙여넣어 조회가 동작
- 기존 랜덤 id 와 prefix 조회가 계속 동작
