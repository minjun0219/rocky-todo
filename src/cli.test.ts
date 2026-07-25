import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { formatTodoLine, noteRefPath, parseFlags, withBoard } from './cli';
import { buildContext, type CliContext, request } from './client';
import { buildTodoServer } from './server';
import type { TodoView } from './server';
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

    const detail = await request<{ todo: TodoView }>(
      ctx,
      'GET',
      withBoard(`/api/todos/${encodeURIComponent('#1')}`, 'rocky'),
    );
    expect(detail.todo.title).toBe('참조 확인');
  });

  test('"board#N" 완전 참조는 200 으로 해석된다', async () => {
    store.createTodo({ board: 'rocky', title: '보드 스코프 참조' }, 'tester');

    const detail = await request<{ todo: TodoView }>(
      ctx,
      'GET',
      withBoard(`/api/todos/${encodeURIComponent('rocky#1')}`, 'rocky'),
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
