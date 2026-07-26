import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  formatTodoLine,
  formatTodoShow,
  noteRefPath,
  parseFlags,
  resolveHistoryEntity,
  todoRefPath,
  withBoard,
} from './cli';
import { buildContext, type CliContext, request } from './client';
import { buildTodoServer } from './server';
import type { TodoView } from './server';
import type { Comment, HistoryEntry } from './store';
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
    server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: (req) => api.fetch(req) });
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

describe('formatTodoLine', () => {
  const base: TodoView = {
    id: 'a1b2c3d4',
    number: 1,
    ref: 'rocky#1',
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
    expect(line).toContain('○');
    expect(line).toContain('#1');
    expect(line).toContain('작업 제목');
  });

  test('번호를 #N 으로 앞에 붙인다', () => {
    const line = formatTodoLine(
      {
        id: 'a1b2c3d4',
        number: 12,
        ref: 'rocky#12',
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
    expect(line).toContain('#12');
    expect(line.indexOf('#12')).toBeLessThan(line.indexOf('보드·섹션 생성'));
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
    ref: 'rocky#1',
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

  test('comment 계열 히스토리 액션이 히스토리 섹션에서 걸러진다', () => {
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
    expect(out).not.toContain('comment');
    expect(out).not.toContain('comment-edit');
    expect(out).not.toContain('comment-archive');
    expect(out).not.toContain('comment-unarchive');
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
    server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: (req) => api.fetch(req) });
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

describe('bin/rocky-todo entry', () => {
  // bin/ 은 확장자가 없어 tsc(include: src/hooks/scripts)·biome 어느 쪽도 검사하지
  // 않는다. 진입점이 실제로 로드되는지는 이 스모크만 보장한다 — `help` 는 데몬을
  // 건드리지 않으므로 부작용 없이 import 체인 전체를 태울 수 있다.
  test('help runs without touching the daemon', () => {
    const binPath = join(import.meta.dir, '..', 'bin', 'rocky-todo');
    const proc = Bun.spawnSync({ cmd: [binPath, 'help'], stdout: 'pipe', stderr: 'pipe' });
    const stderr = proc.stderr.toString();
    expect(stderr).toBe('');
    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.toString()).toContain('rocky-todo');
  });
});
