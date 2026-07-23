import { Database } from 'bun:sqlite';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

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

/** 8자 base36 랜덤 id — 짧아서 CLI/대화에서 다루기 좋고 prefix 매칭을 허용한다. */
function newId(): string {
  const bytes = randomBytes(8);
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

  ensureBoard(key: string, options: { title?: string; actor: string }): Board {
    const existing = this.db
      .query<BoardRow, [string]>('SELECT * FROM boards WHERE key = ?')
      .get(key);
    if (existing) {
      return toBoard(existing);
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

  // ── todos ─────────────────────────────────────────────────────────────────

  createTodo(input: CreateTodoInput, actor: string): Todo {
    const board = this.ensureBoard(input.board, { actor });
    let sectionId: string | undefined;
    if (input.section) {
      sectionId = this.ensureSection(board.id, input.section, actor).id;
    }
    let parentId: string | undefined;
    if (input.parentId) {
      const parent = this.getTodo(input.parentId);
      if (!parent || parent.boardId !== board.id) {
        throw new Error(`parent todo not found in board ${input.board}: ${input.parentId}`);
      }
      parentId = parent.id;
    }
    const now = nowIso();
    const todo: Todo = {
      id: newId(),
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
        `INSERT INTO todos (id, board_id, section_id, parent_id, title, description, status, priority, due, labels, links, position, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        todo.id,
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

  updateTodo(idOrPrefix: string, patch: UpdateTodoPatch, actor: string): Todo {
    const current = this.mustGetTodo(idOrPrefix);
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
        const parent = this.mustGetTodo(patch.parentId);
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

  setTodoStatus(idOrPrefix: string, action: StatusAction, actor: string): Todo {
    const current = this.mustGetTodo(idOrPrefix);
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

  getTodo(idOrPrefix: string): Todo | undefined {
    const row = this.resolveByPrefix<TodoRow>('todos', idOrPrefix);
    return row ? toTodo(row) : undefined;
  }

  private mustGetTodo(idOrPrefix: string): Todo {
    const todo = this.getTodo(idOrPrefix);
    if (!todo) {
      throw new Error(`todo not found: ${idOrPrefix}`);
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
      boardId: boardId ?? undefined,
      title: input.title,
      content: input.content ?? '',
      position: this.nextPosition('notes', boardId),
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .query(
        'INSERT INTO notes (id, board_id, title, content, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        note.id,
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

  updateNote(idOrPrefix: string, patch: UpdateNotePatch, actor: string): Note {
    const current = this.mustGetNote(idOrPrefix);
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

  archiveNote(idOrPrefix: string, actor: string): Note {
    const current = this.mustGetNote(idOrPrefix);
    this.db
      .query('UPDATE notes SET archived_at = ?, updated_at = ? WHERE id = ?')
      .run(nowIso(), nowIso(), current.id);
    this.recordHistory('note', current.id, actor, 'archive', undefined, current.boardId);
    return this.mustGetNote(current.id);
  }

  unarchiveNote(idOrPrefix: string, actor: string): Note {
    const current = this.mustGetNote(idOrPrefix);
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

  getNote(idOrPrefix: string): Note | undefined {
    const row = this.resolveByPrefix<NoteRow>('notes', idOrPrefix);
    return row ? toNote(row) : undefined;
  }

  private mustGetNote(idOrPrefix: string): Note {
    const note = this.getNote(idOrPrefix);
    if (!note) {
      throw new Error(`note not found: ${idOrPrefix}`);
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

  /** 정확 일치 우선, 아니면 유일한 prefix 매칭. 다중 매칭이면 에러 (모호성 노출). */
  private resolveByPrefix<Row>(table: 'todos' | 'notes', idOrPrefix: string): Row | undefined {
    const exact = this.db
      .query<Row, [string]>(`SELECT * FROM ${table} WHERE id = ?`)
      .get(idOrPrefix);
    if (exact) {
      return exact;
    }
    const matches = this.db
      .query<Row, [string]>(`SELECT * FROM ${table} WHERE id LIKE ? || '%' LIMIT 2`)
      .all(idOrPrefix);
    if (matches.length > 1) {
      throw new Error(`ambiguous id prefix: ${idOrPrefix}`);
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
