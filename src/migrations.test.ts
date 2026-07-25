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
