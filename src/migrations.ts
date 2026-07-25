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
  /** 적용 전 DB 를 복사해 둘 경로. 메모리 DB 나 신규 DB 면 생략한다. */
  backupPath?: string;
  /** 백업 원본 경로. backupPath 와 함께 줄 때만 백업한다. */
  dbPath?: string;
}

/**
 * user_version 보다 뒤에 있는 마이그레이션만 순서대로 적용한다.
 *
 * 각 마이그레이션은 트랜잭션 안에서 실행되며, 던지면 롤백하고 user_version 도 올리지
 * 않는다 — 실패한 마이그레이션은 다음 기동에서 다시 시도된다.
 * @returns 적용 후 최종 user_version.
 */
export function runMigrations(db: Database, options: RunMigrationsOptions = {}): number {
  const migrations = options.migrations ?? MIGRATIONS;
  const current =
    db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version ?? 0;
  if (current >= migrations.length) {
    return current;
  }

  if (options.backupPath && options.dbPath && existsSync(options.dbPath)) {
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
      db.run('COMMIT');
    } catch (error) {
      db.run('ROLLBACK');
      throw error;
    }
    version = i + 1;
    // PRAGMA 는 바인딩을 받지 않는다 — 값이 정수임은 루프 인덱스로 보장된다.
    db.run(`PRAGMA user_version = ${version}`);
  }
  return version;
}
