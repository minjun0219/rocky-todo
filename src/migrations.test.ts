import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addBoardRepo, type Migration, runMigrations } from './migrations';

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

  test('user_version 갱신은 스키마 변경과 같은 트랜잭션에서 COMMIT 전에 커밋된다 (원자성 회귀)', () => {
    const db = memDb();
    const calls: string[] = [];
    const originalRun = db.run.bind(db);
    // bun:sqlite Database.run 을 감싸 실행 순서를 관찰하는 테스트 전용 스파이.
    (db as any).run = (sql: string, ...args: any[]) => {
      calls.push(sql);
      return originalRun(sql, ...args);
    };
    const migrations: Migration[] = [(d) => d.run('ALTER TABLE t ADD COLUMN a INTEGER')];

    expect(runMigrations(db, { migrations })).toBe(1);

    const commitIndex = calls.indexOf('COMMIT');
    const versionIndex = calls.findIndex((sql) => sql.startsWith('PRAGMA user_version ='));
    expect(commitIndex).toBeGreaterThan(-1);
    // PRAGMA user_version 갱신은 COMMIT 이전(같은 트랜잭션 안)에서 실행돼야 한다 — COMMIT
    // 뒤에서 실행하면 그 사이 프로세스가 죽었을 때 스키마는 적용됐는데 user_version 은 0인
    // 상태가 남는다.
    expect(versionIndex).toBeGreaterThan(-1);
    expect(versionIndex).toBeLessThan(commitIndex);

    // 그리고 둘 다 커밋된 최종 상태에서 함께 보인다 — 스키마 변경과 버전 중 하나만
    // 반영되는 중간 상태가 없다.
    const version = db.query<{ user_version: number }, []>('PRAGMA user_version').get();
    expect(version?.user_version).toBe(1);
    const cols = db.query<{ name: string }, []>('PRAGMA table_info(t)').all();
    expect(cols.some((c) => c.name === 'a')).toBe(true);
    db.close();
  });
});

describe('runMigrations backup', () => {
  function boardDb(dbPath: string, walMode = false): Database {
    const db = new Database(dbPath, { create: true });
    if (walMode) {
      db.run('PRAGMA journal_mode = WAL');
    }
    db.run('CREATE TABLE todos (id TEXT PRIMARY KEY, board_id TEXT)');
    db.run('CREATE TABLE notes (id TEXT PRIMARY KEY, board_id TEXT)');
    return db;
  }

  function countRows(dbPath: string, table: 'todos' | 'notes'): number {
    // readonly 로 열면 원본이 WAL 모드일 때 SQLite 가 읽기 전용 연결에도 -shm 접근을
    // 요구해 "unable to open database file" 로 실패한다 — 백업본은 임시 파일이라
    // 일반 모드로 열어도 안전하다.
    const backupDb = new Database(dbPath);
    try {
      return backupDb.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? 0;
    } finally {
      backupDb.close();
    }
  }

  test('todos/notes 가 비어 있는 신규 DB 는 백업하지 않는다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rocky-todo-migrations-'));
    const dbPath = join(dir, 'todo.db');
    const backupPath = `${dbPath}.bak-v0`;
    const db = boardDb(dbPath);
    const migrations: Migration[] = [(d) => d.run('ALTER TABLE todos ADD COLUMN number INTEGER')];

    runMigrations(db, { migrations, dbPath });

    expect(existsSync(backupPath)).toBe(false);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('todos 에 데이터가 있으면 백업하고, 백업본에서 실제 행을 읽을 수 있다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rocky-todo-migrations-'));
    const dbPath = join(dir, 'todo.db');
    const backupPath = `${dbPath}.bak-v0`;
    const db = boardDb(dbPath);
    db.run("INSERT INTO todos (id, board_id) VALUES ('t1', 'b1')");
    db.run("INSERT INTO todos (id, board_id) VALUES ('t2', 'b1')");
    const migrations: Migration[] = [(d) => d.run('ALTER TABLE todos ADD COLUMN number INTEGER')];

    runMigrations(db, { migrations, dbPath });

    expect(existsSync(backupPath)).toBe(true);
    // existsSync 만으로는 4096바이트짜리 빈 헤더만 있는 파일도 통과한다 — 실제로
    // 내용을 SELECT 해서 행이 다 있는지까지 확인해야 finding 2 가 잡혔다고 할 수 있다.
    expect(countRows(backupPath, 'todos')).toBe(2);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('WAL 모드 DB 를 백업하면 체크포인트되어 -wal 에만 있던 커밋까지 복사본에 담긴다', () => {
    // journal_mode=WAL 에서는 체크포인트 전까지 최근 커밋이 -wal 사이드카에만 있고
    // 메인 db 파일에는 없다 — 체크포인트 없이 copyFileSync 만 하면 이 테스트가
    // 재현하는 정확히 그 상황(백업에 최근 행이 빠짐)이 발생한다. 별도 프로세스로
    // SIGKILL 을 시뮬레이션하지 않아도 단일 연결·체크포인트 임계치 미만의 삽입만으로
    // 재현 가능하다 — WAL 은 기본적으로 자동 체크포인트 임계치(약 1000 페이지)에
    // 도달하기 전까지 메인 파일에 반영하지 않는다.
    const dir = mkdtempSync(join(tmpdir(), 'rocky-todo-migrations-wal-'));
    const dbPath = join(dir, 'todo.db');
    const backupPath = `${dbPath}.bak-v0`;
    const db = boardDb(dbPath, true);
    const rowCount = 50;
    for (let i = 0; i < rowCount; i++) {
      db.run('INSERT INTO todos (id, board_id) VALUES (?, ?)', [`t${i}`, 'b1']);
    }
    const migrations: Migration[] = [(d) => d.run('ALTER TABLE todos ADD COLUMN number INTEGER')];

    runMigrations(db, { migrations, dbPath });

    expect(existsSync(backupPath)).toBe(true);
    expect(countRows(backupPath, 'todos')).toBe(rowCount);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('백업 파일명은 실제 마이그레이션 시작 버전을 반영한다 (v0 로 고정되지 않는다)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rocky-todo-migrations-version-'));
    const dbPath = join(dir, 'todo.db');
    const db = boardDb(dbPath);
    db.run("INSERT INTO todos (id, board_id) VALUES ('t1', 'b1')");
    const step1: Migration = (d) => d.run('ALTER TABLE todos ADD COLUMN number INTEGER');
    const step2: Migration = (d) => d.run('ALTER TABLE todos ADD COLUMN extra INTEGER');

    runMigrations(db, { migrations: [step1], dbPath });
    expect(existsSync(`${dbPath}.bak-v0`)).toBe(true);

    // 두 번째 마이그레이션은 user_version=1 에서 시작한다 — 백업 파일명도 v1 이어야
    // 한다. 이전엔 store.ts 가 항상 리터럴 `.bak-v0` 를 넘겨서 이 라운드의 백업이
    // 첫 번째 백업을 그대로 덮어썼다(내용은 다른데 파일명이 같아서).
    runMigrations(db, { migrations: [step1, step2], dbPath });
    expect(existsSync(`${dbPath}.bak-v1`)).toBe(true);

    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('백업 복사가 실패해도(디스크 풀/권한 시뮬레이션) 마이그레이션은 계속 진행한다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rocky-todo-migrations-badbackup-'));
    const dbPath = join(dir, 'todo.db');
    const db = boardDb(dbPath);
    db.run("INSERT INTO todos (id, board_id) VALUES ('t1', 'b1')");
    const migrations: Migration[] = [(d) => d.run('ALTER TABLE todos ADD COLUMN number INTEGER')];
    // 존재하지 않는 디렉터리를 백업 대상으로 줘서 copyFileSync 가 ENOENT 로 던지게 한다.
    const badBackupPath = join(dir, 'no-such-dir', 'todo.db.bak');
    const originalError = console.error;
    console.error = () => {}; // 경고 로그가 테스트 출력을 어지럽히지 않게 억제

    try {
      expect(() =>
        runMigrations(db, { migrations, dbPath, backupPath: badBackupPath }),
      ).not.toThrow();
    } finally {
      console.error = originalError;
    }

    const cols = db.query<{ name: string }, []>('PRAGMA table_info(todos)').all();
    expect(cols.some((c) => c.name === 'number')).toBe(true);
    const version = db.query<{ user_version: number }, []>('PRAGMA user_version').get();
    expect(version?.user_version).toBe(1);

    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('addBoardRepo migration', () => {
  test('adds the column and preserves existing rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rocky-todo-mig-repo-'));
    const dbPath = join(dir, 'todo.db');
    const db = new Database(dbPath, { create: true });
    db.run(`CREATE TABLE boards (
      id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
      created_at TEXT NOT NULL, archived_at TEXT
    )`);
    db.run(
      "INSERT INTO boards (id, key, title, created_at) VALUES ('b1', 'rocky', 'rocky', '2026-07-01T00:00:00.000Z')",
    );

    runMigrations(db, { migrations: [addBoardRepo] });

    const row = db
      .query<{ key: string; repo: string | null }, []>('SELECT key, repo FROM boards')
      .get();
    expect(row?.key).toBe('rocky');
    expect(row?.repo).toBeNull();

    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
