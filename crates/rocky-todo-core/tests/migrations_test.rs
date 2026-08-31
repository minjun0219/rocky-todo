//! TS 원본 `src/migrations.test.ts` 포팅.

use rocky_todo_core::migrations::{run_migrations, MigrationRef, RunMigrationsOptions, MIGRATIONS};
use rusqlite::Connection;
use std::cell::RefCell;

fn mem_db() -> Connection {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch("CREATE TABLE t (id TEXT PRIMARY KEY)")
        .unwrap();
    db
}

fn user_version(db: &Connection) -> i64 {
    db.query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap()
}

fn has_column(db: &Connection, table: &str, name: &str) -> bool {
    let mut stmt = db.prepare(&format!("PRAGMA table_info({table})")).unwrap();
    let cols: Vec<String> = stmt
        .query_map([], |r| r.get::<_, String>(1))
        .unwrap()
        .map(|r| r.unwrap())
        .collect();
    cols.iter().any(|c| c == name)
}

fn has_table(db: &Connection, name: &str) -> bool {
    db.query_row(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?1",
        [name],
        |r| r.get::<_, String>(0),
    )
    .is_ok()
}

#[test]
fn user_version_0_applies_all_in_order() {
    let db = mem_db();
    let applied = RefCell::new(Vec::<i32>::new());
    let m1 = |d: &Connection| {
        applied.borrow_mut().push(1);
        d.execute_batch("ALTER TABLE t ADD COLUMN a INTEGER")
    };
    let m2 = |d: &Connection| {
        applied.borrow_mut().push(2);
        d.execute_batch("ALTER TABLE t ADD COLUMN b INTEGER")
    };
    let migrations: Vec<MigrationRef> = vec![&m1, &m2];
    let version = run_migrations(
        &db,
        RunMigrationsOptions {
            migrations: Some(&migrations),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(version, 2);
    assert_eq!(*applied.borrow(), vec![1, 2]);
}

#[test]
fn rerun_is_idempotent() {
    let db = mem_db();
    let applied = RefCell::new(Vec::<i32>::new());
    let m1 = |d: &Connection| {
        applied.borrow_mut().push(1);
        d.execute_batch("ALTER TABLE t ADD COLUMN a INTEGER")
    };
    let migrations: Vec<MigrationRef> = vec![&m1];
    run_migrations(
        &db,
        RunMigrationsOptions {
            migrations: Some(&migrations),
            ..Default::default()
        },
    )
    .unwrap();
    run_migrations(
        &db,
        RunMigrationsOptions {
            migrations: Some(&migrations),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(*applied.borrow(), vec![1]);
}

#[test]
fn throwing_migration_rolls_back_without_bumping_version() {
    let db = mem_db();
    let m1 = |d: &Connection| -> rusqlite::Result<()> {
        d.execute_batch("ALTER TABLE t ADD COLUMN a INTEGER")?;
        // 실패 시뮬레이션 — 유효하지 않은 SQL 로 에러를 만든다.
        d.execute_batch("THIS IS NOT SQL")
    };
    let migrations: Vec<MigrationRef> = vec![&m1];
    let result = run_migrations(
        &db,
        RunMigrationsOptions {
            migrations: Some(&migrations),
            ..Default::default()
        },
    );
    assert!(result.is_err());
    assert_eq!(user_version(&db), 0);
    assert!(!has_column(&db, "t", "a"));
}

/// 원자성 회귀 — TS 는 db.run 스파이로 "PRAGMA user_version 이 COMMIT 이전" 실행 순서를
/// 관찰했지만 Rust 러너는 내부 호출을 가로챌 수 없다. 순서 자체는 코드 구조(같은
/// and_then 체인에서 PRAGMA → COMMIT)로 고정돼 있고, 여기서는 최종 상태의 원자성만
/// 검증한다 — 스키마 변경과 버전 중 하나만 반영되는 중간 상태가 없어야 한다.
#[test]
fn version_update_commits_atomically_with_schema() {
    let db = mem_db();
    let m1 = |d: &Connection| d.execute_batch("ALTER TABLE t ADD COLUMN a INTEGER");
    let migrations: Vec<MigrationRef> = vec![&m1];
    let version = run_migrations(
        &db,
        RunMigrationsOptions {
            migrations: Some(&migrations),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(version, 1);
    assert_eq!(user_version(&db), 1);
    assert!(has_column(&db, "t", "a"));
}

// ── 백업 ────────────────────────────────────────────────────────────────────

fn board_db(db_path: &std::path::Path, wal_mode: bool) -> Connection {
    let db = Connection::open(db_path).unwrap();
    if wal_mode {
        db.pragma_update(None, "journal_mode", "WAL").unwrap();
    }
    db.execute_batch(
        "CREATE TABLE todos (id TEXT PRIMARY KEY, board_id TEXT);\n\
         CREATE TABLE notes (id TEXT PRIMARY KEY, board_id TEXT);",
    )
    .unwrap();
    db
}

fn count_rows(db_path: &std::path::Path, table: &str) -> i64 {
    let db = Connection::open(db_path).unwrap();
    db.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
        .unwrap()
}

#[test]
fn empty_new_db_is_not_backed_up() {
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("todo.db");
    let backup_path = dir.path().join("todo.db.bak-v0");
    let db = board_db(&db_path, false);
    let m1 = |d: &Connection| d.execute_batch("ALTER TABLE todos ADD COLUMN number INTEGER");
    let migrations: Vec<MigrationRef> = vec![&m1];

    run_migrations(
        &db,
        RunMigrationsOptions {
            migrations: Some(&migrations),
            db_path: Some(&db_path),
            ..Default::default()
        },
    )
    .unwrap();

    assert!(!backup_path.exists());
}

#[test]
fn db_with_data_is_backed_up_and_backup_is_readable() {
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("todo.db");
    let backup_path = dir.path().join("todo.db.bak-v0");
    let db = board_db(&db_path, false);
    db.execute_batch(
        "INSERT INTO todos (id, board_id) VALUES ('t1', 'b1');\n\
         INSERT INTO todos (id, board_id) VALUES ('t2', 'b1');",
    )
    .unwrap();
    let m1 = |d: &Connection| d.execute_batch("ALTER TABLE todos ADD COLUMN number INTEGER");
    let migrations: Vec<MigrationRef> = vec![&m1];

    run_migrations(
        &db,
        RunMigrationsOptions {
            migrations: Some(&migrations),
            db_path: Some(&db_path),
            ..Default::default()
        },
    )
    .unwrap();

    assert!(backup_path.exists());
    // 존재만으로는 빈 헤더 파일도 통과한다 — 실제 행을 SELECT 해서 확인한다.
    assert_eq!(count_rows(&backup_path, "todos"), 2);
}

#[test]
fn wal_db_backup_includes_wal_only_commits() {
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("todo.db");
    let backup_path = dir.path().join("todo.db.bak-v0");
    let db = board_db(&db_path, true);
    let row_count = 50;
    for i in 0..row_count {
        db.execute(
            "INSERT INTO todos (id, board_id) VALUES (?1, 'b1')",
            [format!("t{i}")],
        )
        .unwrap();
    }
    let m1 = |d: &Connection| d.execute_batch("ALTER TABLE todos ADD COLUMN number INTEGER");
    let migrations: Vec<MigrationRef> = vec![&m1];

    run_migrations(
        &db,
        RunMigrationsOptions {
            migrations: Some(&migrations),
            db_path: Some(&db_path),
            ..Default::default()
        },
    )
    .unwrap();

    assert!(backup_path.exists());
    assert_eq!(count_rows(&backup_path, "todos"), row_count);
}

#[test]
fn backup_filename_reflects_actual_start_version() {
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("todo.db");
    let db = board_db(&db_path, false);
    db.execute_batch("INSERT INTO todos (id, board_id) VALUES ('t1', 'b1')")
        .unwrap();
    let step1 = |d: &Connection| d.execute_batch("ALTER TABLE todos ADD COLUMN number INTEGER");
    let step2 = |d: &Connection| d.execute_batch("ALTER TABLE todos ADD COLUMN extra INTEGER");

    let first: Vec<MigrationRef> = vec![&step1];
    run_migrations(
        &db,
        RunMigrationsOptions {
            migrations: Some(&first),
            db_path: Some(&db_path),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(dir.path().join("todo.db.bak-v0").exists());

    // 두 번째 라운드는 user_version=1 에서 시작 — 백업 파일명도 v1 이어야 한다.
    let both: Vec<MigrationRef> = vec![&step1, &step2];
    run_migrations(
        &db,
        RunMigrationsOptions {
            migrations: Some(&both),
            db_path: Some(&db_path),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(dir.path().join("todo.db.bak-v1").exists());
}

#[test]
fn failed_backup_copy_does_not_block_migration() {
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("todo.db");
    let db = board_db(&db_path, false);
    db.execute_batch("INSERT INTO todos (id, board_id) VALUES ('t1', 'b1')")
        .unwrap();
    let m1 = |d: &Connection| d.execute_batch("ALTER TABLE todos ADD COLUMN number INTEGER");
    let migrations: Vec<MigrationRef> = vec![&m1];
    // 존재하지 않는 디렉터리를 백업 대상으로 — 복사가 ENOENT 로 실패한다.
    let bad_backup = dir.path().join("no-such-dir").join("todo.db.bak");

    run_migrations(
        &db,
        RunMigrationsOptions {
            migrations: Some(&migrations),
            db_path: Some(&db_path),
            backup_path: Some(bad_backup),
        },
    )
    .unwrap();

    assert!(has_column(&db, "todos", "number"));
    assert_eq!(user_version(&db), 1);
}

// ── 실 마이그레이션 ─────────────────────────────────────────────────────────

#[test]
fn add_board_repo_adds_column_and_preserves_rows() {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch(
        "CREATE TABLE boards (id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, title TEXT NOT NULL, created_at TEXT NOT NULL, archived_at TEXT);\n\
         CREATE TABLE todos (id TEXT PRIMARY KEY, board_id TEXT, created_at TEXT);\n\
         CREATE TABLE notes (id TEXT PRIMARY KEY, board_id TEXT, created_at TEXT);\n\
         INSERT INTO boards (id, key, title, created_at) VALUES ('b1', 'rocky', 'rocky', '2026-07-01T00:00:00.000Z');\n\
         PRAGMA user_version = 1;",
    )
    .unwrap();

    run_migrations(&db, RunMigrationsOptions::default()).unwrap();

    let (key, repo): (String, Option<String>) = db
        .query_row("SELECT key, repo FROM boards", [], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .unwrap();
    assert_eq!(key, "rocky");
    assert_eq!(repo, None);
}

#[test]
fn migration3_creates_handoffs_on_existing_db() {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch(
        "CREATE TABLE todos (id TEXT PRIMARY KEY, board_id TEXT, created_at TEXT);\n\
         CREATE TABLE notes (id TEXT PRIMARY KEY, board_id TEXT, created_at TEXT);\n\
         CREATE TABLE boards (id TEXT PRIMARY KEY, key TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL);\n\
         PRAGMA user_version = 1;",
    )
    .unwrap();

    let version = run_migrations(&db, RunMigrationsOptions::default()).unwrap();
    assert_eq!(version, MIGRATIONS.len() as i64);
    assert!(has_table(&db, "handoffs"));
}

#[test]
fn migration3_tolerates_preexisting_handoffs_table() {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch(
        "CREATE TABLE todos (id TEXT PRIMARY KEY, board_id TEXT, created_at TEXT);\n\
         CREATE TABLE notes (id TEXT PRIMARY KEY, board_id TEXT, created_at TEXT);\n\
         CREATE TABLE handoffs (id TEXT PRIMARY KEY);\n\
         CREATE TABLE boards (id TEXT PRIMARY KEY, key TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL);\n\
         PRAGMA user_version = 1;",
    )
    .unwrap();
    run_migrations(&db, RunMigrationsOptions::default()).unwrap();
}

#[test]
fn migration4_adds_boards_path() {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch(
        "CREATE TABLE boards (id TEXT PRIMARY KEY, key TEXT, title TEXT, created_at TEXT);\n\
         CREATE TABLE todos (id TEXT PRIMARY KEY, board_id TEXT, created_at TEXT);\n\
         CREATE TABLE notes (id TEXT PRIMARY KEY, board_id TEXT, created_at TEXT);",
    )
    .unwrap();
    run_migrations(&db, RunMigrationsOptions::default()).unwrap();
    assert!(has_column(&db, "boards", "path"));
    assert_eq!(user_version(&db), MIGRATIONS.len() as i64);
}

#[test]
fn migration4_tolerates_preexisting_path() {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch(
        "CREATE TABLE boards (id TEXT PRIMARY KEY, key TEXT, title TEXT, repo TEXT, path TEXT, created_at TEXT);\n\
         CREATE TABLE todos (id TEXT PRIMARY KEY, board_id TEXT, created_at TEXT);\n\
         CREATE TABLE notes (id TEXT PRIMARY KEY, board_id TEXT, created_at TEXT);",
    )
    .unwrap();
    run_migrations(&db, RunMigrationsOptions::default()).unwrap();
}

#[test]
fn migration5_adds_lifecycle_columns() {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch(
        "CREATE TABLE boards (id TEXT PRIMARY KEY, key TEXT, title TEXT, created_at TEXT);\n\
         CREATE TABLE todos (id TEXT PRIMARY KEY, board_id TEXT, created_at TEXT);\n\
         CREATE TABLE notes (id TEXT PRIMARY KEY, board_id TEXT, created_at TEXT);",
    )
    .unwrap();
    run_migrations(&db, RunMigrationsOptions::default()).unwrap();
    assert!(has_column(&db, "handoffs", "accepted_at"));
    assert!(has_column(&db, "handoffs", "completed_at"));
    assert!(has_column(&db, "todos", "doing_session_id"));
}

#[test]
fn migration5_tolerates_preexisting_columns() {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch(
        "CREATE TABLE boards (id TEXT PRIMARY KEY, key TEXT, title TEXT, created_at TEXT);\n\
         CREATE TABLE todos (id TEXT PRIMARY KEY, board_id TEXT, created_at TEXT, doing_session_id TEXT);\n\
         CREATE TABLE notes (id TEXT PRIMARY KEY, board_id TEXT, created_at TEXT);\n\
         CREATE TABLE handoffs (id TEXT PRIMARY KEY, todo_id TEXT, session_id TEXT, status TEXT, created_at TEXT, accepted_at TEXT, completed_at TEXT);",
    )
    .unwrap();
    run_migrations(&db, RunMigrationsOptions::default()).unwrap();
}

#[test]
fn migration6_adds_description_and_alias_table() {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch(
        "CREATE TABLE boards (id TEXT PRIMARY KEY, key TEXT, title TEXT, created_at TEXT);\n\
         CREATE TABLE todos (id TEXT PRIMARY KEY, board_id TEXT, created_at TEXT);\n\
         CREATE TABLE notes (id TEXT PRIMARY KEY, board_id TEXT, created_at TEXT);\n\
         INSERT INTO boards (id, key, title, created_at) VALUES ('b1', 'rocky', 'rocky', '2026-07-01T00:00:00.000Z');",
    )
    .unwrap();
    run_migrations(&db, RunMigrationsOptions::default()).unwrap();
    let (key, description): (String, Option<String>) = db
        .query_row("SELECT key, description FROM boards", [], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .unwrap();
    assert_eq!(key, "rocky");
    assert_eq!(description, None);
    assert!(has_table(&db, "board_aliases"));
}

#[test]
fn migration6_tolerates_preexisting_column_and_table() {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch(
        "CREATE TABLE boards (id TEXT PRIMARY KEY, key TEXT, title TEXT, description TEXT, created_at TEXT);\n\
         CREATE TABLE todos (id TEXT PRIMARY KEY, board_id TEXT, created_at TEXT);\n\
         CREATE TABLE notes (id TEXT PRIMARY KEY, board_id TEXT, created_at TEXT);\n\
         CREATE TABLE board_aliases (key TEXT PRIMARY KEY, board_id TEXT, created_at TEXT);",
    )
    .unwrap();
    run_migrations(&db, RunMigrationsOptions::default()).unwrap();
}
