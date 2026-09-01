//! PRAGMA user_version 마이그레이션 러너 — TS 원본 `src/migrations.ts`.
//!
//! 적용 순서 = 배열 순서. 인덱스+1 이 곧 user_version. 기존 항목은 절대 수정하지 않는다.
//!
//! **규칙(SCHEMA 와의 이중 정의)**: SCHEMA(`store.rs`)는 신규 DB 를 만드는 뼈대이고 신규
//! DB 도 user_version 은 0 에서 시작한다. 어떤 컬럼을 SCHEMA 에 넣으면서 그 컬럼을 만드는
//! 마이그레이션도 배열에 있다면, 그 마이그레이션은 반드시 `PRAGMA table_info` 로 컬럼
//! 존재를 먼저 확인해야 한다 — 안 그러면 신규 DB 가 "duplicate column" 으로 기동조차
//! 못 한다.

use std::path::{Path, PathBuf};

use rusqlite::Connection;

/// 마이그레이션 하나 — 같은 트랜잭션 안에서 실행된다.
pub type MigrationFn = fn(&Connection) -> rusqlite::Result<()>;
/// 테스트 주입용 — 클로저를 받을 수 있는 동적 형태.
pub type MigrationRef<'a> = &'a (dyn Fn(&Connection) -> rusqlite::Result<()> + 'a);

fn table_columns(db: &Connection, table: &str) -> rusqlite::Result<Vec<String>> {
    let mut stmt = db.prepare(&format!("PRAGMA table_info({table})"))?;
    let names = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(names)
}

/// 마이그레이션 1: todo/note 에 보드별 순번(number)을 부여한다.
///
/// 기존 행에는 보드별로 created_at 순(동률이면 id 순 — 같은 밀리초 생성의 결정성)으로
/// 1부터 소급 부여한다.
fn add_numbers(db: &Connection) -> rusqlite::Result<()> {
    db.execute_batch(
        "ALTER TABLE todos ADD COLUMN number INTEGER;\n\
         ALTER TABLE notes ADD COLUMN number INTEGER;",
    )?;

    for table in ["todos", "notes"] {
        let rows: Vec<(String, Option<String>)> = {
            let mut stmt = db.prepare(&format!(
                "SELECT id, board_id FROM {table} ORDER BY board_id, created_at ASC, id ASC"
            ))?;
            let rows = stmt
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            rows
        };
        let mut counters: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
        let mut update = db.prepare(&format!("UPDATE {table} SET number = ?1 WHERE id = ?2"))?;
        for (id, board_id) in rows {
            let key = board_id.unwrap_or_default();
            let next = counters.get(&key).copied().unwrap_or(0) + 1;
            counters.insert(key, next);
            update.execute(rusqlite::params![next, id])?;
        }
    }

    db.execute_batch(
        "CREATE UNIQUE INDEX idx_todos_number ON todos(board_id, number);\n\
         CREATE UNIQUE INDEX idx_notes_number ON notes(board_id, number);\n\
         -- notes.board_id 는 nullable 이고 유니크 인덱스는 NULL 을 서로 다른 값으로 취급한다\n\
         -- — 글로벌 메모끼리의 유일성은 부분 인덱스로 따로 건다.\n\
         CREATE UNIQUE INDEX idx_notes_number_global ON notes(number) WHERE board_id IS NULL;",
    )
}

/// 마이그레이션 2: 보드에 GitHub 레포(`owner/name`)를 붙인다. SCHEMA 도 이 컬럼을
/// 만들므로 존재 확인 가드가 필수다.
fn add_board_repo(db: &Connection) -> rusqlite::Result<()> {
    if table_columns(db, "boards")?.iter().any(|c| c == "repo") {
        return Ok(());
    }
    db.execute_batch("ALTER TABLE boards ADD COLUMN repo TEXT")
}

/// 마이그레이션 3: 핸드오프 큐 테이블. 테이블은 `IF NOT EXISTS` 로 넘어가지만 인덱스는
/// 컬럼이 갖춰졌는지 확인한 뒤에만 만든다.
fn add_handoffs(db: &Connection) -> rusqlite::Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS handoffs (\n\
           id            TEXT PRIMARY KEY,\n\
           todo_id       TEXT NOT NULL REFERENCES todos(id),\n\
           session_id    TEXT NOT NULL,\n\
           session_name  TEXT,\n\
           session_cwd   TEXT,\n\
           note          TEXT NOT NULL DEFAULT '',\n\
           actor         TEXT NOT NULL,\n\
           status        TEXT NOT NULL CHECK (status IN ('pending','delivered','cancelled')),\n\
           created_at    TEXT NOT NULL,\n\
           delivered_at  TEXT,\n\
           delivered_via TEXT\n\
         )",
    )?;
    let columns = table_columns(db, "handoffs")?;
    let has = |name: &str| columns.iter().any(|c| c == name);
    if has("session_id") && has("status") && has("created_at") {
        db.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_handoffs_session ON handoffs(session_id, status, created_at)",
        )?;
    }
    if has("todo_id") && has("status") {
        db.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_handoffs_todo ON handoffs(todo_id, status)",
        )?;
    }
    Ok(())
}

/// 마이그레이션 4: 보드에 메인 레포 경로 — 백그라운드 세션을 띄우는 자리.
fn add_board_path(db: &Connection) -> rusqlite::Result<()> {
    if table_columns(db, "boards")?.iter().any(|c| c == "path") {
        return Ok(());
    }
    db.execute_batch("ALTER TABLE boards ADD COLUMN path TEXT")
}

/// 마이그레이션 5: 핸드오프 라이프사이클(착수/완료)과 doing 의 세션 귀속.
/// status enum 은 늘리지 않는다 — accepted/completed 는 타임스탬프로만.
fn add_handoff_lifecycle(db: &Connection) -> rusqlite::Result<()> {
    let handoff_columns = table_columns(db, "handoffs")?;
    if !handoff_columns.iter().any(|c| c == "accepted_at") {
        db.execute_batch("ALTER TABLE handoffs ADD COLUMN accepted_at TEXT")?;
    }
    if !handoff_columns.iter().any(|c| c == "completed_at") {
        db.execute_batch("ALTER TABLE handoffs ADD COLUMN completed_at TEXT")?;
    }
    if !table_columns(db, "todos")?
        .iter()
        .any(|c| c == "doing_session_id")
    {
        db.execute_batch("ALTER TABLE todos ADD COLUMN doing_session_id TEXT")?;
    }
    Ok(())
}

/// 마이그레이션 6: 보드 메타 — `description` 컬럼과 옛 key 별칭 테이블.
fn add_board_meta(db: &Connection) -> rusqlite::Result<()> {
    if !table_columns(db, "boards")?
        .iter()
        .any(|c| c == "description")
    {
        db.execute_batch("ALTER TABLE boards ADD COLUMN description TEXT")?;
    }
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS board_aliases (\n\
           key        TEXT PRIMARY KEY,\n\
           board_id   TEXT NOT NULL REFERENCES boards(id),\n\
           created_at TEXT NOT NULL\n\
         )",
    )?;
    if table_columns(db, "board_aliases")?
        .iter()
        .any(|c| c == "board_id")
    {
        db.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_board_aliases_board ON board_aliases(board_id)",
        )?;
    }
    Ok(())
}

pub const MIGRATIONS: [MigrationFn; 6] = [
    add_numbers,
    add_board_repo,
    add_handoffs,
    add_board_path,
    add_handoff_lifecycle,
    add_board_meta,
];

#[derive(Default)]
pub struct RunMigrationsOptions<'a> {
    /// 테스트에서 목록을 주입한다. 기본은 MIGRATIONS.
    pub migrations: Option<&'a [MigrationRef<'a>]>,
    /// 적용 전 DB 복사 경로. 생략하면 `${dbPath}.bak-v<현재 user_version>` 자동 계산 —
    /// 실제 시작 버전이 파일명에 남아야 여러 번 재기동을 거친 DB 의 백업 이력을 구분한다.
    pub backup_path: Option<PathBuf>,
    /// 백업 원본 경로. 없거나 todos/notes 가 비어 있으면(백업할 내용 없음) 백업 생략.
    pub db_path: Option<&'a Path>,
}

/// todos/notes 에 백업할 만한 데이터가 있는지. 판단 불가(테이블 없음 등)면 보수적으로 true.
fn has_data_worth_backing_up(db: &Connection) -> bool {
    let count = |sql: &str| -> Option<i64> { db.query_row(sql, [], |r| r.get(0)).ok() };
    match count("SELECT COUNT(*) FROM todos") {
        Some(n) if n > 0 => true,
        Some(_) => match count("SELECT COUNT(*) FROM notes") {
            Some(n) => n > 0,
            None => true,
        },
        None => true,
    }
}

/// WAL 을 메인 파일로 체크포인트한 뒤 파일 복사로 백업한다.
///
/// WAL 모드에서 메인 파일만 복사하면 마지막 체크포인트 이후 커밋이 빠진 백업이 된다.
/// 복사 실패는 경고만 남기고 진행한다(fail-open) — 백업 실패로 기동 전체가 막히면
/// "백업 없이 보드가 뜨는 것"보다 나쁘다.
fn backup_database(db: &Connection, db_path: &Path, backup_path: &Path) {
    // 체크포인트가 실패해도 최선을 다해 복사는 시도한다.
    let _ = db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)");
    if let Err(error) = std::fs::copy(db_path, backup_path) {
        eprintln!(
            "rocky-todo: pre-migration backup failed ({}) — 백업 없이 진행: {error}",
            backup_path.display()
        );
    }
}

/// user_version 보다 뒤에 있는 마이그레이션만 순서대로 적용한다.
///
/// 각 마이그레이션은 트랜잭션 안에서 실행되며, 실패하면 롤백하고 user_version 도 올리지
/// 않는다 — 다음 기동에서 재시도된다. user_version 갱신은 **같은 트랜잭션 안**에서 스키마
/// 변경과 함께 커밋된다 — COMMIT 뒤 별도로 쓰면 그 사이 프로세스가 죽었을 때 "스키마는
/// 적용, user_version 은 0" 이 남아 다음 기동에서 duplicate column 으로 영구 기동 불가.
///
/// 적용 후 최종 user_version 을 돌려준다.
pub fn run_migrations(db: &Connection, options: RunMigrationsOptions) -> rusqlite::Result<i64> {
    let default_refs: Vec<MigrationRef> = MIGRATIONS.iter().map(|f| f as MigrationRef).collect();
    let migrations: &[MigrationRef] = options.migrations.unwrap_or(&default_refs);
    let current: i64 = db.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if current >= migrations.len() as i64 {
        return Ok(current);
    }

    if let Some(db_path) = options.db_path {
        if db_path.exists() && has_data_worth_backing_up(db) {
            let backup_path = options
                .backup_path
                .unwrap_or_else(|| PathBuf::from(format!("{}.bak-v{current}", db_path.display())));
            backup_database(db, db_path, &backup_path);
        }
    }

    let mut version = current;
    for (i, migration) in migrations.iter().enumerate() {
        if (i as i64) < current {
            continue;
        }
        db.execute_batch("BEGIN")?;
        let applied = migration(db).and_then(|()| {
            version = i as i64 + 1;
            // PRAGMA 는 바인딩을 받지 않는다 — 값이 정수임은 루프 인덱스로 보장된다.
            // COMMIT 전에 실행해야 스키마 변경과 원자적으로 묶인다.
            db.execute_batch(&format!("PRAGMA user_version = {version}"))?;
            db.execute_batch("COMMIT")
        });
        if let Err(error) = applied {
            let _ = db.execute_batch("ROLLBACK");
            return Err(error);
        }
    }
    Ok(version)
}
