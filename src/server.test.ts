import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTodoServer } from './server';
import { TodoStore } from './store';

let dir: string;
let store: TodoStore;
let handle: (req: Request) => Promise<Response>;

const BASE = 'http://localhost';

function req(path: string, init?: RequestInit & { actor?: string }): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined) {
    headers.set('content-type', 'application/json');
  }
  headers.set('x-rocky-actor', init?.actor ?? 'tester');
  return handle(new Request(`${BASE}${path}`, { ...init, headers }));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rocky-todo-server-'));
  store = new TodoStore({ dbPath: join(dir, 'todo.db') });
  handle = buildTodoServer({ store }).fetch;
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('health', () => {
  test('GET /api/health responds ok', async () => {
    const res = await req('/api/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});

describe('todos REST', () => {
  test('POST /api/todos creates and records actor from header', async () => {
    const res = await req('/api/todos', {
      method: 'POST',
      body: JSON.stringify({ board: 'rocky', title: '작업', labels: ['bug'] }),
      actor: 'claude-code',
    });
    expect(res.status).toBe(201);
    const todo = (await res.json()) as { id: string; title: string };
    expect(todo.title).toBe('작업');

    const history = store.listHistory({ entityId: todo.id });
    expect(history[0]?.actor).toBe('claude-code');
  });

  test('GET /api/todos filters by board/status', async () => {
    await req('/api/todos', { method: 'POST', body: JSON.stringify({ board: 'a', title: 'x' }) });
    await req('/api/todos', { method: 'POST', body: JSON.stringify({ board: 'b', title: 'y' }) });

    const all = (await (await req('/api/todos')).json()) as unknown[];
    expect(all).toHaveLength(2);

    const onlyA = (await (await req('/api/todos?board=a')).json()) as { title: string }[];
    expect(onlyA).toHaveLength(1);
    expect(onlyA[0]?.title).toBe('x');
  });

  test('GET /api/todos/:id returns detail with history', async () => {
    const created = (await (
      await req('/api/todos', { method: 'POST', body: JSON.stringify({ board: 'a', title: 'x' }) })
    ).json()) as { id: string };

    const res = await req(`/api/todos/${created.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { todo: { id: string }; history: { action: string }[] };
    expect(body.todo.id).toBe(created.id);
    expect(body.history[0]?.action).toBe('create');
  });

  test('PATCH /api/todos/:id updates fields', async () => {
    const created = (await (
      await req('/api/todos', { method: 'POST', body: JSON.stringify({ board: 'a', title: 'x' }) })
    ).json()) as { id: string };

    const res = await req(`/api/todos/${created.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ title: 'y', priority: 'p1' }),
      actor: 'logan',
    });
    expect(res.status).toBe(200);
    const todo = (await res.json()) as { title: string; priority: string };
    expect(todo.title).toBe('y');
    expect(todo.priority).toBe('p1');
  });

  test('POST /api/todos/:id/status transitions', async () => {
    const created = (await (
      await req('/api/todos', { method: 'POST', body: JSON.stringify({ board: 'a', title: 'x' }) })
    ).json()) as { id: string };

    const res = await req(`/api/todos/${created.id}/status`, {
      method: 'POST',
      body: JSON.stringify({ action: 'start' }),
      actor: 'codex',
    });
    const todo = (await res.json()) as { status: string; doingBy: string };
    expect(todo.status).toBe('doing');
    expect(todo.doingBy).toBe('codex');
  });

  test('unknown id → 404, unknown action → 400', async () => {
    expect((await req('/api/todos/zzzzzzzz')).status).toBe(404);
    const created = (await (
      await req('/api/todos', { method: 'POST', body: JSON.stringify({ board: 'a', title: 'x' }) })
    ).json()) as { id: string };
    const bad = await req(`/api/todos/${created.id}/status`, {
      method: 'POST',
      body: JSON.stringify({ action: 'explode' }),
    });
    expect(bad.status).toBe(400);
  });

  test('POST /api/todos without title → 400', async () => {
    const res = await req('/api/todos', { method: 'POST', body: JSON.stringify({ board: 'a' }) });
    expect(res.status).toBe(400);
  });
});

describe('notes REST', () => {
  test('create / patch / archive lifecycle', async () => {
    const created = (await (
      await req('/api/notes', {
        method: 'POST',
        body: JSON.stringify({ board: 'a', title: '메모', content: '내용' }),
      })
    ).json()) as { id: string };

    const patched = (await (
      await req(`/api/notes/${created.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ content: '추가', mode: 'append' }),
        actor: 'logan',
      })
    ).json()) as { content: string };
    expect(patched.content).toBe('내용\n추가');

    const archived = await req(`/api/notes/${created.id}/archive`, { method: 'POST' });
    expect(archived.status).toBe(200);

    const listed = (await (await req('/api/notes?board=a')).json()) as unknown[];
    expect(listed).toHaveLength(0);
  });
});

describe('boards & sections REST', () => {
  test('GET /api/boards lists boards; GET /api/sections requires board', async () => {
    await req('/api/todos', {
      method: 'POST',
      body: JSON.stringify({ board: 'a', title: 'x', section: '설계' }),
    });
    const boards = (await (await req('/api/boards')).json()) as { key: string }[];
    expect(boards.map((b) => b.key)).toEqual(['a']);

    const sections = (await (await req('/api/sections?board=a')).json()) as { title: string }[];
    expect(sections.map((s) => s.title)).toEqual(['설계']);

    expect((await req('/api/sections')).status).toBe(400);
  });
});

describe('changes feed', () => {
  test('GET /api/changes returns entries after sinceId with titles', async () => {
    await req('/api/todos', {
      method: 'POST',
      body: JSON.stringify({ board: 'rocky', title: '피드' }),
      actor: 'claude-code',
    });
    const base = (await (await req('/api/changes?sinceId=0')).json()) as { lastId: number };

    const created = (await (
      await req('/api/todos', {
        method: 'POST',
        body: JSON.stringify({ board: 'rocky', title: '로건 추가' }),
        actor: 'logan',
      })
    ).json()) as { id: string };

    const feed = (await (await req(`/api/changes?sinceId=${base.lastId}`)).json()) as {
      lastId: number;
      entries: { entityId: string; actor: string; title: string }[];
    };
    expect(feed.lastId).toBeGreaterThan(base.lastId);
    expect(feed.entries.some((e) => e.entityId === created.id && e.actor === 'logan')).toBe(true);
  });
});

describe('SSE', () => {
  test('GET /api/events streams change events on mutation', async () => {
    const res = await req('/api/events');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    // 첫 chunk 는 연결 확인 코멘트
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain(':');

    store.createTodo({ board: 'rocky', title: 'sse' }, 'tester');
    // 새 보드 자동 생성 시 board:create 가 먼저 흐르므로 todo 이벤트까지 누적해 읽는다
    let text = '';
    while (!text.includes('"entity":"todo"')) {
      const chunk = await reader.read();
      text += new TextDecoder().decode(chunk.value);
    }
    expect(text).toContain('data:');
    expect(text).toContain('"action":"create"');
    await reader.cancel();
  });
});
