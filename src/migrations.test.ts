import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  function boardDb(dbPath: string): Database {
    const db = new Database(dbPath, { create: true });
    db.run('CREATE TABLE todos (id TEXT PRIMARY KEY, board_id TEXT)');
    db.run('CREATE TABLE notes (id TEXT PRIMARY KEY, board_id TEXT)');
    return db;
  }

  test('todos/notes 가 비어 있는 신규 DB 는 백업하지 않는다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rocky-todo-migrations-'));
    const dbPath = join(dir, 'todo.db');
    const backupPath = `${dbPath}.bak-v0`;
    const db = boardDb(dbPath);
    const migrations: Migration[] = [(d) => d.run('ALTER TABLE todos ADD COLUMN number INTEGER')];

    runMigrations(db, { migrations, dbPath, backupPath });

    expect(existsSync(backupPath)).toBe(false);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('todos 에 데이터가 있으면 백업한다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rocky-todo-migrations-'));
    const dbPath = join(dir, 'todo.db');
    const backupPath = `${dbPath}.bak-v0`;
    const db = boardDb(dbPath);
    db.run("INSERT INTO todos (id, board_id) VALUES ('t1', 'b1')");
    const migrations: Migration[] = [(d) => d.run('ALTER TABLE todos ADD COLUMN number INTEGER')];

    runMigrations(db, { migrations, dbPath, backupPath });

    expect(existsSync(backupPath)).toBe(true);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
