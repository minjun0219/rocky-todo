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

/**
 * 마이그레이션 2: 핸드오프 큐 테이블.
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
  const columns = new Set(
    db
      .query<{ name: string }, []>('PRAGMA table_info(handoffs)')
      .all()
      .map((row) => row.name),
  );
  if (columns.has('session_id') && columns.has('status') && columns.has('created_at')) {
    db.run(
      'CREATE INDEX IF NOT EXISTS idx_handoffs_session ON handoffs(session_id, status, created_at)',
    );
  }
  if (columns.has('todo_id') && columns.has('status')) {
    db.run('CREATE INDEX IF NOT EXISTS idx_handoffs_todo ON handoffs(todo_id, status)');
  }
};

/** 적용 순서 = 배열 순서. 인덱스+1 이 곧 user_version. 기존 항목은 절대 수정하지 않는다. */
export const MIGRATIONS: Migration[] = [addNumbers, addHandoffs];

export interface RunMigrationsOptions {
  /** 테스트에서 목록을 주입한다. 기본은 MIGRATIONS. */
  migrations?: Migration[];
  /**
   * 적용 전 DB 를 복사해 둘 경로. 생략하면 `${dbPath}.bak-v<현재 user_version>` 로
   * 자동 계산한다 — 실제로 몇 버전에서 마이그레이션을 시작했는지가 파일명에 남아야
   * 여러 번 재기동을 거친 DB 의 백업 이력을 구분할 수 있다("v0" 로 고정하면 세 번째
   * 마이그레이션에서 만든 백업도 전부 v0 로 보여 오해를 부른다).
   */
  backupPath?: string;
  /**
   * 백업 원본 경로. dbPath 가 없거나(:memory: 등) 파일이 없거나, todos/notes 에 아직
   * 아무 행도 없는 신규 DB(백업할 내용이 없음)면 백업을 생략한다.
   */
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
 * WAL 을 메인 파일로 체크포인트한 뒤 파일 복사로 백업한다.
 *
 * `journal_mode = WAL` 에서는 마지막 체크포인트 이후의 커밋이 `-wal` 사이드카에만
 * 있고 메인 db 파일에는 없을 수 있다 — `copyFileSync` 로 메인 파일만 복사하면 그
 * 트랜잭션들이 통째로 빠진(심하면 스키마조차 없는) 백업이 만들어진다. 매 기동마다
 * `PRAGMA wal_checkpoint(TRUNCATE)` 로 WAL 을 메인 파일에 흡수시키고 `-wal` 을
 * 비운 뒤 복사한다 — `VACUUM INTO` 보다 저렴하고(테이블 전체 재작성이 없다), 이미
 * 열려 있는 handle 로 바로 실행할 수 있어 별도 연결이 필요 없다.
 *
 * 복사 자체가 실패하면(디스크 풀·권한) 예외를 던지지 않고 경고만 남긴 채 진행한다.
 * 백업 실패로 데몬 기동 전체가 막히면 "백업 없이 보드가 뜨는 것"보다 나쁜 결과를
 * 만든다 — 이 레포의 다른 fail-open 판단들(예: 버전 재기동 실패 시 구버전 유지)과
 * 같은 원칙이다. 정말 디스크가 가득 찼다면 뒤따르는 마이그레이션 자체(ALTER TABLE 등)도
 * 실패해 자연히 표면화된다.
 */
function backupDatabase(db: Database, dbPath: string, backupPath: string): void {
  try {
    db.run('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch {
    // 체크포인트가 실패해도 최선을 다해 복사는 시도한다 — WAL 이 반영 안 된 백업이라도
    // 백업이 아예 없는 것보다는 낫다.
  }
  try {
    copyFileSync(dbPath, backupPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `rocky-todo: pre-migration backup failed (${backupPath}) — 백업 없이 진행: ${message}`,
    );
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

  if (options.dbPath && existsSync(options.dbPath) && hasDataWorthBackingUp(db)) {
    const backupPath = options.backupPath ?? `${options.dbPath}.bak-v${current}`;
    backupDatabase(db, options.dbPath, backupPath);
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
