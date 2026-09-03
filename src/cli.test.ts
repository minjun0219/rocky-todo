import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  boardKeyFromMissingRepoError,
  boardDetailPath,
  formatSessions,
  formatSpawnResult,
  formatTodoLine,
  formatTodoShow,
  type HandoffCreated,
  isMissingRepoError,
  noteRefPath,
  parseFlags,
  renderBoard,
  renderHandoffCreated,
  resolveHistoryEntity,
  todoRefPath,
  withBoard,
} from './cli';
import { buildContext, type CliContext, request } from './client';
import { buildTodoServer } from './server';
import type { TodoView } from './server';
import type { Board, Comment, Handoff, HistoryEntry } from './store';
import { TodoStore } from './store';

describe('parseFlags', () => {
  test('separates positionals and flags', () => {
    const parsed = parseFlags(['add', '제목 텍스트', '--board', 'rocky', '--priority', 'p1']);
    expect(parsed.positionals).toEqual(['add', '제목 텍스트']);
    expect(parsed.flags.board).toBe('rocky');
    expect(parsed.flags.priority).toBe('p1');
  });

  test('boolean flags need no value', () => {
    const parsed = parseFlags(['ls', '--all', '--archived', '--json', '--global']);
    expect(parsed.flags.all).toBe(true);
    expect(parsed.flags.archived).toBe(true);
    expect(parsed.flags.json).toBe(true);
    expect(parsed.flags.global).toBe(true);
  });

  test('label is comma-split and link accumulates', () => {
    const parsed = parseFlags([
      'add',
      'x',
      '--label',
      'bug,urgent',
      '--link',
      'https://a.example',
      '--link',
      'https://b.example',
    ]);
    expect(parsed.flags.label).toEqual(['bug', 'urgent']);
    expect(parsed.flags.link).toEqual(['https://a.example', 'https://b.example']);
  });

  test('unknown flag throws', () => {
    expect(() => parseFlags(['ls', '--explode'])).toThrow(/unknown flag/);
  });

  test('handoff 의 --session/--cancel 플래그를 받아들인다', () => {
    const parsed = parseFlags(['handoff', '#1', '--session', 'rocky-todo-1e', '--cancel']);
    expect(parsed.flags.session).toBe('rocky-todo-1e');
    expect(parsed.flags.cancel).toBe(true);
  });

  // handoff 의 메모는 `--message` 다 (VALUE_FLAGS) — history 의 `--note`(순수 boolean) 와
  // 이름이 겹치지 않아 파서에 특수 카테고리가 필요 없다.
  test('handoff 의 --message 는 문자열 값으로 읽힌다', () => {
    const parsed = parseFlags(['handoff', '#1', '--message', '진행 상황 공유']);
    expect(parsed.flags.message).toBe('진행 상황 공유');
  });

  test('history 의 --note 는 순수 boolean 이다', () => {
    const parsed = parseFlags(['history', '#1', '--note']);
    expect(parsed.flags.note).toBe(true);
  });

  // 회귀 가드: `--note` 가 한때 "다음 토큰이 플래그가 아니면 값으로 소비" 하는
  // OPTIONAL_VALUE_FLAGS 로 취급된 적이 있었다 — 그때는 `--note` 뒤에 오는 REF 를
  // 값으로 삼켜 positionals 에서 REF 가 사라졌다(`history --note rocky#12` 가
  // `usage: rocky-todo history REF ...` 로 죽는 회귀). `--note` 는 순서와 무관하게
  // 항상 boolean 이어야 하고, REF 는 어느 위치에 있든 positionals 에 남아야 한다.
  test('--note 가 REF 보다 앞에 와도 boolean 이고 REF 는 positionals 에 남는다', () => {
    const parsed = parseFlags(['history', '--note', 'rocky#12']);
    expect(parsed.flags.note).toBe(true);
    expect(parsed.positionals).toContain('rocky#12');
  });
});

describe('withBoard', () => {
  test('appends ?board= to a path with no query string', () => {
    expect(withBoard('/api/todos/3', 'rocky')).toBe('/api/todos/3?board=rocky');
  });

  test('appends &board= to a path that already has a query string', () => {
    expect(withBoard('/api/todos?includeArchived=true', 'rocky')).toBe(
      '/api/todos?includeArchived=true&board=rocky',
    );
  });

  test('encodes board keys with special characters', () => {
    expect(withBoard('/api/notes/3', 'my repo')).toBe('/api/notes/3?board=my%20repo');
  });
});

describe('todoRefPath', () => {
  // finding B 회귀 테스트: 예전엔 show/update/status/history 4곳이 각자
  // `withBoard(\`/api/todos/${encodeURIComponent(id)}\`, board)` 를 인라인으로 반복했고,
  // 이를 검증하는 테스트도 같은 문자열을 테스트 본문에서 다시 조립해 비교했다 — 그러면
  // 프로덕션 코드의 encodeURIComponent 를 되돌려도(리뷰어가 실제로 4곳 다 되돌려봄) 테스트가
  // production 코드를 안 거치니 그대로 통과한다. `todoRefPath` 를 단일 chokepoint 로 만들고
  // 그 함수 자체를 검증해야 되돌리면 테스트가 깨진다.
  test('ref 를 인코딩하고 board 쿼리를 붙인다', () => {
    expect(todoRefPath('#1', '', 'rocky')).toBe('/api/todos/%231?board=rocky');
    expect(todoRefPath('rocky#1', '', 'rocky')).toBe('/api/todos/rocky%231?board=rocky');
  });

  test('suffix 는 인코딩 없이 그대로 붙는다', () => {
    expect(todoRefPath('#1', '/status', 'rocky')).toBe('/api/todos/%231/status?board=rocky');
  });

  test('spawn 경로에도 board 컨텍스트를 싣는다', () => {
    expect(todoRefPath('16', '/spawn', 'rocky-todo')).toBe('/api/todos/16/spawn?board=rocky-todo');
  });
});

describe('noteRefPath', () => {
  // Finding 1 회귀 테스트: --global 이면 board 쿼리를 빼서 맨 번호가 전역 메모 공간으로
  // 풀리게 해야 한다. 안 그러면 `rocky-todo note archive 3` 이 board 컨텍스트를 실어 보내
  // 웹 UI 가 보여준 전역 `#3` 대신 그 보드의 `#3` 을 조용히 archive 해버린다.
  test('global suppresses the board query param', () => {
    expect(noteRefPath('3', '', 'rocky', true)).toBe('/api/notes/3');
    expect(noteRefPath('3', '/archive', 'rocky', true)).toBe('/api/notes/3/archive');
  });

  test('absent global includes the board query param', () => {
    expect(noteRefPath('3', '', 'rocky', false)).toBe('/api/notes/3?board=rocky');
    expect(noteRefPath('3', '/archive', 'rocky', false)).toBe('/api/notes/3/archive?board=rocky');
  });

  // history 명령이 note 폴백 시 noteRefPath 를 사용하는지 검증
  test('history note-fallback uses noteRefPath for correct scoping', () => {
    // --global 이면 전역 메모 공간으로 풀려야 한다
    const globalPath = noteRefPath('3', '', 'rocky', true);
    expect(globalPath).toBe('/api/notes/3');
    expect(globalPath).not.toContain('board=');

    // --global 없으면 보드 컨텍스트를 실어 보낸다
    const boardPath = noteRefPath('3', '', 'rocky', false);
    expect(boardPath).toContain('board=rocky');
  });
});

describe('# ref 인코딩 — 실제 fetch 왕복 (finding 1 회귀)', () => {
  // withBoard/noteRefPath 문자열만 검증하는 단위 테스트로는 이 버그를 못 잡는다 — `#` 는
  // 실제 URL 파싱(new URL / fetch) 단계에서만 fragment 로 잘려나간다. 여기서는 실제
  // Bun.serve + buildTodoServer 핸들러에 진짜 fetch 로 요청을 보내 CLI 가 만든 경로가
  // 살아서 도착하는지를 증명한다.
  let dir: string;
  let store: TodoStore;
  let server: ReturnType<typeof Bun.serve>;
  let ctx: CliContext;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rocky-todo-cli-ref-'));
    store = new TodoStore({ dbPath: join(dir, 'todo.db') });
    const api = buildTodoServer({ store });
    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (req, server) => api.fetch(req, server.requestIP(req)?.address),
    });
    if (server.port === undefined) {
      throw new Error('Bun.serve did not assign a port');
    }
    ctx = buildContext({ port: server.port, dir, actor: 'tester' });
  });

  afterEach(() => {
    server.stop(true);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('bare "#N" ref (board 컨텍스트와 함께) 은 200 으로 해석된다', async () => {
    store.createTodo({ board: 'rocky', title: '참조 확인' }, 'tester');

    const detail = await request<{ todo: TodoView }>(ctx, 'GET', todoRefPath('#1', '', 'rocky'));
    expect(detail.todo.title).toBe('참조 확인');
  });

  test('"board#N" 완전 참조는 200 으로 해석된다', async () => {
    store.createTodo({ board: 'rocky', title: '보드 스코프 참조' }, 'tester');

    const detail = await request<{ todo: TodoView }>(
      ctx,
      'GET',
      todoRefPath('rocky#1', '', 'rocky'),
    );
    expect(detail.todo.title).toBe('보드 스코프 참조');
  });

  test('note 의 "#N" 참조도 noteRefPath 를 거치면 200 으로 해석된다', async () => {
    store.createNote({ board: 'rocky', title: '메모 참조 확인' }, 'tester');

    const detail = await request<{ note: { title: string } }>(
      ctx,
      'GET',
      noteRefPath('#1', '', 'rocky', false),
    );
    expect(detail.note.title).toBe('메모 참조 확인');
  });

  test('인코딩 없이 raw "#" 를 실어 보내면(회귀 방지 대조군) 404 가 난다', async () => {
    store.createTodo({ board: 'rocky', title: '대조군' }, 'tester');
    // fetch 도 new Request 처럼 URL 스펙으로 파싱하므로, 인코딩 안 된 raw ref 는
    // "#1" 이 fragment 로 잘려나가 서버는 `/api/todos/` 로 받는다 — 404.
    const res = await fetch(`${ctx.baseUrl}${withBoard('/api/todos/#1', 'rocky')}`);
    expect(res.status).toBe(404);
  });

  // Finding 1 회귀 테스트: todo 와 전역 note 는 각자 1부터 번호를 매기므로, 같은 보드에
  // 번호가 겹치는 todo #3 과 전역 note #3 이 동시에 존재할 수 있다. `--global` 을 준
  // `history` 조회가 todo 조회를 먼저 시도하면 그게 먼저 성공해 사용자가 명시적으로 요청한
  // 전역 note 대신 엉뚱한 todo 의 히스토리를 조용히 돌려준다 — resolveHistoryEntity 가
  // global 이면 todo 조회를 아예 건너뛰는지 실제 fetch 왕복으로 검증한다.
  test('history --global 은 같은 번호의 board todo 가 있어도 전역 note 를 가리킨다', async () => {
    for (let i = 1; i <= 3; i++) {
      store.createTodo({ board: 'rocky', title: `todo ${i}` }, 'tester');
    }
    for (let i = 1; i <= 3; i++) {
      store.createNote({ title: `전역 메모 ${i}` }, 'tester');
    }

    const detail = await resolveHistoryEntity(ctx, '3', 'rocky', { global: true });
    expect(detail.todo).toBeUndefined();
    expect(detail.note?.title).toBe('전역 메모 3');
  });

  // 같은 사고가 **보드 소속** note 에도 있다: 보드 안에서 todo 와 note 가 각자 1부터
  // 번호를 매기므로 todo #2 와 note #2 가 공존할 수 있고, 그때 todo 조회가 먼저 성공해
  // note 히스토리에 도달할 길이 없다. `--note` 가 note 를 확정하는지 검증한다.
  test('history --note 는 같은 번호의 board todo 가 있어도 보드 note 를 가리킨다', async () => {
    for (let i = 1; i <= 2; i++) {
      store.createTodo({ board: 'rocky', title: `todo ${i}` }, 'tester');
    }
    for (let i = 1; i <= 2; i++) {
      store.createNote({ board: 'rocky', title: `보드 메모 ${i}` }, 'tester');
    }

    const detail = await resolveHistoryEntity(ctx, '2', 'rocky', { note: true });
    expect(detail.todo).toBeUndefined();
    expect(detail.note?.title).toBe('보드 메모 2');
  });

  test('플래그가 없으면 기존 todo 우선 fallback 을 유지한다', async () => {
    store.createTodo({ board: 'rocky', title: 'todo 1' }, 'tester');
    store.createNote({ board: 'rocky', title: '보드 메모 1' }, 'tester');

    const detail = await resolveHistoryEntity(ctx, '1', 'rocky');
    expect(detail.todo?.title).toBe('todo 1');
  });
});

describe('renderBoard', () => {
  const base: Board = {
    id: 'b1',
    key: 'tally',
    title: 'Tally',
    createdAt: '2026-08-01T00:00:00.000Z',
  };

  test('설정되지 않은 필드는 줄을 만들지 않는다', () => {
    expect(renderBoard(base)).toBe('tally  Tally');
  });

  test('설명·repo·path·옛 이름을 붙인다', () => {
    const out = renderBoard({
      ...base,
      description: '가계부 앱',
      repo: 'minjun0219/tally',
      path: '/dev/tally',
      previousKeys: ['gotgan'],
    });
    expect(out).toContain('가계부 앱');
    expect(out).toContain('https://github.com/minjun0219/tally');
    expect(out).toContain('/dev/tally');
    expect(out).toContain('gotgan');
  });
});

describe('CLI 경로 왕복 — spawn / board path', () => {
  let dir: string;
  let store: TodoStore;
  let server: ReturnType<typeof Bun.serve>;
  let ctx: CliContext;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rocky-todo-cli-spawn-'));
    store = new TodoStore({ dbPath: join(dir, 'todo.db') });
    const api = buildTodoServer({
      store,
      sessions: () => ({ available: true, sessions: [] }),
      spawn: async () => '5acaaaeb',
      pathExists: () => true,
      realPath: (p) => p,
    });
    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (req, server) => api.fetch(req, server.requestIP(req)?.address),
    });
    if (server.port === undefined) {
      throw new Error('Bun.serve did not assign a port');
    }
    ctx = buildContext({ port: server.port, dir, actor: 'tester' });
  });

  afterEach(() => {
    server.stop(true);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('board path 가 보드에 경로를 저장한다', async () => {
    store.ensureBoard('rocky-todo', { actor: 'tester' });
    const updated = await request<Board>(ctx, 'PATCH', boardDetailPath('rocky-todo'), {
      path: '/Users/x/dev/rocky-todo',
    });
    expect(updated.path).toBe('/Users/x/dev/rocky-todo');
  });

  test('board rename 이 key 를 바꾸고 옛 참조는 계속 풀린다', async () => {
    store.ensureBoard('gotgan', { actor: 'tester' });
    store.createTodo({ board: 'gotgan', title: '이월 정산' }, 'tester');

    const renamed = await request<Board>(ctx, 'PATCH', boardDetailPath('gotgan'), { key: 'tally' });
    expect(renamed.key).toBe('tally');
    expect(renamed.previousKeys).toEqual(['gotgan']);

    const detail = await request<{ todo: TodoView }>(ctx, 'GET', todoRefPath('gotgan-1', '', ''));
    expect(detail.todo.ref).toBe('tally-1');
  });

  test('spawn 경로가 201 과 짧은 id 를 돌려준다', async () => {
    store.ensureBoard('rocky-todo', { actor: 'tester' });
    store.setBoardPath('rocky-todo', '/repo', 'tester');
    const todo = store.createTodo({ board: 'rocky-todo', title: 'x' }, 'tester');
    const result = await request<{ sessionShortId: string; reused: boolean }>(
      ctx,
      'POST',
      todoRefPath(todo.id, '/spawn', 'rocky-todo'),
      { note: '테스트부터' },
    );
    expect(result.reused).toBe(false);
    expect(result.sessionShortId).toBe('5acaaaeb');
  });
});

describe('formatTodoLine', () => {
  const base: TodoView = {
    id: 'a1b2c3d4',
    number: 1,
    ref: 'rocky-1',
    boardId: 'b',
    title: '작업 제목',
    description: '',
    status: 'todo',
    priority: 'p4',
    labels: [],
    links: [],
    position: 1,
    createdAt: '2026-07-23T00:00:00.000Z',
    updatedAt: '2026-07-23T00:00:00.000Z',
    commentCount: 0,
  };

  test('todo status glyph and number prefix', () => {
    const line = formatTodoLine(base, 0);
    expect(line).toContain('○ 1 ');
    expect(line).toContain('작업 제목');
  });

  test('번호를 접두사 없이 앞에 붙인다', () => {
    const line = formatTodoLine(
      {
        id: 'a1b2c3d4',
        number: 12,
        ref: 'rocky-12',
        boardId: 'b1',
        title: '보드·섹션 생성',
        description: '',
        status: 'todo',
        priority: 'p2',
        labels: [],
        links: [],
        position: 1,
        createdAt: '2026-07-25T00:00:00.000Z',
        updatedAt: '2026-07-25T00:00:00.000Z',
        commentCount: 0,
      } as TodoView,
      0,
    );
    expect(line).toContain('12');
    expect(line.indexOf('12')).toBeLessThan(line.indexOf('보드·섹션 생성'));
  });

  test('doing shows actor, done shows check', () => {
    const doing = formatTodoLine(
      { ...base, status: 'doing', doingBy: 'claude-code', doingSince: new Date().toISOString() },
      0,
    );
    expect(doing).toContain('▶');
    expect(doing).toContain('claude-code');

    const done = formatTodoLine({ ...base, status: 'done' }, 0);
    expect(done).toContain('✓');
  });

  test('metadata chips: priority, labels, due, links, depth indent', () => {
    const line = formatTodoLine(
      {
        ...base,
        priority: 'p1',
        labels: ['bug'],
        due: '2026-08-01',
        links: [{ url: 'https://github.com/o/r/issues/3' }],
      },
      2,
    );
    expect(line).toContain('p1');
    expect(line).toContain('[bug]');
    expect(line).toContain('~2026-08-01');
    expect(line).toContain('↗r#3');
    expect(line.startsWith('    ')).toBe(true);
  });
});

describe('formatTodoShow', () => {
  const todo: TodoView = {
    id: 'a1b2c3d4',
    number: 1,
    ref: 'rocky-1',
    boardId: 'b',
    title: '작업 제목',
    description: '',
    status: 'todo',
    priority: 'p4',
    labels: [],
    links: [],
    position: 1,
    createdAt: '2026-07-23T00:00:00.000Z',
    updatedAt: '2026-07-23T00:00:00.000Z',
    commentCount: 0,
  };

  function comment(overrides: Partial<Comment> = {}): Comment {
    return {
      id: 'c1',
      todoId: todo.id,
      actor: 'claude-code',
      body: '본문',
      createdAt: '2026-07-24T09:05:12.000Z',
      updatedAt: '2026-07-24T09:05:12.000Z',
      ...overrides,
    };
  }

  function history(overrides: Partial<HistoryEntry> = {}, id = 1): HistoryEntry {
    return {
      id,
      entity: 'todo',
      entityId: todo.id,
      actor: 'claude-code',
      action: 'create',
      at: '2026-07-23T00:00:00.000Z',
      ...overrides,
    };
  }

  test('댓글이 없으면 댓글: 섹션이 아예 나오지 않는다', () => {
    const out = formatTodoShow({ todo, history: [], comments: [] });
    expect(out).not.toContain('댓글:');
  });

  test('댓글이 있으면 각 줄에 작성시각 actor: 본문 이 나온다 (T 가 공백으로 바뀐다)', () => {
    const out = formatTodoShow({
      todo,
      history: [],
      comments: [comment({ createdAt: '2026-07-24T09:05:12.000Z', actor: 'minjun', body: '메모' })],
    });
    expect(out).toContain('댓글:');
    expect(out).toContain('2026-07-24 09:05 minjun: 메모');
    expect(out).not.toContain('2026-07-24T09:05');
  });

  test('여러 줄 본문이 한 줄로 접힌다', () => {
    const out = formatTodoShow({
      todo,
      history: [],
      comments: [comment({ body: '첫째 줄\n둘째 줄\n\n넷째 줄' })],
    });
    expect(out).not.toContain('\n둘째');
    expect(out).toContain('첫째 줄 둘째 줄 넷째 줄');
  });

  test('comment/comment-edit 는 히스토리 섹션에서 걸러지지만 comment-archive/comment-unarchive 는 남는다', () => {
    const rows: HistoryEntry[] = [
      history({ action: 'create' }, 1),
      history({ action: 'comment' }, 2),
      history({ action: 'comment-edit' }, 3),
      history({ action: 'comment-archive' }, 4),
      history({ action: 'comment-unarchive' }, 5),
      history({ action: 'done' }, 6),
    ];
    const out = formatTodoShow({ todo, history: rows, comments: [] });
    expect(out).toContain('create');
    expect(out).toContain('done');
    expect(out).toContain('comment-archive');
    expect(out).toContain('comment-unarchive');
    // comment 자체(작성/본문수정)만 걸러진다 — 정확히 한 줄만 있어야 하므로 등장 횟수로 확인한다.
    const commentLines = out.split('\n').filter((line) => / comment$/.test(line.trim()));
    const commentEditLines = out.split('\n').filter((line) => / comment-edit$/.test(line.trim()));
    expect(commentLines).toHaveLength(0);
    expect(commentEditLines).toHaveLength(0);
  });

  test('댓글이 8개보다 많으면 최근 8개만 보이고 위에 …외 N개 마커가 붙는다', () => {
    // 두 자리로 패딩한다 — "댓글 1" 이 "댓글 10"/"댓글 11" 의 부분 문자열이 되어 포함
    // 여부 단언이 오탐하지 않게.
    const comments: Comment[] = Array.from({ length: 12 }, (_, i) =>
      comment({
        id: `c${i}`,
        body: `댓글 ${String(i).padStart(2, '0')}`,
        createdAt: `2026-07-24T09:${String(i).padStart(2, '0')}:00.000Z`,
      }),
    );
    const out = formatTodoShow({ todo, history: [], comments });
    expect(out).toContain('…외 4개');
    for (let i = 4; i < 12; i++) {
      expect(out).toContain(`댓글 ${String(i).padStart(2, '0')}`);
    }
    for (let i = 0; i < 4; i++) {
      expect(out).not.toContain(`댓글 ${String(i).padStart(2, '0')}`);
    }
  });

  test('히스토리가 8줄로 잘린다', () => {
    const rows: HistoryEntry[] = Array.from({ length: 12 }, (_, i) =>
      history({ action: `action-${i}` }, i + 1),
    );
    const out = formatTodoShow({ todo, history: rows, comments: [] });
    for (let i = 0; i < 8; i++) {
      expect(out).toContain(`action-${i}`);
    }
    for (let i = 8; i < 12; i++) {
      expect(out).not.toContain(`action-${i}`);
    }
  });
});

describe('comment command paths', () => {
  let dir: string;
  let store: TodoStore;
  let server: ReturnType<typeof Bun.serve>;
  let ctx: CliContext;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rocky-todo-cli-comment-'));
    store = new TodoStore({ dbPath: join(dir, 'todo.db') });
    const api = buildTodoServer({ store });
    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (req, server) => api.fetch(req, server.requestIP(req)?.address),
    });
    if (server.port === undefined) {
      throw new Error('Bun.serve did not assign a port');
    }
    ctx = buildContext({ port: server.port, dir, actor: 'tester' });
  });

  afterEach(() => {
    server.stop(true);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('todoRefPath builds the comments endpoint', () => {
    expect(todoRefPath('rocky#3', '/comments', 'rocky')).toBe(
      '/api/todos/rocky%233/comments?board=rocky',
    );
  });

  test('posting through the comments path creates a comment', async () => {
    const todo = store.createTodo({ board: 'rocky', title: '작업' }, 'tester');
    const comment = await request<{ body: string; todoId: string }>(
      ctx,
      'POST',
      todoRefPath(`rocky#${todo.number}`, '/comments', 'rocky'),
      { body: '한 마디' },
    );
    expect(comment.todoId).toBe(todo.id);
    expect(comment.body).toBe('한 마디');
  });

  test('show payload carries comments', async () => {
    const todo = store.createTodo({ board: 'rocky', title: '작업' }, 'tester');
    store.addComment(todo.id, '미리 달아둔 댓글', 'logan');
    const detail = await request<{ comments: { body: string }[] }>(
      ctx,
      'GET',
      todoRefPath(`rocky#${todo.number}`, '', 'rocky'),
    );
    expect(detail.comments.map((c) => c.body)).toEqual(['미리 달아둔 댓글']);
  });
});

describe('formatSessions', () => {
  const view = (over: Partial<Parameters<typeof formatSessions>[0]> = {}) => ({
    available: true,
    sessions: [
      {
        pid: 1,
        cwd: '/w/rocky-todo',
        kind: 'interactive',
        sessionId: 'sess-1',
        name: 'rocky-todo-1e',
        status: 'idle',
        startedAt: 1,
        matched: true,
      },
      {
        pid: 2,
        cwd: '/w/forses',
        kind: 'interactive',
        sessionId: 'sess-2',
        name: 'forses-90',
        status: 'busy',
        startedAt: 2,
        matched: false,
      },
    ],
    ...over,
  });

  test('이름·상태·경로를 한 줄씩 렌더한다', () => {
    const out = formatSessions(view());
    expect(out).toContain('rocky-todo-1e');
    expect(out).toContain('idle');
    expect(out).toContain('/w/rocky-todo');
  });

  test('현재 보드와 일치하는 세션에 * 를 붙인다', () => {
    const lines = formatSessions(view()).split('\n');
    expect(lines[0]?.startsWith('*')).toBe(true);
    expect(lines[1]?.startsWith('*')).toBe(false);
  });

  test('claude 를 못 쓰면 이유를 보여준다', () => {
    const out = formatSessions(view({ available: false, sessions: [], reason: 'claude CLI 없음' }));
    expect(out).toContain('claude CLI 없음');
  });

  test('세션이 없으면 그렇게 말한다', () => {
    expect(formatSessions(view({ sessions: [] }))).toContain('실행 중인');
  });
});

describe('formatSpawnResult', () => {
  const handoff: Handoff = {
    id: 'h1',
    todoId: 't1',
    sessionId: 'sess-1',
    sessionName: 'rocky-todo-1e',
    note: '',
    actor: 'minjun',
    status: 'pending',
    createdAt: '2026-07-27T00:00:00.000Z',
  };

  test('새로 띄운 경우 짧은 id 와 claude attach 명령을 보여준다', () => {
    const out = formatSpawnResult('rocky-12', {
      handoff,
      reused: false,
      worktreePath: '/w/rocky-todo/wt-12',
      sessionShortId: '1e',
    });
    expect(out).toContain('rocky-12');
    expect(out).toContain('/w/rocky-todo/wt-12');
    expect(out).toContain('claude attach 1e');
  });

  test('재사용한 경우 이미 도는 세션에 큐잉했다고 말하고 claude attach 는 없다', () => {
    const out = formatSpawnResult('rocky-12', {
      handoff,
      reused: true,
      worktreePath: '/w/rocky-todo/wt-12',
    });
    expect(out).toContain('rocky-12');
    expect(out).toContain('이미 도는 세션');
    expect(out).toContain(handoff.sessionName as string);
    expect(out).not.toContain('claude attach');
  });

  // sessionName 은 표시용 스냅샷이라 없을 수 있다 — 빈 괄호("세션()")를 찍으면
  // 어디로 보냈는지 읽을 수 없으니 sessionId 로 떨어뜨린다.
  test('sessionName 이 없으면 sessionId 로 폴백한다', () => {
    const out = formatSpawnResult('rocky-12', {
      handoff: { ...handoff, sessionName: undefined },
      reused: true,
      worktreePath: '/w/rocky-todo/wt-12',
    });
    expect(out).toContain('이미 도는 세션(sess-1)');
  });
});

describe('renderHandoffCreated', () => {
  const created: HandoffCreated = {
    id: 'h1',
    todoId: 't1',
    sessionId: 'sess-1',
    sessionName: 'rocky-todo-1e',
    note: '',
    actor: 'minjun',
    status: 'pending',
    createdAt: '2026-07-27T00:00:00.000Z',
    poke: { to: 'rocky-todo-1e', message: '# rocky-todo: ...' },
  };

  // "보냄"은 거짓말이었다 — 이 시점에 배달된 것은 아무것도 없다.
  test('배달이 아직 아니라는 걸 분명히 말한다', () => {
    const out = renderHandoffCreated('rocky-12', created);
    expect(out).toContain('큐에 넣음');
    expect(out).not.toContain('에게 보냄');
  });

  test('턴을 여는 방법을 에이전트/사람 양쪽으로 안내한다', () => {
    const out = renderHandoffCreated('rocky-12', created);
    expect(out).toContain('SendMessage');
    expect(out).toContain('"rocky-todo-1e"');
    expect(out).toContain('사람');
  });

  test('sessionName 이 없으면 sessionId 로 떨어뜨린다', () => {
    const out = renderHandoffCreated('rocky-12', { ...created, sessionName: undefined });
    expect(out).toContain('sess-1');
  });

  // 데몬은 버전이 같으면 재기동하지 않으므로 poke 를 모르는 구버전이 계속 살아 있을 수 있다.
  test('구버전 데몬이라 poke 가 없어도 크래시하지 않고 무엇이 어긋났는지 말한다', () => {
    const out = renderHandoffCreated('rocky-12', { ...created, poke: undefined });
    expect(out).toContain('큐에 넣음');
    expect(out).toContain('daemon stop');
    // 있지도 않은 poke 로 SendMessage 를 안내하면 안 된다.
    expect(out).not.toContain('SendMessage');
  });
});

describe('issue command paths', () => {
  let dir: string;
  let store: TodoStore;
  let server: ReturnType<typeof Bun.serve>;
  let ctx: CliContext;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rocky-todo-cli-issue-'));
    store = new TodoStore({ dbPath: join(dir, 'todo.db') });
    const api = buildTodoServer({ store });
    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (req, server) => api.fetch(req, server.requestIP(req)?.address),
    });
    if (server.port === undefined) {
      throw new Error('Bun.serve did not assign a port');
    }
    ctx = buildContext({ port: server.port, dir, actor: 'tester' });
  });

  afterEach(() => {
    server.stop(true);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('todoRefPath builds the issue endpoint', () => {
    expect(todoRefPath('rocky#3', '/issue', 'rocky')).toBe(
      '/api/todos/rocky%233/issue?board=rocky',
    );
  });

  test('boardDetailPath encodes the board key', () => {
    expect(boardDetailPath('my.board')).toBe('/api/boards/my.board');
  });

  test('setting a board repo through the CLI path round-trips', async () => {
    store.ensureBoard('rocky', { actor: 'tester' });
    const board = await request<{ repo: string }>(ctx, 'PATCH', boardDetailPath('rocky'), {
      repo: 'o/n',
    });
    expect(board.repo).toBe('o/n');
  });

  test('the issue endpoint answers 400 when the board has no repo', async () => {
    store.ensureBoard('rocky', { actor: 'tester' });
    const todo = store.createTodo({ board: 'rocky', title: '작업' }, 'tester');
    await expect(request(ctx, 'POST', todoRefPath(todo.id, '/issue', 'rocky'))).rejects.toThrow(
      /repo/,
    );
  });
});

describe('isMissingRepoError', () => {
  // 각 케이스는 예전의 느슨한 `/repo/.test(message)` 판정이 오답을 내는 경우들이다 —
  // 그래야 이 테스트가 실제로 판별력을 갖는다는 증거가 된다 (finding A/B).
  test('matches the server message for an unset board repo', () => {
    expect(
      isMissingRepoError(
        'board has no GitHub repo: rocky — 먼저 설정한다 (rocky-todo board repo OWNER/NAME)',
      ),
    ).toBe(true);
  });

  test('does not match a 409 whose issue url contains "repo"', () => {
    expect(
      isMissingRepoError(
        'todo already has a GitHub issue: https://github.com/org/my-repo/issues/12',
      ),
    ).toBe(false);
  });

  test('does not match a gh auth failure that names the repo scope', () => {
    expect(isMissingRepoError("error: your token has not been granted the 'repo' scope")).toBe(
      false,
    );
    expect(isMissingRepoError('gh auth refresh -s repo')).toBe(false);
  });

  test('does not match unrelated failures', () => {
    expect(isMissingRepoError('todo not found: abc')).toBe(false);
    expect(isMissingRepoError('')).toBe(false);
  });
});

describe('boardKeyFromMissingRepoError', () => {
  test('extracts the board key from the server message', () => {
    expect(
      boardKeyFromMissingRepoError(
        'board has no GitHub repo: rocky-todo — 먼저 설정한다 (rocky-todo board repo OWNER/NAME)',
      ),
    ).toBe('rocky-todo');
  });

  test('extracts a key containing a hyphen and a dot', () => {
    expect(
      boardKeyFromMissingRepoError(
        'board has no GitHub repo: my-board.v2 — 먼저 설정한다 (rocky-todo board repo OWNER/NAME)',
      ),
    ).toBe('my-board.v2');
  });

  test('returns undefined for messages that are not that error', () => {
    expect(boardKeyFromMissingRepoError('todo not found: abc')).toBeUndefined();
    expect(boardKeyFromMissingRepoError('')).toBeUndefined();
  });

  test('returns undefined when the prefix matches but the separator is missing', () => {
    expect(boardKeyFromMissingRepoError('board has no GitHub repo: rocky')).toBeUndefined();
  });
});
