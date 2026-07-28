import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ID_LENGTH, newId } from './ids';
import { runMigrations } from './migrations';
import { GLOBAL_NOTE_PREFIX, refOf } from './refs';

// id 생성과 그 길이는 `./ids` 가 소유한다 — `refs.ts` 도 `ID_LENGTH` 가 필요해서, 여기
// 두면 store ↔ refs 런타임 순환이 된다. 기존 import 경로(`from './store'`)를 쓰던
// 호출자를 위해 그대로 재수출한다.
export { ID_LENGTH };

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
  /** `owner/name` — GitHub 이슈 생성 대상. 설정 전에는 undefined. */
  repo?: string;
  /** 메인 레포의 절대경로 — 백그라운드 세션을 띄우는 자리. 설정 전에는 undefined. */
  path?: string;
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
  /** 보드별 순번 — 사람이 읽고 부르는 참조(rocky-12). id 와 달리 보드 안에서만 유일하다. */
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
  /** 보드별 순번 — 사람이 읽고 부르는 참조(rocky-12). id 와 달리 보드 안에서만 유일하다. */
  number: number;
  boardId?: string;
  title: string;
  content: string;
  position: number;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

/** todo 한 건에 달리는 댓글 — 에이전트의 진행 보고와 사용자의 답이 같은 타임라인에 쌓인다. */
export interface Comment {
  id: string;
  todoId: string;
  actor: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export type HandoffStatus = 'pending' | 'delivered' | 'cancelled';
/**
 * 어느 경로로 배달됐는지 — `Stop`(자동 착수) · `UserPromptSubmit`(사용자가 말을 걸 때) ·
 * `spawn`(데몬이 새 백그라운드 세션을 띄우며 프롬프트로 직접 넣은 것).
 */
export type HandoffVia = 'stop' | 'prompt' | 'spawn';

/** 보드에서 실행 중인 Claude Code 세션으로 넘긴 작업 요청 한 건. */
export interface Handoff {
  id: string;
  todoId: string;
  sessionId: string;
  /** 표시용 스냅샷 — 세션이 사라지면 sessionId 만으로는 어디로 보냈는지 읽을 수 없다. */
  sessionName?: string;
  sessionCwd?: string;
  note: string;
  actor: string;
  status: HandoffStatus;
  createdAt: string;
  deliveredAt?: string;
  deliveredVia?: HandoffVia;
}

export interface CreateHandoffInput {
  /** todo 참조 문법 (`rocky-12` / 레거시 입력 `#12`·`rocky#12` / id / id prefix). */
  ref: string;
  sessionId: string;
  sessionName?: string;
  sessionCwd?: string;
  note?: string;
  actor: string;
  currentBoardId?: string;
}

export interface CreateSpawnedHandoffInput {
  /** todo 참조 문법 (`rocky-12` / 레거시 입력 `#12`·`rocky#12` / id / id prefix). */
  ref: string;
  /** 짧은 id(8자) — 사용자가 `claude attach/logs/stop/rm` 에 그대로 넣는 값이다. */
  sessionId: string;
  sessionName: string;
  /** 워크트리 경로. `via='spawn'` 인 행에서는 표시용이 아니라 재사용 대상을 가리킨다. */
  sessionCwd: string;
  note?: string;
  actor: string;
  currentBoardId?: string;
}

/** claim 결과 — 훅이 주입문을 만드는 데 필요한 것을 한 번에 준다. */
export interface ClaimedHandoff {
  handoff: Handoff;
  /** `rocky-todo#11` 형태의 사람이 읽는 참조. */
  todoRef: string;
  todoTitle: string;
  /** 이 세션 앞에 아직 남은 pending 건수. */
  remaining: number;
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
  /** 이름으로 upsert. `null`(또는 공백뿐인 문자열)이면 섹션에서 뺀다 — parentId 와 같은 대칭. */
  section?: string | null;
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
  /**
   * 결과에서 뺄 action 목록 — 상세 화면 조회처럼 "다른 곳에 이미 표현된 사건"을
   * `LIMIT` 이 적용되기 **전에** 걸러내고 싶을 때 쓴다(사후 필터는 limit 을 낭비한다).
   */
  excludeActions?: readonly string[];
}

/**
 * 상세 화면(REST `GET /api/todos/:ref` · MCP `todo_list` 단건 조회)에서 제외하는
 * history action. 댓글 mutation 은 부모 todo 의 history 에도 기록되는데(SSE·훅
 * 주입 경로 재사용), 상세 화면은 댓글을 카드로 이미 보여주므로 그중 **카드가 여전히
 * 대표하는** 두 액션(작성/본문 수정)만 뺀다.
 *
 * `comment-archive`/`comment-unarchive` 는 여기 포함하지 않는다 — 보관되면 카드
 * 자체가 사라지므로(대표하는 화면 요소가 없어짐) history 에 흔적을 남겨야 한다.
 * `listHistory` 를 부르는 두 호출부(`src/server.ts`, `src/mcp.ts`)가 이 상수 하나를
 * 공유해 배열 리터럴이 두 곳에서 따로 놀지 않게 한다.
 *
 * `src/ui/lib.ts` 가 같은 값 쌍을 별도로 export 한다(`DETAIL_HISTORY_EXCLUDED`, 같은
 * 이름) — 브라우저 번들 코드라 이 파일을 런타임으로 import 할 수 없어서다(`bun:sqlite`
 * 가 딸려 온다). `src/ui/lib.test.ts` 가 두 목록이 같은 값을 갖는지 회귀 테스트로
 * 고정하니, 여기 값을 바꾸면 그쪽도 함께 고쳐야 한다.
 */
export const DETAIL_HISTORY_EXCLUDED = ['comment', 'comment-edit'] as const;

export interface TodoStoreOptions {
  dbPath: string;
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
  repo: string | null;
  path: string | null;
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

interface CommentRow {
  id: string;
  todo_id: string;
  actor: string;
  body: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

interface HandoffRow {
  id: string;
  todo_id: string;
  session_id: string;
  session_name: string | null;
  session_cwd: string | null;
  note: string;
  actor: string;
  status: HandoffStatus;
  created_at: string;
  delivered_at: string | null;
  delivered_via: string | null;
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
  repo TEXT,
  path TEXT,
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
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  todo_id TEXT NOT NULL REFERENCES todos(id),
  actor TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);
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
);
CREATE INDEX IF NOT EXISTS idx_todos_board ON todos(board_id);
CREATE INDEX IF NOT EXISTS idx_notes_board ON notes(board_id);
CREATE INDEX IF NOT EXISTS idx_history_entity ON history(entity_id);
CREATE INDEX IF NOT EXISTS idx_comments_todo ON comments(todo_id, created_at);
CREATE INDEX IF NOT EXISTS idx_handoffs_session ON handoffs(session_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_handoffs_todo ON handoffs(todo_id, status);
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

  /**
   * history 한 줄 기록 + change 이벤트 발행.
   * @param emit false 면 이벤트를 내지 않는다 — 한 동작이 여러 행을 건드리는 배치에서
   *   구독자에게 N개를 쏘지 않기 위해서다 (구독자는 payload 를 보지 않고 refetch 만 한다).
   *   이 경우 배치 끝에서 대표 이벤트를 한 번 낸다.
   */
  private recordHistory(
    entity: HistoryEntity,
    entityId: string,
    actor: string,
    action: string,
    changes?: Record<string, [unknown, unknown]>,
    boardId?: string,
    emit = true,
  ): void {
    this.db
      .query(
        'INSERT INTO history (entity, entity_id, actor, action, changes, at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(entity, entityId, actor, action, changes ? JSON.stringify(changes) : null, nowIso());
    if (emit) {
      this.emit({ entity, entityId, action, boardId });
    }
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
   * @throws key 가 비어 있거나 공백/`#` 를 포함하는 **새** 보드를 만들려 하면 — 어느
   * 문자가 문제인지 명시한다. 이미 존재하는 보드는 이 검증을 건너뛴다.
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
    // 항목의 section_id 를 남겨두면 UI 가 그 항목을 어느 그룹에도 못 넣어 화면에서
    // 사라진다 (섹션 그룹은 없어지고 미분류 그룹은 section_id 가 빈 것만 모은다).
    // 섹션이 사라지면 항목은 미분류로 돌려놓는다 — 항목 자체는 건드리지 않는다.
    // updated_at 도 함께 올린다 — updateTodo 로 섹션을 뗄 때와 같은 변경인데 여기서만
    // 시간이 멈추면 정렬·동기화가 이 행을 낡지 않은 것으로 오해한다.
    const at = nowIso();
    const affected = this.db
      .query<{ id: string }, [string]>('SELECT id FROM todos WHERE section_id = ?')
      .all(id);
    this.db
      .query('UPDATE todos SET section_id = NULL, updated_at = ? WHERE section_id = ?')
      .run(at, id);
    // 각 todo 에도 이력을 남긴다 — 이 파일의 원칙(모든 mutation 은 history 기록)이고,
    // 남기지 않으면 상세 타임라인에서 섹션이 왜 풀렸는지 설명할 방법이 없다.
    // 이벤트는 내지 않는다 — 아래 section archive 이벤트 하나로 갈음한다. 섹션에 항목이
    // 많으면 그 수만큼 SSE 가 나가는데, 구독자는 payload 를 보지 않고 refetch 만 한다.
    for (const todo of affected) {
      this.recordHistory(
        'todo',
        todo.id,
        actor,
        'update',
        { section: [id, null] },
        row.board_id,
        false,
      );
    }
    this.db.query('UPDATE sections SET archived_at = ? WHERE id = ?').run(at, id);
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
   * boardId → board key. ref(`rocky-12`) 조립에 쓴다.
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

  /** boardId 로 보드 한 건. 이슈 라우트가 todo → 보드 → repo 를 따라갈 때 쓴다. */
  boardById(boardId: string): Board | undefined {
    const row = this.db.query<BoardRow, [string]>('SELECT * FROM boards WHERE id = ?').get(boardId);
    return row ? toBoard(row) : undefined;
  }

  /** 보드 key 로 보드 한 건을 반환한다. 없으면 undefined. */
  getBoard(key: string): Board | undefined {
    return this.boardByKey(key);
  }

  /**
   * 보드의 GitHub 레포(`owner/name`)를 설정한다.
   *
   * 값은 여기서 한 번 더 trim 한다 — 호출부(REST 라우트·CLI·오케스트레이터)가 이미
   * 다듬어 넘기지만, 스토어를 통과한 값은 그대로 `gh -R` 인자가 되므로 공백이 섞인 채
   * 저장되면 이후 모든 이슈 생성이 조용히 실패한다. 마지막 관문에서 막는 편이 싸다.
   *
   * trim 한 값이 기존 값과 같으면 write 도 히스토리도 남기지 않는다(no-op) — 같은 값의
   * 반복 설정이 흔한 경로라서다.
   *
   * @throws 없는 보드면 — 여기서 보드를 만들지 않는다. 오타난 key 로 빈 보드가 생기는
   *   편이 조용한 사고가 된다(`ensureSection` 과 같은 판단).
   */
  setBoardRepo(key: string, repo: string, actor: string): Board {
    const existing = this.db
      .query<BoardRow, [string]>('SELECT * FROM boards WHERE key = ?')
      .get(key);
    if (!existing) {
      throw new Error(`board not found: ${key}`);
    }
    const normalized = repo.trim();
    // 같은 값이면 아무것도 하지 않는다 — `createIssueForTodo` 는 `options.repo` 가 오면
    // 매번 이걸 부르고, `issue REF --repo o/n` 이나 웹 UI 재시도는 같은 슬러그를 반복해
    // 넘긴다. 그때마다 `update` 히스토리와 SSE 가 쌓이면 "안 바뀐 변경"이 타임라인을
    // 어지럽힌다(MCP `todo_write` 가 빈 patch 를 건너뛰는 것과 같은 판단).
    if (existing.repo === normalized) {
      return toBoard(existing);
    }
    this.db.query('UPDATE boards SET repo = ? WHERE id = ?').run(normalized, existing.id);
    this.recordHistory(
      'board',
      existing.id,
      actor,
      'update',
      { repo: [existing.repo ?? null, normalized] },
      existing.id,
    );
    return { ...toBoard(existing), repo: normalized };
  }

  /**
   * 보드의 메인 레포 경로를 설정한다 — 백그라운드 세션을 띄우는 자리다.
   *
   * `setBoardRepo` 와 같은 규칙: 값은 여기서 한 번 더 trim 하고, 같은 값이면 write 도
   * 히스토리도 남기지 않는다(no-op). 경로가 실제로 존재하는지·git 레포인지는 여기서
   * 보지 않는다 — 스토어는 파일시스템을 모르고, 그 판정은 spawn 라우트가 한다.
   *
   * @throws 없는 보드면 — 여기서 보드를 만들지 않는다(`setBoardRepo` 와 같은 판단).
   */
  setBoardPath(key: string, path: string, actor: string): Board {
    const existing = this.db
      .query<BoardRow, [string]>('SELECT * FROM boards WHERE key = ?')
      .get(key);
    if (!existing) {
      throw new Error(`board not found: ${key}`);
    }
    const normalized = path.trim();
    if (existing.path === normalized) {
      return toBoard(existing);
    }
    this.db.query('UPDATE boards SET path = ? WHERE id = ?').run(normalized, existing.id);
    this.recordHistory(
      'board',
      existing.id,
      actor,
      'update',
      { path: [existing.path ?? null, normalized] },
      existing.id,
    );
    return { ...toBoard(existing), path: normalized };
  }

  // ── todos ─────────────────────────────────────────────────────────────────

  createTodo(input: CreateTodoInput, actor: string): Todo {
    const board = this.ensureBoard(input.board, { actor });
    let sectionId: string | undefined;
    // updateTodo 와 같은 규칙 — 공백뿐인 이름으로 섹션을 만들지 않고, 앞뒤 공백은
    // 다듬어 같은 이름이 두 섹션으로 갈라지지 않게 한다.
    const sectionTitle = input.section?.trim() ?? '';
    if (sectionTitle !== '') {
      sectionId = this.ensureSection(board.id, sectionTitle, actor).id;
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
      // 빈 이름 섹션을 만들어 두는 건 사고다 — 공백뿐인 입력은 해제로 본다.
      const title = patch.section?.trim() ?? '';
      if (title === '') {
        apply('section_id', 'section', current.sectionId, undefined, null);
      } else {
        const section = this.ensureSection(current.boardId, title, actor);
        apply('section_id', 'section', current.sectionId, section.id, section.id);
      }
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

  // ── comments ──────────────────────────────────────────────────────────────

  /**
   * todo 에 댓글을 단다. `ref` 는 todo 참조 문법(`rocky-12` / 레거시 입력 `#12`·`rocky#12` / id / id prefix).
   *
   * 히스토리는 **부모 todo 의 것으로**(`entity='todo'`) 기록한다 — `history` 의
   * `CHECK (entity IN (...))` 를 건드리지 않으면서 상세 조회(`listHistory({entityId})`),
   * SSE change 이벤트, `/api/changes` 훅 주입 경로에 그대로 올라탄다.
   * @throws 본문이 공백뿐이거나 todo 를 못 찾으면.
   */
  addComment(ref: string, body: string, actor: string, currentBoardId?: string): Comment {
    const trimmed = body.trim();
    if (trimmed === '') {
      throw new Error('comment body is required');
    }
    const todo = this.mustGetTodo(ref, currentBoardId);
    const now = nowIso();
    const comment: Comment = {
      id: newId(),
      todoId: todo.id,
      actor,
      body: trimmed,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .query(
        'INSERT INTO comments (id, todo_id, actor, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        comment.id,
        comment.todoId,
        comment.actor,
        comment.body,
        comment.createdAt,
        comment.updatedAt,
      );
    this.recordHistory(
      'todo',
      todo.id,
      actor,
      'comment',
      { comment: [null, trimmed] },
      todo.boardId,
    );
    return comment;
  }

  /**
   * 한 todo 의 댓글 — 오래된 것부터(대화 순). 기본은 보관된 댓글 제외.
   * (같은 밀리초에 들어온 댓글의 순서를 랜덤 id 가 아니라 삽입 순서로 가른다 — `rowid` 를 tiebreak 로 쓴다.)
   */
  listComments(todoId: string, includeArchived = false): Comment[] {
    const archivedFilter = includeArchived ? '' : ' AND archived_at IS NULL';
    return this.db
      .query<CommentRow, [string]>(
        `SELECT * FROM comments WHERE todo_id = ?${archivedFilter} ORDER BY created_at ASC, rowid ASC`,
      )
      .all(todoId)
      .map(toComment);
  }

  /**
   * 댓글 본문 수정. 대상은 **댓글 id 로만** 지정한다 — 댓글은 보드별 번호(`rocky-N` 같은 ref)를 갖지
   * 않는다(번호 공간이 하나 더 늘면 `resolveRef` 의 모호성만 커진다).
   * @throws 본문이 공백뿐이거나 댓글을 못 찾으면.
   */
  updateComment(id: string, body: string, actor: string): Comment {
    const trimmed = body.trim();
    if (trimmed === '') {
      throw new Error('comment body is required');
    }
    const current = this.mustGetComment(id);
    if (trimmed === current.body) {
      return current;
    }
    const now = nowIso();
    this.db
      .query('UPDATE comments SET body = ?, updated_at = ? WHERE id = ?')
      .run(trimmed, now, id);
    this.recordHistory(
      'todo',
      current.todoId,
      actor,
      'comment-edit',
      { comment: [current.body, trimmed] },
      this.boardIdOfTodo(current.todoId),
    );
    return { ...current, body: trimmed, updatedAt: now };
  }

  /** 댓글 보관/복원 — 삭제는 없다(레포 전체 원칙). */
  setCommentArchived(id: string, archived: boolean, actor: string): Comment {
    const current = this.mustGetComment(id);
    const at = archived ? nowIso() : null;
    this.db.query('UPDATE comments SET archived_at = ? WHERE id = ?').run(at, id);
    this.recordHistory(
      'todo',
      current.todoId,
      actor,
      archived ? 'comment-archive' : 'comment-unarchive',
      undefined,
      this.boardIdOfTodo(current.todoId),
    );
    return { ...current, archivedAt: at ?? undefined };
  }

  /**
   * 목록 배지용 집계 — 보관되지 않은 댓글 수와 마지막 작성 시각.
   *
   * `withRef` 가 todo 하나마다 한 번 호출한다(N+1). 데몬 안 in-process SQLite 이고
   * `idx_comments_todo` 가 커버하는 질의라 보드 규모(수십~수백 건)에서 비용이 무시할
   * 수준이다 — 대신 모든 호출부(REST 목록·MCP·CLI)가 코드 변경 없이 집계를 얻는다.
   */
  commentStatsOf(todoId: string): { count: number; lastAt?: string } {
    const row = this.db
      .query<{ n: number; last: string | null }, [string]>(
        'SELECT COUNT(*) AS n, MAX(created_at) AS last FROM comments WHERE todo_id = ? AND archived_at IS NULL',
      )
      .get(todoId);
    return { count: row?.n ?? 0, lastAt: row?.last ?? undefined };
  }

  private mustGetComment(id: string): Comment {
    const row = this.db.query<CommentRow, [string]>('SELECT * FROM comments WHERE id = ?').get(id);
    if (!row) {
      throw new Error(`comment not found: ${id}`);
    }
    return toComment(row);
  }

  /**
   * 댓글이 속한 todo 의 boardId — change 이벤트의 boardId 필드용.
   * `getTodo` 를 쓰지 않는 이유: 저장된 raw id 는 참조 해석을 거칠 필요가 없고,
   * 여기서 `resolveRef` 의 prefix/번호 분기를 타게 하면 의미만 흐려진다.
   */
  private boardIdOfTodo(todoId: string): string | undefined {
    return this.db
      .query<{ board_id: string }, [string]>('SELECT board_id FROM todos WHERE id = ?')
      .get(todoId)?.board_id;
  }

  // ── handoffs ──────────────────────────────────────────────────────────────

  /**
   * todo 를 실행 중인 세션 앞으로 넘긴다.
   *
   * 히스토리는 댓글과 같은 방식으로 **부모 todo 의 것으로**(`entity='todo'`) 기록해
   * 상세 타임라인과 SSE 를 그대로 탄다. 다만 `/api/changes` 피드에서는 빠진다 —
   * `listChangesSince` 참고.
   * @throws todo 를 못 찾거나, 아카이브됐거나, 이미 pending 이 있으면.
   */
  createHandoff(input: CreateHandoffInput): Handoff {
    const todo = this.mustGetTodo(input.ref, input.currentBoardId);
    if (todo.archivedAt) {
      throw new Error(`todo is archived: ${todo.id}`);
    }
    if (this.pendingHandoffOf(todo.id)) {
      throw new Error(`handoff already pending for todo: ${todo.id}`);
    }
    const handoff: Handoff = {
      id: newId(),
      todoId: todo.id,
      sessionId: input.sessionId,
      sessionName: input.sessionName,
      sessionCwd: input.sessionCwd,
      note: (input.note ?? '').trim(),
      actor: input.actor,
      status: 'pending',
      createdAt: nowIso(),
    };
    this.insertHandoffRow(handoff);
    this.recordHistory(
      'todo',
      todo.id,
      input.actor,
      'handoff',
      { handoff: [null, handoff.sessionName ?? handoff.sessionId] },
      todo.boardId,
    );
    return handoff;
  }

  /**
   * `handoffs` 행 하나를 그대로 넣는다 — `createHandoff` / `createSpawnedHandoff` 공용.
   *
   * `deliveredAt`/`deliveredVia` 는 미배달(`pending`) 행에서 `undefined` 로 와 `null` 로
   * 저장된다. 여기 모아둔 덕에 **INSERT 문 자체는** 두 호출부가 갈라지지 않는다 — 다만
   * 컬럼이 실제로 늘면 `Handoff` · `HandoffRow` · `toHandoff` 도 함께 고쳐야 한다.
   */
  private insertHandoffRow(handoff: Handoff): void {
    this.db
      .query(
        `INSERT INTO handoffs
           (id, todo_id, session_id, session_name, session_cwd, note, actor, status,
            created_at, delivered_at, delivered_via)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        handoff.id,
        handoff.todoId,
        handoff.sessionId,
        handoff.sessionName ?? null,
        handoff.sessionCwd ?? null,
        handoff.note,
        handoff.actor,
        handoff.status,
        handoff.createdAt,
        handoff.deliveredAt ?? null,
        handoff.deliveredVia ?? null,
      );
  }

  /**
   * 새로 띄운 백그라운드 세션 앞으로의 배달을 기록한다.
   *
   * `createHandoff` 와 달리 pending 을 거치지 않는다 — 프롬프트로 이미 배달했기 때문에
   * 생성 시점에 `delivered` 다. 그래서 claim 대상이 되지 않고, 큐를 소모하지도 않는다.
   *
   * 호출 순서가 중요하다: **spawn 이 성공한 뒤에** 부른다. 실패한 spawn 이 배달 기록을
   * 남기면 보드가 "보냈다"고 말하는데 아무도 받지 않은 상태가 된다.
   *
   * @throws todo 를 못 찾거나 아카이브됐으면.
   */
  createSpawnedHandoff(input: CreateSpawnedHandoffInput): Handoff {
    const todo = this.mustGetTodo(input.ref, input.currentBoardId);
    if (todo.archivedAt) {
      throw new Error(`todo is archived: ${todo.id}`);
    }
    const at = nowIso();
    const handoff: Handoff = {
      id: newId(),
      todoId: todo.id,
      sessionId: input.sessionId,
      sessionName: input.sessionName,
      sessionCwd: input.sessionCwd,
      note: (input.note ?? '').trim(),
      actor: input.actor,
      status: 'delivered',
      createdAt: at,
      deliveredAt: at,
      deliveredVia: 'spawn',
    };
    this.insertHandoffRow(handoff);
    this.recordHistory(
      'todo',
      todo.id,
      input.actor,
      'handoff-spawn',
      { handoff: [null, handoff.sessionName] },
      todo.boardId,
    );
    return handoff;
  }

  /** 이 todo 앞으로 아직 배달되지 않은 요청. 없으면 undefined. */
  pendingHandoffOf(todoId: string): Handoff | undefined {
    const row = this.db
      .query<HandoffRow, [string]>(
        "SELECT * FROM handoffs WHERE todo_id = ? AND status = 'pending' ORDER BY created_at ASC, rowid ASC LIMIT 1",
      )
      .get(todoId);
    return row ? toHandoff(row) : undefined;
  }

  /** 큐 조회 — 최신순. boardId 로 거르면 그 보드 todo 의 요청만 나온다. */
  listHandoffs(
    filter: { boardId?: string; todoId?: string; status?: HandoffStatus } = {},
  ): Handoff[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter.boardId) {
      clauses.push('h.todo_id IN (SELECT id FROM todos WHERE board_id = ?)');
      params.push(filter.boardId);
    }
    if (filter.todoId) {
      clauses.push('h.todo_id = ?');
      params.push(filter.todoId);
    }
    if (filter.status) {
      clauses.push('h.status = ?');
      params.push(filter.status);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    return this.db
      .query<HandoffRow, string[]>(
        `SELECT h.* FROM handoffs h${where} ORDER BY h.created_at DESC, h.rowid DESC`,
      )
      .all(...params)
      .map(toHandoff);
  }

  /**
   * 이 세션 앞의 pending 중 **가장 오래된 한 건만** 배달 처리하고 돌려준다.
   *
   * 한 번에 하나인 이유: 여러 건을 한꺼번에 주면 에이전트가 섞어서 착수하거나 병렬로
   * 벌린다 — 보드의 start→done 에티켓과 어긋난다. 하나를 끝내면 `Stop` 훅이 다시
   * 발동해 다음 것을 집으므로 큐는 저절로 직렬로 소화된다.
   * @returns 대기 중인 것이 없으면 null.
   */
  claimHandoff(sessionId: string, via: HandoffVia): ClaimedHandoff | null {
    const claim = this.db.transaction((): ClaimedHandoff | null => {
      const row = this.db
        .query<HandoffRow, [string]>(
          "SELECT * FROM handoffs WHERE session_id = ? AND status = 'pending' ORDER BY created_at ASC, rowid ASC LIMIT 1",
        )
        .get(sessionId);
      if (!row) {
        return null;
      }
      const at = nowIso();
      this.db
        .query(
          "UPDATE handoffs SET status = 'delivered', delivered_at = ?, delivered_via = ? WHERE id = ? AND status = 'pending'",
        )
        .run(at, via, row.id);
      const todo = this.getTodo(row.todo_id);
      if (!todo) {
        // todo 가 사라진 요청은 배달할 수 없다 — delivered 로 닫고 넘어간다.
        return null;
      }
      const remaining =
        this.db
          .query<{ n: number }, [string]>(
            "SELECT COUNT(*) AS n FROM handoffs WHERE session_id = ? AND status = 'pending'",
          )
          .get(sessionId)?.n ?? 0;
      return {
        handoff: { ...toHandoff(row), status: 'delivered', deliveredAt: at, deliveredVia: via },
        todoRef: refOf(this, todo.boardId, todo.number, todo.id),
        todoTitle: todo.title,
        remaining,
      };
    });
    const claimed = claim();
    if (claimed) {
      this.recordHistory(
        'todo',
        claimed.handoff.todoId,
        claimed.handoff.sessionName ?? claimed.handoff.sessionId,
        'handoff-delivered',
        undefined,
        undefined,
      );
    }
    return claimed;
  }

  /**
   * 대기 중인 요청을 취소한다.
   * @throws 없거나 이미 배달/취소된 건이면.
   */
  cancelHandoff(id: string, actor: string): Handoff {
    const row = this.db.query<HandoffRow, [string]>('SELECT * FROM handoffs WHERE id = ?').get(id);
    if (!row) {
      throw new Error(`handoff not found: ${id}`);
    }
    if (row.status !== 'pending') {
      throw new Error(`handoff is not pending: ${id}`);
    }
    this.db.query("UPDATE handoffs SET status = 'cancelled' WHERE id = ?").run(id);
    this.recordHistory('todo', row.todo_id, actor, 'handoff-cancel', undefined, undefined);
    return { ...toHandoff(row), status: 'cancelled' };
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
    if (filter.excludeActions && filter.excludeActions.length > 0) {
      const placeholders = filter.excludeActions.map(() => '?').join(', ');
      wheres.push(`action NOT IN (${placeholders})`);
      params.push(...filter.excludeActions);
    }
    const whereSql = wheres.length > 0 ? `WHERE ${wheres.join(' AND ')}` : '';
    // limit 은 반드시 마지막에 바인딩한다 — SQL 의 `LIMIT ?` 가 where 절 뒤에 오므로
    // 파라미터 순서도 그에 맞춰야 한다.
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
    // handoff 계열은 뺀다 — A 세션 앞으로 보낸 요청이 B·C 세션의 프롬프트 주입에까지
    // "logan 이 handoff 했다"로 실리면 노이즈다. 배달에는 전용 경로(claimHandoff)가 있다.
    const rows = this.db
      .query<HistoryRow, [number, number]>(
        `SELECT * FROM history
          WHERE id > ?
            AND action NOT IN ('handoff', 'handoff-delivered', 'handoff-cancel', 'handoff-spawn')
          ORDER BY id ASC LIMIT ?`,
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
   * 참조 문자열을 행으로 해석한다. 다섯 분기를 **이 순서로**(계약 — 순서를 바꾸면 아래
   * 서술과 `refs.ts`/`AGENTS.md` 의 분기 설명이 같이 깨진다) 시도한다:
   *   1. 레거시 스코프 `rocky#12` → 그 보드의 12번. 보드를 못 찾으면 `undefined`.
   *   2. 신규 스코프 `rocky-12` → 그 보드의 12번. `note-3` 은 예약 접두사라 board 조회보다
   *      먼저 매칭돼 전역 note 공간의 3번을 가리킨다(`GLOBAL_NOTE_PREFIX`, todos 테이블이면
   *      전역 번호 공간이 없으므로 `undefined`). 그 외에는 보드를 못 찾으면 `undefined`.
   *   3. 맨숫자 `12`/`#12` → `currentBoardId` 의 12번(notes 이고 `currentBoardId` 없으면
   *      전역 note 공간의 12번, todos 는 board context 없이 못 풀리므로 throw).
   *   4. `921gvwnr`(ID_LENGTH 자 base36) → id 정확 일치.
   *   5. 그 외 → 유일한 id prefix.
   *
   * 길이 기준으로 번호와 id 를 가르므로, id 길이를 바꾸면 ID_LENGTH 만 고치면 된다.
   * notes 는 board_id IS NULL 인 전역 행을 가질 수 있어 자체 번호 시퀀스를 갖지만(부분 유니크
   * 인덱스 `idx_notes_number_global`), todos 는 항상 보드에 속하므로 전역 번호 공간이 없다.
   *
   * 두 스코프 분기(1, 2)의 board key 부분은 `sanitizeKey`(`src/actor.ts`)가 만들 수 있는
   * 모든 키를 받아야 한다 — `[a-zA-Z0-9_-]` 를 보존하므로 대문자로 시작하거나(`MyProject`)
   * `_`/`-` 로 시작하는(`_private`) 키도 나올 수 있다. 레거시 분기는 `#` 와 공백만 제외한
   * `[^#\s]+`, 신규 분기는 `\S+` 를 가장 오른쪽 `-` 에서 가른다 — 둘 다 board key 검증
   * 없이 문법만 본다. 이 두 분기는 wildcard 가드(5번, `[%_]` 거부)보다 먼저 매칭돼
   * 빠져나가므로, board 부분에 `%`/`_` 가 섞여도(예: `_private-1`) 그 가드에 걸리지 않고
   * board 조회로 간다 — 가드는 4/5번(id/id-prefix) 분기 전용이다. 신규 분기가 board 를
   * 못 찾았을 때도 4/5번으로 흘려보내지 않고 `undefined` 를 명시적으로 반환한다(위 코드의
   * `return undefined` 참고) — `_` 를 담은 board key(`my_board-1`)가 아래로 흘러가면
   * LIKE 와일드카드 가드에 걸려 레거시 분기(`my_board#1` → `undefined`)와 다른 에러
   * (`invalid id prefix`)를 내는 모순이 생긴다.
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

    // 신규 스코프 표기 `<board>-<number>` (`rocky-12`). `\S+` 가 greedy 라 **가장
    // 오른쪽** `-` 에서 갈린다 — board key 에 `-` 가 흔해서(`rocky-todo`) 왼쪽에서
    // 자르면 존재하지 않는 보드를 찾게 된다. 공백을 배제하는 이유는 위 레거시 분기의
    // `[^#\s]+` 와 같다: 공백 든 레거시 보드는 스코프 참조로 가리킬 수 없고 raw id 로
    // 폴백한다(`refOf` 의 `isRefSafeBoardKey` 게이트).
    //
    // id 분기를 잡아먹지 않는다 — id 는 base36 8자(`ID_ALPHABET`)라 `-` 를 못 담는다.
    const dashed = /^(\S+)-(\d+)$/.exec(trimmed);
    if (dashed?.[1] && dashed[2]) {
      const number = Number(dashed[2]);
      if (dashed[1] === GLOBAL_NOTE_PREFIX) {
        // 예약 접두사가 board 조회보다 먼저다 — `note` 라는 이름의 레거시 보드가
        // 있어도 `note-3` 은 전역 메모를 가리킨다(결정론). 그 보드의 항목은 raw id 로만
        // 가리킬 수 있고, `refOf` 도 그 보드에는 raw id 를 내보낸다.
        if (table !== 'notes') {
          // 전역 todo 번호 공간은 존재하지 않는다 — todos 는 언제나 보드에 속한다.
          return undefined;
        }
        return (
          this.db
            .query<Row, [number]>(`SELECT * FROM ${table} WHERE board_id IS NULL AND number = ?`)
            .get(number) ?? undefined
        );
      }
      const board = this.db
        .query<{ id: string }, [string]>('SELECT id FROM boards WHERE key = ?')
        .get(dashed[1]);
      if (board) {
        return (
          this.db
            .query<Row, [string, number]>(
              `SELECT * FROM ${table} WHERE board_id = ? AND number = ?`,
            )
            .get(board.id, number) ?? undefined
        );
      }
      // 보드를 못 찾으면 여기서 명시적으로 undefined 를 반환한다 — 흘려보내면(과거 코드)
      // board key 에 `_` 가 섞인 흔한 모양(`sanitizeKey` 가 보존하는 문자, `_private` 처럼
      // 실사용 사례가 있다)이 아래 id-prefix 분기의 LIKE 와일드카드 가드에 걸려
      // `invalid id prefix` 로 400 이 난다 — `my_board#1`(레거시 분기, 보드 없으면 바로
      // undefined) 과 `my_board-1`(이 분기)이 다른 에러를 내는 모순이었다. 두 표기가
      // 같은 결과(undefined → 호출부에서 404 `todo not found`)를 내도록 여기서 끊는다.
      return undefined;
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
    repo: row.repo ?? undefined,
    path: row.path ?? undefined,
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

function toComment(row: CommentRow): Comment {
  return {
    id: row.id,
    todoId: row.todo_id,
    actor: row.actor,
    body: row.body,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at ?? undefined,
  };
}

function toHandoff(row: HandoffRow): Handoff {
  return {
    id: row.id,
    todoId: row.todo_id,
    sessionId: row.session_id,
    sessionName: row.session_name ?? undefined,
    sessionCwd: row.session_cwd ?? undefined,
    note: row.note,
    actor: row.actor,
    status: row.status,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at ?? undefined,
    deliveredVia: (row.delivered_via as HandoffVia | null) ?? undefined,
  };
}
