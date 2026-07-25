import { Database } from 'bun:sqlite';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { runMigrations } from './migrations';

/**
 * rocky-todo 의 저장 계층 — SQLite (bun:sqlite) 단일 파일.
 *
 * 원칙:
 * - 삭제 API 없음 — 모든 엔티티는 `archivedAt` 아카이브만 존재한다.
 * - 모든 mutation 은 같은 트랜잭션 안에서 `history` 감사 로그를 자동 기록한다.
 * - mutation 마다 change 이벤트를 발행해 SSE 허브(웹 UI 실시간 갱신)가 구독한다.
 * - 데몬이 단일 writer 라 동시성 제어는 단순 (WAL 은 안전벨트).
 */

export type TodoStatus = 'todo' | 'doing' | 'done';
export type TodoPriority = 'p1' | 'p2' | 'p3' | 'p4';
export type StatusAction = 'start' | 'stop' | 'done' | 'reopen' | 'archive' | 'unarchive';
export type HistoryEntity = 'board' | 'section' | 'todo' | 'note';

export interface TodoLink {
  url: string;
  title?: string;
}

export interface Board {
  id: string;
  key: string;
  title: string;
  createdAt: string;
  archivedAt?: string;
}

export interface Section {
  id: string;
  boardId: string;
  title: string;
  position: number;
  archivedAt?: string;
}

export interface Todo {
  id: string;
  /** 보드별 순번 — 사람이 읽고 부르는 참조(#12). id 와 달리 보드 안에서만 유일하다. */
  number: number;
  boardId: string;
  sectionId?: string;
  parentId?: string;
  title: string;
  description: string;
  status: TodoStatus;
  priority: TodoPriority;
  due?: string;
  labels: string[];
  links: TodoLink[];
  doingBy?: string;
  doingSince?: string;
  position: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  archivedAt?: string;
}

export interface Note {
  id: string;
  /** 보드별 순번 — 사람이 읽고 부르는 참조(#12). id 와 달리 보드 안에서만 유일하다. */
  number: number;
  boardId?: string;
  title: string;
  content: string;
  position: number;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export interface HistoryEntry {
  id: number;
  entity: HistoryEntity;
  entityId: string;
  actor: string;
  action: string;
  changes?: Record<string, [unknown, unknown]>;
  at: string;
}

export interface ChangeEvent {
  entity: HistoryEntity;
  entityId: string;
  action: string;
  boardId?: string;
}

/** 변경 피드 항목 — 히스토리 + 사람이 읽을 제목/보드 키. */
export interface ChangeFeedEntry extends HistoryEntry {
  title: string;
  boardKey?: string;
}

export interface CreateTodoInput {
  board: string;
  title: string;
  description?: string;
  section?: string;
  parentId?: string;
  priority?: TodoPriority;
  due?: string;
  labels?: string[];
  links?: TodoLink[];
}

export interface UpdateTodoPatch {
  title?: string;
  description?: string;
  section?: string;
  parentId?: string | null;
  priority?: TodoPriority;
  due?: string | null;
  labels?: string[];
  links?: TodoLink[];
}

export interface CreateNoteInput {
  board?: string;
  title: string;
  content?: string;
}

export interface UpdateNotePatch {
  title?: string;
  content?: string;
  /** `append` 는 기존 content 뒤에 개행으로 이어 붙인다 (기본 `set`). */
  mode?: 'set' | 'append';
}

export interface ListTodosFilter {
  board?: string;
  status?: TodoStatus;
  label?: string;
  includeArchived?: boolean;
}

export interface ListNotesFilter {
  board?: string;
  /** true 면 보드 미소속(글로벌) 메모만. */
  global?: boolean;
  includeArchived?: boolean;
}

export interface ListHistoryFilter {
  entityId?: string;
  entity?: HistoryEntity;
  limit?: number;
}

export interface TodoStoreOptions {
  dbPath: string;
}

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

function nowIso(): string {
  return new Date().toISOString();
}

interface TodoRow {
  id: string;
  number: number;
  board_id: string;
  section_id: string | null;
  parent_id: string | null;
  title: string;
  description: string;
  status: TodoStatus;
  priority: TodoPriority;
  due: string | null;
  labels: string;
  links: string;
  doing_by: string | null;
  doing_since: string | null;
  position: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  archived_at: string | null;
}

interface NoteRow {
  id: string;
  number: number;
  board_id: string | null;
  title: string;
  content: string;
  position: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

interface BoardRow {
  id: string;
  key: string;
  title: string;
  created_at: string;
  archived_at: string | null;
}

interface SectionRow {
  id: string;
  board_id: string;
  title: string;
  position: number;
  archived_at: string | null;
}

interface HistoryRow {
  id: number;
  entity: HistoryEntity;
  entity_id: string;
  actor: string;
  action: string;
  changes: string | null;
  at: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS boards (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  archived_at TEXT
);
CREATE TABLE IF NOT EXISTS sections (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards(id),
  title TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT
);
CREATE TABLE IF NOT EXISTS todos (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards(id),
  section_id TEXT REFERENCES sections(id),
  parent_id TEXT REFERENCES todos(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','doing','done')),
  priority TEXT NOT NULL DEFAULT 'p4' CHECK (priority IN ('p1','p2','p3','p4')),
  due TEXT,
  labels TEXT NOT NULL DEFAULT '[]',
  links TEXT NOT NULL DEFAULT '[]',
  doing_by TEXT,
  doing_since TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  archived_at TEXT
);
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  board_id TEXT REFERENCES boards(id),
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);
CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity TEXT NOT NULL CHECK (entity IN ('board','section','todo','note')),
  entity_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  changes TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_todos_board ON todos(board_id);
CREATE INDEX IF NOT EXISTS idx_notes_board ON notes(board_id);
CREATE INDEX IF NOT EXISTS idx_history_entity ON history(entity_id);
`;

/** rocky-todo 스토어 — 데몬 프로세스 안에서 단일 인스턴스로 쓰인다. */
export class TodoStore {
  private readonly db: Database;
  private readonly listeners = new Set<(event: ChangeEvent) => void>();

  constructor(options: TodoStoreOptions) {
    mkdirSync(dirname(options.dbPath), { recursive: true });
    this.db = new Database(options.dbPath, { create: true });
    this.db.run('PRAGMA journal_mode = WAL');
    this.db.run('PRAGMA foreign_keys = ON');
    this.db.run(SCHEMA);
    // backupPath 는 지정하지 않는다 — runMigrations 가 실제 시작 버전으로
    // `${dbPath}.bak-v<version>` 을 스스로 계산한다 (하드코딩된 v0 방지).
    runMigrations(this.db, { dbPath: options.dbPath });
  }

  close(): void {
    this.db.close();
  }

  /** mutation 이벤트 구독 — SSE 허브가 쓴다. 반환값을 호출하면 구독 해제. */
  subscribe(listener: (event: ChangeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: ChangeEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private recordHistory(
    entity: HistoryEntity,
    entityId: string,
    actor: string,
    action: string,
    changes?: Record<string, [unknown, unknown]>,
    boardId?: string,
  ): void {
    this.db
      .query(
        'INSERT INTO history (entity, entity_id, actor, action, changes, at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(entity, entityId, actor, action, changes ? JSON.stringify(changes) : null, nowIso());
    this.emit({ entity, entityId, action, boardId });
  }

  // ── boards ────────────────────────────────────────────────────────────────

  /**
   * board key 를 만든다. `resolveRef` 의 스코프 ref 정규식(`^([^#\s]+)#(\d+)$`)이
   * key 부분에서 공백과 `#` 를 허용하지 않으므로, 그 두 문자(부류)가 섞인 key 를
   * 저장하면 `refOf` 가 만든 `<key>#<number>` 를 서버 스스로 못 읽는 모순이 생긴다
   * (예: `my repo#1` → scoped 정규식 불일치 → `resolveRef` 가 undefined; `a#b#1` 도
   * 동일). `sanitizeKey`(`src/actor.ts`)가 유추하는 key 는 이미 안전하지만, board 는
   * REST(`POST /api/boards`)·MCP(`todo_write`/`note_write` 의 `board`)로 직접
   * 들어오기도 해 여기서 한 번 더 막는다. 조용히 정규화(공백→`-` 치환 등)하지 않는다
   * — `my repo` 를 요청했는데 다른 이름의 보드가 말없이 만들어지면 더 혼란스럽다.
   *
   * 검증은 새 보드를 CREATE 할 때만 적용한다 — 먼저 기존 row 를 조회하고, 있으면 모양과
   * 무관하게 그대로 돌려준다. 이 validation 이 들어오기 전 구버전 데몬이 `my repo` 같은
   * key 로 보드를 이미 만들어놨을 수 있고(직접 `POST /api/boards` 또는 MCP `board` 인자로
   * 도달 가능), 업그레이드 후 그 보드에 todo/note 를 하나 추가하기만 해도 여기서 하드
   * 실패하면 안 된다 — 보드와 기존 항목은 멀쩡한데. 새 malformed 보드가 생기는 것만 막는다.
   * @throws key 가 비어 있거나 공백/`#` 를 포함하는 **새** 보드를 만들려 하면 — 어느 문자가
   * 문제인지 명시한다. 이미 존재하는 보드는 이 검증을 건너뛴다.
   */
  ensureBoard(key: string, options: { title?: string; actor: string }): Board {
    const existing = this.db
      .query<BoardRow, [string]>('SELECT * FROM boards WHERE key = ?')
      .get(key);
    if (existing) {
      return toBoard(existing);
    }
    if (key === '') {
      throw new Error('board key must not be empty');
    }
    if (/\s/.test(key)) {
      throw new Error(`board key must not contain whitespace: ${JSON.stringify(key)}`);
    }
    if (key.includes('#')) {
      throw new Error(`board key must not contain '#': ${JSON.stringify(key)}`);
    }
    const board: Board = {
      id: newId(),
      key,
      title: options.title ?? key,
      createdAt: nowIso(),
    };
    this.db
      .query('INSERT INTO boards (id, key, title, created_at) VALUES (?, ?, ?, ?)')
      .run(board.id, board.key, board.title, board.createdAt);
    this.recordHistory('board', board.id, options.actor, 'create', undefined, board.id);
    return board;
  }

  listBoards(includeArchived = false): Board[] {
    const rows = includeArchived
      ? this.db.query<BoardRow, []>('SELECT * FROM boards ORDER BY key').all()
      : this.db
          .query<BoardRow, []>('SELECT * FROM boards WHERE archived_at IS NULL ORDER BY key')
          .all();
    return rows.map(toBoard);
  }

  private boardByKey(key: string): Board | undefined {
    const row = this.db.query<BoardRow, [string]>('SELECT * FROM boards WHERE key = ?').get(key);
    return row ? toBoard(row) : undefined;
  }

  /**
   * 보드 key → boardId. 아카이브된 보드도 포함해서 찾는다(참조 해석/조회 목적이라
   * 아카이브 여부로 실패시키지 않는다). 없는 key 면 undefined — 존재하지 않는 보드를
   * 지어내지 않고, 호출자가 "보드 컨텍스트 없음"으로 취급하게 한다.
   */
  boardIdOf(key: string): string | undefined {
    return this.boardByKey(key)?.id;
  }

  // ── sections ──────────────────────────────────────────────────────────────

  /** 보드 안에서 섹션을 이름으로 upsert 한다 — todo_write 의 section 인자가 쓰는 경로. */
  ensureSection(boardId: string, title: string, actor: string): Section {
    const existing = this.db
      .query<SectionRow, [string, string]>(
        'SELECT * FROM sections WHERE board_id = ? AND title = ? AND archived_at IS NULL',
      )
      .get(boardId, title);
    if (existing) {
      return toSection(existing);
    }
    const position = this.nextPosition('sections', boardId);
    const section: Section = { id: newId(), boardId, title, position };
    this.db
      .query('INSERT INTO sections (id, board_id, title, position) VALUES (?, ?, ?, ?)')
      .run(section.id, boardId, title, position);
    this.recordHistory('section', section.id, actor, 'create', undefined, boardId);
    return section;
  }

  listSections(boardId: string, includeArchived = false): Section[] {
    const query = includeArchived
      ? 'SELECT * FROM sections WHERE board_id = ? ORDER BY position'
      : 'SELECT * FROM sections WHERE board_id = ? AND archived_at IS NULL ORDER BY position';
    return this.db.query<SectionRow, [string]>(query).all(boardId).map(toSection);
  }

  archiveSection(id: string, actor: string): void {
    const row = this.db.query<SectionRow, [string]>('SELECT * FROM sections WHERE id = ?').get(id);
    if (!row) {
      throw new Error(`section not found: ${id}`);
    }
    this.db.query('UPDATE sections SET archived_at = ? WHERE id = ?').run(nowIso(), id);
    this.recordHistory('section', id, actor, 'archive', undefined, row.board_id);
  }

  private nextPosition(table: 'sections' | 'todos' | 'notes', boardId: string | null): number {
    const where = boardId === null ? 'board_id IS NULL' : 'board_id = ?';
    const row = this.db
      .query<{ max: number | null }, string[]>(
        `SELECT MAX(position) AS max FROM ${table} WHERE ${where}`,
      )
      .get(...(boardId === null ? [] : [boardId]));
    return (row?.max ?? 0) + 1;
  }

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

  /**
   * boardId → board key. ref(`rocky#12`) 조립에 쓴다.
   *
   * "보드가 없음"과 "key 가 빈 문자열인 보드"를 구분해서 돌려준다 — 전자는 FK 가 깨진
   * 상태라 호출자가 실패시켜야 하고, 후자는 (레거시 데이터로만 가능한) malformed key 라
   * raw id 폴백 대상이다. 둘을 같은 값으로 뭉개면 후자가 폴백에 닿지 못한다.
   * @returns 보드가 없으면 `undefined`.
   */
  boardKeyOf(boardId: string): string | undefined {
    const row = this.db
      .query<{ key: string }, [string]>('SELECT key FROM boards WHERE id = ?')
      .get(boardId);
    return row?.key;
  }

  // ── todos ─────────────────────────────────────────────────────────────────

  createTodo(input: CreateTodoInput, actor: string): Todo {
    const board = this.ensureBoard(input.board, { actor });
    let sectionId: string | undefined;
    if (input.section) {
      sectionId = this.ensureSection(board.id, input.section, actor).id;
    }
    let parentId: string | undefined;
    if (input.parentId) {
      const parent = this.getTodo(input.parentId, board.id);
      if (!parent || parent.boardId !== board.id) {
        throw new Error(`parent todo not found in board ${input.board}: ${input.parentId}`);
      }
      parentId = parent.id;
    }
    const now = nowIso();
    const todo: Todo = {
      id: newId(),
      number: this.nextNumber('todos', board.id),
      boardId: board.id,
      sectionId,
      parentId,
      title: input.title,
      description: input.description ?? '',
      status: 'todo',
      priority: input.priority ?? 'p4',
      due: input.due,
      labels: input.labels ?? [],
      links: input.links ?? [],
      position: this.nextPosition('todos', board.id),
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .query(
        `INSERT INTO todos (id, number, board_id, section_id, parent_id, title, description, status, priority, due, labels, links, position, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        todo.id,
        todo.number,
        todo.boardId,
        sectionId ?? null,
        parentId ?? null,
        todo.title,
        todo.description,
        todo.status,
        todo.priority,
        todo.due ?? null,
        JSON.stringify(todo.labels),
        JSON.stringify(todo.links),
        todo.position,
        todo.createdAt,
        todo.updatedAt,
      );
    this.recordHistory('todo', todo.id, actor, 'create', undefined, board.id);
    return todo;
  }

  updateTodo(ref: string, patch: UpdateTodoPatch, actor: string, currentBoardId?: string): Todo {
    const current = this.mustGetTodo(ref, currentBoardId);
    const changes: Record<string, [unknown, unknown]> = {};
    const sets: string[] = [];
    const params: (string | number | null)[] = [];

    const apply = (
      column: string,
      field: string,
      oldValue: unknown,
      newValue: unknown,
      serialized: string | number | null,
    ) => {
      if (JSON.stringify(oldValue) === JSON.stringify(newValue)) {
        return;
      }
      changes[field] = [oldValue ?? null, newValue ?? null];
      sets.push(`${column} = ?`);
      params.push(serialized);
    };

    if (patch.title !== undefined) {
      apply('title', 'title', current.title, patch.title, patch.title);
    }
    if (patch.description !== undefined) {
      apply(
        'description',
        'description',
        current.description,
        patch.description,
        patch.description,
      );
    }
    if (patch.priority !== undefined) {
      apply('priority', 'priority', current.priority, patch.priority, patch.priority);
    }
    if (patch.due !== undefined) {
      apply('due', 'due', current.due, patch.due ?? undefined, patch.due);
    }
    if (patch.labels !== undefined) {
      apply('labels', 'labels', current.labels, patch.labels, JSON.stringify(patch.labels));
    }
    if (patch.links !== undefined) {
      apply('links', 'links', current.links, patch.links, JSON.stringify(patch.links));
    }
    if (patch.section !== undefined) {
      const section = this.ensureSection(current.boardId, patch.section, actor);
      apply('section_id', 'section', current.sectionId, section.id, section.id);
    }
    if (patch.parentId !== undefined) {
      if (patch.parentId === null) {
        apply('parent_id', 'parentId', current.parentId, undefined, null);
      } else {
        const parent = this.mustGetTodo(patch.parentId, current.boardId);
        if (parent.boardId !== current.boardId) {
          throw new Error(`parent todo not in same board: ${patch.parentId}`);
        }
        if (parent.id === current.id) {
          throw new Error('todo cannot be its own parent');
        }
        apply('parent_id', 'parentId', current.parentId, parent.id, parent.id);
      }
    }

    if (sets.length === 0) {
      return current;
    }
    sets.push('updated_at = ?');
    params.push(nowIso());
    params.push(current.id);
    this.db.query(`UPDATE todos SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    this.recordHistory('todo', current.id, actor, 'update', changes, current.boardId);
    return this.mustGetTodo(current.id);
  }

  setTodoStatus(ref: string, action: StatusAction, actor: string, currentBoardId?: string): Todo {
    const current = this.mustGetTodo(ref, currentBoardId);
    const now = nowIso();
    const changes: Record<string, [unknown, unknown]> = {};

    switch (action) {
      case 'start':
        changes.status = [current.status, 'doing'];
        this.db
          .query(
            'UPDATE todos SET status = ?, doing_by = ?, doing_since = ?, updated_at = ? WHERE id = ?',
          )
          .run('doing', actor, now, now, current.id);
        break;
      case 'stop':
        changes.status = [current.status, 'todo'];
        this.db
          .query(
            'UPDATE todos SET status = ?, doing_by = NULL, doing_since = NULL, updated_at = ? WHERE id = ?',
          )
          .run('todo', now, current.id);
        break;
      case 'done':
        changes.status = [current.status, 'done'];
        this.db
          .query(
            'UPDATE todos SET status = ?, doing_by = NULL, doing_since = NULL, completed_at = ?, updated_at = ? WHERE id = ?',
          )
          .run('done', now, now, current.id);
        break;
      case 'reopen':
        changes.status = [current.status, 'todo'];
        this.db
          .query('UPDATE todos SET status = ?, completed_at = NULL, updated_at = ? WHERE id = ?')
          .run('todo', now, current.id);
        break;
      case 'archive':
        changes.archived = [false, true];
        this.db
          .query('UPDATE todos SET archived_at = ?, updated_at = ? WHERE id = ?')
          .run(now, now, current.id);
        break;
      case 'unarchive':
        changes.archived = [true, false];
        this.db
          .query('UPDATE todos SET archived_at = NULL, updated_at = ? WHERE id = ?')
          .run(now, current.id);
        break;
      default:
        action satisfies never;
    }

    this.recordHistory('todo', current.id, actor, action, changes, current.boardId);
    return this.mustGetTodo(current.id);
  }

  listTodos(filter: ListTodosFilter): Todo[] {
    const wheres: string[] = [];
    const params: string[] = [];
    if (!filter.includeArchived) {
      wheres.push('archived_at IS NULL');
    }
    if (filter.board) {
      const board = this.boardByKey(filter.board);
      if (!board) {
        return [];
      }
      wheres.push('board_id = ?');
      params.push(board.id);
    }
    if (filter.status) {
      wheres.push('status = ?');
      params.push(filter.status);
    }
    const whereSql = wheres.length > 0 ? `WHERE ${wheres.join(' AND ')}` : '';
    const rows = this.db
      .query<TodoRow, string[]>(`SELECT * FROM todos ${whereSql} ORDER BY position`)
      .all(...params);
    let todos = rows.map(toTodo);
    if (filter.label) {
      todos = todos.filter((t) => t.labels.includes(filter.label as string));
    }
    return todos;
  }

  getTodo(ref: string, currentBoardId?: string): Todo | undefined {
    const row = this.resolveRef<TodoRow>('todos', ref, currentBoardId);
    return row ? toTodo(row) : undefined;
  }

  private mustGetTodo(ref: string, currentBoardId?: string): Todo {
    const todo = this.getTodo(ref, currentBoardId);
    if (!todo) {
      throw new Error(`todo not found: ${ref}`);
    }
    return todo;
  }

  // ── notes ─────────────────────────────────────────────────────────────────

  createNote(input: CreateNoteInput, actor: string): Note {
    let boardId: string | null = null;
    if (input.board) {
      boardId = this.ensureBoard(input.board, { actor }).id;
    }
    const now = nowIso();
    const note: Note = {
      id: newId(),
      number: this.nextNumber('notes', boardId),
      boardId: boardId ?? undefined,
      title: input.title,
      content: input.content ?? '',
      position: this.nextPosition('notes', boardId),
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .query(
        'INSERT INTO notes (id, number, board_id, title, content, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        note.id,
        note.number,
        boardId,
        note.title,
        note.content,
        note.position,
        note.createdAt,
        note.updatedAt,
      );
    this.recordHistory('note', note.id, actor, 'create', undefined, note.boardId);
    return note;
  }

  updateNote(ref: string, patch: UpdateNotePatch, actor: string, currentBoardId?: string): Note {
    const current = this.mustGetNote(ref, currentBoardId);
    const changes: Record<string, [unknown, unknown]> = {};
    const sets: string[] = [];
    const params: (string | null)[] = [];

    if (patch.title !== undefined && patch.title !== current.title) {
      changes.title = [current.title, patch.title];
      sets.push('title = ?');
      params.push(patch.title);
    }
    if (patch.content !== undefined) {
      const next =
        patch.mode === 'append'
          ? current.content === ''
            ? patch.content
            : `${current.content}\n${patch.content}`
          : patch.content;
      if (next !== current.content) {
        changes.content = [current.content, next];
        sets.push('content = ?');
        params.push(next);
      }
    }

    if (sets.length === 0) {
      return current;
    }
    sets.push('updated_at = ?');
    params.push(nowIso());
    params.push(current.id);
    this.db.query(`UPDATE notes SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    this.recordHistory('note', current.id, actor, 'update', changes, current.boardId);
    return this.mustGetNote(current.id);
  }

  archiveNote(ref: string, actor: string, currentBoardId?: string): Note {
    const current = this.mustGetNote(ref, currentBoardId);
    this.db
      .query('UPDATE notes SET archived_at = ?, updated_at = ? WHERE id = ?')
      .run(nowIso(), nowIso(), current.id);
    this.recordHistory('note', current.id, actor, 'archive', undefined, current.boardId);
    return this.mustGetNote(current.id);
  }

  unarchiveNote(ref: string, actor: string, currentBoardId?: string): Note {
    const current = this.mustGetNote(ref, currentBoardId);
    this.db
      .query('UPDATE notes SET archived_at = NULL, updated_at = ? WHERE id = ?')
      .run(nowIso(), current.id);
    this.recordHistory('note', current.id, actor, 'unarchive', undefined, current.boardId);
    return this.mustGetNote(current.id);
  }

  listNotes(filter: ListNotesFilter): Note[] {
    const wheres: string[] = [];
    const params: string[] = [];
    if (!filter.includeArchived) {
      wheres.push('archived_at IS NULL');
    }
    if (filter.global) {
      wheres.push('board_id IS NULL');
    } else if (filter.board) {
      const board = this.boardByKey(filter.board);
      if (!board) {
        return [];
      }
      wheres.push('board_id = ?');
      params.push(board.id);
    }
    const whereSql = wheres.length > 0 ? `WHERE ${wheres.join(' AND ')}` : '';
    return this.db
      .query<NoteRow, string[]>(`SELECT * FROM notes ${whereSql} ORDER BY position`)
      .all(...params)
      .map(toNote);
  }

  getNote(ref: string, currentBoardId?: string): Note | undefined {
    const row = this.resolveRef<NoteRow>('notes', ref, currentBoardId);
    return row ? toNote(row) : undefined;
  }

  private mustGetNote(ref: string, currentBoardId?: string): Note {
    const note = this.getNote(ref, currentBoardId);
    if (!note) {
      throw new Error(`note not found: ${ref}`);
    }
    return note;
  }

  // ── history ───────────────────────────────────────────────────────────────

  listHistory(filter: ListHistoryFilter): HistoryEntry[] {
    const wheres: string[] = [];
    const params: (string | number)[] = [];
    if (filter.entityId) {
      wheres.push('entity_id = ?');
      params.push(filter.entityId);
    }
    if (filter.entity) {
      wheres.push('entity = ?');
      params.push(filter.entity);
    }
    const whereSql = wheres.length > 0 ? `WHERE ${wheres.join(' AND ')}` : '';
    params.push(filter.limit ?? 50);
    return this.db
      .query<HistoryRow, (string | number)[]>(
        `SELECT * FROM history ${whereSql} ORDER BY id DESC LIMIT ?`,
      )
      .all(...params)
      .map(toHistory);
  }

  /**
   * sinceId 이후의 변경 피드 — 히스토리에 엔티티 제목/보드 키를 붙여 반환한다.
   * UserPromptSubmit 훅이 "마지막 확인 이후 무슨 일이 있었나"를 주입할 때 쓴다.
   * 오래된 것부터 (서사 순). lastId 는 전체 히스토리의 최신 id (비어도 sinceId 유지).
   */
  listChangesSince(sinceId: number, limit = 50): { lastId: number; entries: ChangeFeedEntry[] } {
    const rows = this.db
      .query<HistoryRow, [number, number]>(
        'SELECT * FROM history WHERE id > ? ORDER BY id ASC LIMIT ?',
      )
      .all(sinceId, limit);
    const maxRow = this.db
      .query<{ max: number | null }, []>('SELECT MAX(id) AS max FROM history')
      .get();
    const lastId = maxRow?.max ?? sinceId;

    const boardKeyById = new Map(this.listBoards(true).map((b) => [b.id, b.key]));
    const entries = rows.map((row) => {
      const history = toHistory(row);
      let title = '';
      let boardId: string | undefined;
      if (history.entity === 'todo') {
        const todo = this.db
          .query<TodoRow, [string]>('SELECT * FROM todos WHERE id = ?')
          .get(history.entityId);
        title = todo?.title ?? '';
        boardId = todo?.board_id;
      } else if (history.entity === 'note') {
        const note = this.db
          .query<NoteRow, [string]>('SELECT * FROM notes WHERE id = ?')
          .get(history.entityId);
        title = note?.title ?? '';
        boardId = note?.board_id ?? undefined;
      } else if (history.entity === 'section') {
        const section = this.db
          .query<SectionRow, [string]>('SELECT * FROM sections WHERE id = ?')
          .get(history.entityId);
        title = section?.title ?? '';
        boardId = section?.board_id;
      } else {
        title = boardKeyById.get(history.entityId) ?? '';
        boardId = history.entityId;
      }
      return {
        ...history,
        title,
        boardKey: boardId ? boardKeyById.get(boardId) : undefined,
      };
    });
    return { lastId, entries };
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  /**
   * 참조 문자열을 행으로 해석한다. 순서대로:
   *   `rocky#12` → 그 보드의 12번 · `#12`/`12` → currentBoardId 의 12번
   *   (notes 이고 currentBoardId 없으면 → 전역 note 공간의 12번)
   *   `921gvwnr`(ID_LENGTH 자 base36) → id 정확 일치 · 그 외 → 유일한 id prefix
   *
   * 길이 기준으로 번호와 id 를 가르므로, id 길이를 바꾸면 ID_LENGTH 만 고치면 된다.
   * notes 는 board_id IS NULL 인 전역 행을 가질 수 있어 자체 번호 시퀀스를 갖지만(부분 유니크
   * 인덱스 `idx_notes_number_global`), todos 는 항상 보드에 속하므로 전역 번호 공간이 없다.
   *
   * `rocky#12` 스코프 매칭의 board key 부분은 `sanitizeKey`(`src/actor.ts`)가 만들 수 있는
   * 모든 키를 받아야 한다 — `[a-zA-Z0-9_-]` 를 보존하므로 대문자로 시작하거나(`MyProject`)
   * `_`/`-` 로 시작하는(`_private`) 키도 나올 수 있다. 그래서 패턴은 `#` 와 공백만 제외한
   * `[^#\s]+` 를 쓴다 — 서버가 `ref: "MyProject#1"` 처럼 직렬화해 웹 UI 가 그대로 클립보드에
   * 복사하는 문자열을 이 함수가 못 읽으면(과거 `/^([a-z0-9][\w.-]*)#(\d+)$/` 가 그랬다)
   * 제품이 스스로 만든 참조를 스스로 못 먹는 꼴이 된다. 이 분기는 wildcard 가드(아래
   * `[%_]` 거부)보다 먼저 매칭돼 빠져나가므로, board 부분에 `%`/`_` 가 섞여도(예:
   * `_private#1`) LIKE 가드에 걸리지 않고 board 조회로 간다 — 가드는 id-prefix 분기 전용이다.
   *
   * board key 조회는 대소문자를 구분한다(SQLite 기본) — 정규식이 대소문자를 가리지 않고
   * 넓게 받아도(`/i` 없음) `WHERE key = ?` 조회 자체가 대소문자를 구분해 `ROCKY#1` 은
   * `rocky` 보드에 매칭되지 않고 `undefined` 로 끝난다. 조회를 대소문자 무시로 바꾸는
   * 대안도 있었지만, board key 는 UNIQUE(대소문자 구분) 라 `rocky`/`Rocky` 가 둘 다
   * 존재하면 대소문자 무시 조회가 모호성 체크 없이 둘 중 하나를 조용히 골라버릴 수 있어
   * 채택하지 않았다.
   *
   * @throws 다중 prefix 매칭, todos 에 현재 보드 없이 번호만 온 경우, 빈/공백 ref,
   *   id 앞부분에 SQL LIKE 와일드카드(`%`/`_`) 가 섞인 경우 (모두 모호성 노출)
   */
  private resolveRef<Row>(
    table: 'todos' | 'notes',
    ref: string,
    currentBoardId?: string,
  ): Row | undefined {
    const trimmed = ref.trim();
    if (trimmed === '') {
      // 빈 ref 를 그대로 흘리면 아래 LIKE 프리픽스 매칭이 ''로 모든 행에 매치돼(테이블에
      // 행이 하나면 조용히 그 행을 반환) 참조하지 않은 항목을 건드리게 된다.
      throw new Error('empty ref');
    }

    const scoped = /^([^#\s]+)#(\d+)$/.exec(trimmed);
    if (scoped?.[1] && scoped[2]) {
      const board = this.db
        .query<{ id: string }, [string]>('SELECT id FROM boards WHERE key = ?')
        .get(scoped[1]);
      if (!board) {
        return undefined;
      }
      return (
        this.db
          .query<Row, [string, number]>(`SELECT * FROM ${table} WHERE board_id = ? AND number = ?`)
          .get(board.id, Number(scoped[2])) ?? undefined
      );
    }

    const bare = /^(#)?(\d+)$/.exec(trimmed);
    if (bare?.[2] && (bare[1] || bare[2].length < ID_LENGTH)) {
      if (!currentBoardId) {
        if (table === 'notes') {
          return (
            this.db
              .query<Row, [number]>(`SELECT * FROM ${table} WHERE board_id IS NULL AND number = ?`)
              .get(Number(bare[2])) ?? undefined
          );
        }
        throw new Error(`board context required to resolve ${trimmed} — use board#number`);
      }
      return (
        this.db
          .query<Row, [string, number]>(`SELECT * FROM ${table} WHERE board_id = ? AND number = ?`)
          .get(currentBoardId, Number(bare[2])) ?? undefined
      );
    }

    const exact = this.db.query<Row, [string]>(`SELECT * FROM ${table} WHERE id = ?`).get(trimmed);
    if (exact) {
      return exact;
    }
    if (/[%_]/.test(trimmed)) {
      // 진짜 id 는 base36(0-9a-z, ID_ALPHABET) 뿐이라 `%`/`_` 를 담을 수 없다 — 그대로
      // LIKE 에 흘리면 SQL 와일드카드로 해석돼(예: `_yaz90tj` 가 `xyaz90tj` 에도 매치) 의도한
      // 적 없는 행을 조용히 골라올 수 있다. ESCAPE 절 대신 통째로 거부한다 — 어차피 유효한
      // id/prefix 가 될 수 없는 입력이라 잃는 기능이 없다.
      throw new Error(`invalid id prefix: ${trimmed}`);
    }
    const matches = this.db
      .query<Row, [string]>(`SELECT * FROM ${table} WHERE id LIKE ? || '%' LIMIT 2`)
      .all(trimmed);
    if (matches.length > 1) {
      throw new Error(`ambiguous id prefix: ${trimmed}`);
    }
    return matches[0];
  }
}

function toBoard(row: BoardRow): Board {
  return {
    id: row.id,
    key: row.key,
    title: row.title,
    createdAt: row.created_at,
    archivedAt: row.archived_at ?? undefined,
  };
}

function toSection(row: SectionRow): Section {
  return {
    id: row.id,
    boardId: row.board_id,
    title: row.title,
    position: row.position,
    archivedAt: row.archived_at ?? undefined,
  };
}

function toTodo(row: TodoRow): Todo {
  return {
    id: row.id,
    number: row.number,
    boardId: row.board_id,
    sectionId: row.section_id ?? undefined,
    parentId: row.parent_id ?? undefined,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    due: row.due ?? undefined,
    labels: JSON.parse(row.labels) as string[],
    links: JSON.parse(row.links) as TodoLink[],
    doingBy: row.doing_by ?? undefined,
    doingSince: row.doing_since ?? undefined,
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? undefined,
    archivedAt: row.archived_at ?? undefined,
  };
}

function toNote(row: NoteRow): Note {
  return {
    id: row.id,
    number: row.number,
    boardId: row.board_id ?? undefined,
    title: row.title,
    content: row.content,
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at ?? undefined,
  };
}

function toHistory(row: HistoryRow): HistoryEntry {
  return {
    id: row.id,
    entity: row.entity,
    entityId: row.entity_id,
    actor: row.actor,
    action: row.action,
    changes: row.changes
      ? (JSON.parse(row.changes) as Record<string, [unknown, unknown]>)
      : undefined,
    at: row.at,
  };
}
