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

/**
 * id prefix 테스트용 — 알파벳이 하나 이상 들어간 prefix 를 고른다.
 *
 * id 는 base36 이라 앞 4자가 전부 숫자일 확률이 약 1.15% 다. 그런 prefix 는 설계대로
 * "번호"로 해석되므로(맨숫자 분기) prefix 조회 테스트가 확률적으로 깨진다. 알파벳이
 * 나오는 지점까지 늘려 그 분기를 확실히 피한다 — 전부 숫자면 id 전체(정확 일치).
 */
function idPrefix(id: string): string {
  const at = id.search(/[a-z]/);
  return at === -1 ? id : id.slice(0, Math.max(4, at + 1));
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

  test('reports the running code version so callers can detect a stale daemon', async () => {
    const res = await req('/api/health');
    const body = (await res.json()) as { name: string; version: string };
    expect(body.name).toBe('rocky-todo');
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
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

  // 빈 섹션 생성 경로 — 기존에는 todo 를 만들 때 `section` 이름으로 upsert 되는 길뿐이라
  // 항목 없이 섹션만 먼저 둘 수 없었다. CLI/에이전트가 이 라우트를 쓴다.
  test('POST /api/sections 는 빈 섹션을 만든다', async () => {
    await req('/api/boards', { method: 'POST', body: JSON.stringify({ key: 'a' }) });
    const res = await req('/api/sections', {
      method: 'POST',
      body: JSON.stringify({ board: 'a', title: '설계' }),
    });
    expect(res.status).toBe(201);
    const section = (await res.json()) as { id: string; title: string; boardId: string };
    expect(section.title).toBe('설계');

    const listed = (await (await req('/api/sections?board=a')).json()) as { title: string }[];
    expect(listed.map((s) => s.title)).toEqual(['설계']);
  });

  test('POST /api/sections 는 같은 이름을 두 번 만들지 않는다 (upsert)', async () => {
    await req('/api/boards', { method: 'POST', body: JSON.stringify({ key: 'a' }) });
    const first = (await (
      await req('/api/sections', {
        method: 'POST',
        body: JSON.stringify({ board: 'a', title: '설계' }),
      })
    ).json()) as { id: string };
    const second = (await (
      await req('/api/sections', {
        method: 'POST',
        body: JSON.stringify({ board: 'a', title: '설계' }),
      })
    ).json()) as { id: string };
    expect(second.id).toBe(first.id);

    const listed = (await (await req('/api/sections?board=a')).json()) as unknown[];
    expect(listed).toHaveLength(1);
  });

  test('POST /api/sections 는 board/title 이 없으면 400', async () => {
    expect(
      (await req('/api/sections', { method: 'POST', body: JSON.stringify({ title: '설계' }) }))
        .status,
    ).toBe(400);
    expect(
      (await req('/api/sections', { method: 'POST', body: JSON.stringify({ board: 'a' }) })).status,
    ).toBe(400);
    expect(
      (
        await req('/api/sections', {
          method: 'POST',
          body: JSON.stringify({ board: 'a', title: '  ' }),
        })
      ).status,
    ).toBe(400);
  });

  test('POST /api/sections/:id/archive 는 섹션을 보관하고 항목을 미분류로 돌린다', async () => {
    const todo = (await (
      await req('/api/todos', {
        method: 'POST',
        body: JSON.stringify({ board: 'a', title: 'x', section: '설계' }),
      })
    ).json()) as { id: string; sectionId: string };

    const res = await req(`/api/sections/${todo.sectionId}/archive`, { method: 'POST' });
    expect(res.status).toBe(200);

    const listed = (await (await req('/api/sections?board=a')).json()) as unknown[];
    expect(listed).toHaveLength(0);

    const detail = (await (await req(`/api/todos/${todo.id}`)).json()) as {
      todo: { sectionId?: string };
    };
    expect(detail.todo.sectionId).toBeUndefined();
  });

  // UI 가 이 에러 메시지를 그대로 사용자에게 보여주므로 상태코드·문구를 고정해 둔다.
  test('POST /api/sections 는 없는 보드에 404 (빈 보드를 만들지 않는다)', async () => {
    const res = await req('/api/sections', {
      method: 'POST',
      body: JSON.stringify({ board: 'nope', title: '설계' }),
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toContain('board not found');

    // 보드가 조용히 만들어지지 않았는지 — ensureBoard 를 쓰면 여기서 새 보드가 생긴다.
    const boards = (await (await req('/api/boards')).json()) as { key: string }[];
    expect(boards.map((b) => b.key)).not.toContain('nope');
  });

  test('POST /api/sections/:id/archive 는 없는 섹션에 404', async () => {
    expect((await req('/api/sections/zzzzzzzz/archive', { method: 'POST' })).status).toBe(404);
  });

  // 보드 key 규칙(공백·# 금지)은 파싱 가능한 ref 를 보장하려고 둔 것이다. UI 가 이 에러를
  // 사용자에게 보여줘야 하므로, 서버가 400 으로 분명히 거절하는지 고정한다.
  test('POST /api/boards 는 참조에 쓸 수 없는 key 를 400 으로 거절한다', async () => {
    for (const key of ['my repo', 'a#b', '']) {
      const res = await req('/api/boards', { method: 'POST', body: JSON.stringify({ key }) });
      expect(res.status).toBe(400);
    }
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

describe('number / ref 직렬화', () => {
  test('todo 응답에 number 와 ref 가 실린다', async () => {
    const created = await req('/api/todos', {
      method: 'POST',
      body: JSON.stringify({ board: 'rocky', title: '번호 확인' }),
    });
    const todo = (await created.json()) as { number: number; ref: string };
    expect(todo.number).toBe(1);
    expect(todo.ref).toBe('rocky#1');
  });

  test('번호 참조로 조회된다', async () => {
    await req('/api/todos', {
      method: 'POST',
      body: JSON.stringify({ board: 'rocky', title: '번호 확인' }),
    });
    const res = await req('/api/todos/rocky%231');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { todo: { title: string; ref: string } };
    expect(body.todo.title).toBe('번호 확인');
    expect(body.todo.ref).toBe('rocky#1');
  });

  test('GET /api/todos 목록도 각 항목에 ref 를 싣는다', async () => {
    await req('/api/todos', {
      method: 'POST',
      body: JSON.stringify({ board: 'rocky', title: '목록 확인' }),
    });
    const list = (await (await req('/api/todos?board=rocky')).json()) as { ref: string }[];
    expect(list[0]?.ref).toBe('rocky#1');
  });

  test('노트 응답에도 number 와 ref 가 실린다 (보드 소속 / 글로벌)', async () => {
    const boardNote = (await (
      await req('/api/notes', {
        method: 'POST',
        body: JSON.stringify({ board: 'rocky', title: '보드 메모' }),
      })
    ).json()) as { number: number; ref: string };
    expect(boardNote.ref).toBe('rocky#1');

    const globalNote = (await (
      await req('/api/notes', { method: 'POST', body: JSON.stringify({ title: '글로벌 메모' }) })
    ).json()) as { number: number; ref: string };
    expect(globalNote.ref).toBe('#1');
  });

  test('보드 컨텍스트 없이 맨숫자 참조를 조회하면 500 이 아닌 4xx 를 반환한다', async () => {
    await req('/api/todos', {
      method: 'POST',
      body: JSON.stringify({ board: 'rocky', title: '번호 확인' }),
    });
    const res = await req('/api/todos/1');
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  test('?board= 로 보드 스코프를 주면 맨숫자 참조가 해석된다', async () => {
    await req('/api/todos', {
      method: 'POST',
      body: JSON.stringify({ board: 'rocky', title: '번호 확인' }),
    });
    const res = await req('/api/todos/1?board=rocky');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { todo: { ref: string } };
    expect(body.todo.ref).toBe('rocky#1');
  });

  // finding C: `?board=` 가 알려지지 않은 키로 안 풀리면(오타 등) currentBoardIdOf 가
  // undefined 로 조용히 폴백해선 안 된다 — todos 는 우연히(board context required) 에러가
  // 났지만, notes 는 폴백이 "board 를 아예 안 준 것"과 같아져 맨숫자가 전역 메모 번호
  // 공간으로 조용히 풀렸다. board 를 줬는데 못 찾으면 무조건 4xx.
  test('?board= 가 알 수 없는 키면 note 참조가 전역 메모로 조용히 풀리지 않고 에러다', async () => {
    const created = (await (
      await req('/api/notes', { method: 'POST', body: JSON.stringify({ title: '전역 메모' }) })
    ).json()) as { number: number };
    expect(created.number).toBe(1);

    const res = await req(`/api/notes/${created.number}?board=typo-board`);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  // finding: 위 가드가 ref 를 보기도 전에 걸려 있었다 — CLI 가 모든 단건 라우트에
  // cwd 로 유추한 `?board=` 를 무조건 붙이는데, 보드는 지연 생성(add/section add/
  // board add 만 만든다)이라 흔히 아직 없는 키가 실린다. `rocky#1`/raw id/id-prefix
  // 처럼 board 컨텍스트를 아예 안 쓰는 ref 는 안 풀리는 `?board=` 를 무시해야 한다.
  describe('안 풀리는 ?board= 를 무시해야 하는 ref (finding: 이전 가드가 너무 일찍 걸림)', () => {
    test('board-scoped ref(rocky#1)는 알 수 없는 ?board= 가 있어도 풀린다', async () => {
      await req('/api/todos', {
        method: 'POST',
        body: JSON.stringify({ board: 'rocky', title: '스코프 확인' }),
      });
      const res = await req('/api/todos/rocky%231?board=typo-board');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { todo: { title: string } };
      expect(body.todo.title).toBe('스코프 확인');
    });

    test('raw id 는 알 수 없는 ?board= 가 있어도 풀린다', async () => {
      const created = (await (
        await req('/api/todos', {
          method: 'POST',
          body: JSON.stringify({ board: 'rocky', title: 'raw id 확인' }),
        })
      ).json()) as { id: string };
      const res = await req(`/api/todos/${created.id}?board=typo-board`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { todo: { title: string } };
      expect(body.todo.title).toBe('raw id 확인');
    });

    test('id prefix 는 알 수 없는 ?board= 가 있어도 풀린다', async () => {
      const created = (await (
        await req('/api/todos', {
          method: 'POST',
          body: JSON.stringify({ board: 'rocky', title: 'prefix 확인' }),
        })
      ).json()) as { id: string };
      const res = await req(`/api/todos/${idPrefix(created.id)}?board=typo-board`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { todo: { title: string } };
      expect(body.todo.title).toBe('prefix 확인');
    });

    test('맨숫자 참조는 알 수 없는 ?board= 를 여전히 에러로 취급한다 (wrong-row 보호 유지)', async () => {
      await req('/api/todos', {
        method: 'POST',
        body: JSON.stringify({ board: 'rocky', title: '맨숫자 확인' }),
      });
      const res = await req('/api/todos/1?board=typo-board');
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    });

    test('board 없이 맨숫자 todo 참조는 "unknown board" 가 아니라 "board context required" 로 실패한다', async () => {
      await req('/api/todos', {
        method: 'POST',
        body: JSON.stringify({ board: 'rocky', title: '컨텍스트 확인' }),
      });
      const res = await req('/api/todos/1');
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/board context required/);
      expect(body.error).not.toMatch(/unknown board/);
    });

    test('board 없는 전역 메모 맨숫자 #N 은 그대로 전역 메모로 풀린다', async () => {
      const created = (await (
        await req('/api/notes', { method: 'POST', body: JSON.stringify({ title: '전역 메모' }) })
      ).json()) as { number: number };

      const res = await req(`/api/notes/${created.number}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { note: { title: string } };
      expect(body.note.title).toBe('전역 메모');
    });
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

describe('comments', () => {
  async function makeTodo(): Promise<{ id: string; ref: string }> {
    const res = await req('/api/todos', {
      method: 'POST',
      body: JSON.stringify({ board: 'rocky', title: '작업' }),
    });
    const todo = (await res.json()) as { id: string; ref: string };
    return todo;
  }

  test('POST /api/todos/:ref/comments creates a comment', async () => {
    const todo = await makeTodo();
    const res = await req(`/api/todos/${encodeURIComponent(todo.ref)}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body: '진행 중' }),
      actor: 'claude-code',
    });
    expect(res.status).toBe(201);
    const comment = (await res.json()) as { todoId: string; actor: string; body: string };
    expect(comment.todoId).toBe(todo.id);
    expect(comment.actor).toBe('claude-code');
    expect(comment.body).toBe('진행 중');
  });

  test('GET /api/todos/:ref includes comments', async () => {
    const todo = await makeTodo();
    await req(`/api/todos/${todo.id}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body: '첫 댓글' }),
    });
    const res = await req(`/api/todos/${todo.id}`);
    const detail = (await res.json()) as { comments: { body: string }[] };
    expect(detail.comments.map((c) => c.body)).toEqual(['첫 댓글']);
  });

  test('PATCH /api/comments/:id edits the body', async () => {
    const todo = await makeTodo();
    const created = await req(`/api/todos/${todo.id}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body: '오타' }),
    });
    const comment = (await created.json()) as { id: string };
    const res = await req(`/api/comments/${comment.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ body: '고침' }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { body: string }).body).toBe('고침');
  });

  test('archive hides a comment from the detail payload, unarchive restores it', async () => {
    const todo = await makeTodo();
    const created = await req(`/api/todos/${todo.id}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body: '잘못 달았다' }),
    });
    const comment = (await created.json()) as { id: string };

    await req(`/api/comments/${comment.id}/archive`, { method: 'POST' });
    const hidden = (await (await req(`/api/todos/${todo.id}`)).json()) as { comments: unknown[] };
    expect(hidden.comments).toHaveLength(0);

    await req(`/api/comments/${comment.id}/unarchive`, { method: 'POST' });
    const shown = (await (await req(`/api/todos/${todo.id}`)).json()) as { comments: unknown[] };
    expect(shown.comments).toHaveLength(1);
  });

  test('regression: 55 comments do not push create/start/done out of the detail history (finding 1)', async () => {
    const todo = await makeTodo();
    await req(`/api/todos/${todo.id}/status`, {
      method: 'POST',
      body: JSON.stringify({ action: 'start' }),
    });
    await req(`/api/todos/${todo.id}/status`, {
      method: 'POST',
      body: JSON.stringify({ action: 'done' }),
    });
    for (let i = 0; i < 55; i++) {
      await req(`/api/todos/${todo.id}/comments`, {
        method: 'POST',
        body: JSON.stringify({ body: `댓글 ${i}` }),
      });
    }

    const detail = (await (await req(`/api/todos/${todo.id}`)).json()) as {
      history: { action: string }[];
    };
    const actions = detail.history.map((h) => h.action);
    expect(actions).toContain('create');
    expect(actions).toContain('start');
    expect(actions).toContain('done');
  });

  test('GET /api/todos/:ref?includeArchived=true returns an archived comment; without it, it does not', async () => {
    const todo = await makeTodo();
    const created = await req(`/api/todos/${todo.id}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body: '보관될 댓글' }),
    });
    const comment = (await created.json()) as { id: string };
    await req(`/api/comments/${comment.id}/archive`, { method: 'POST' });

    const withoutFlag = (await (await req(`/api/todos/${todo.id}`)).json()) as {
      comments: unknown[];
    };
    expect(withoutFlag.comments).toHaveLength(0);

    const withFlag = (await (await req(`/api/todos/${todo.id}?includeArchived=true`)).json()) as {
      comments: { id: string }[];
    };
    expect(withFlag.comments.map((c) => c.id)).toEqual([comment.id]);
  });

  test('blank body is a 400 and unknown comment id is a 404', async () => {
    const todo = await makeTodo();
    const blank = await req(`/api/todos/${todo.id}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body: '   ' }),
    });
    expect(blank.status).toBe(400);

    const missing = await req('/api/comments/nosuchid', {
      method: 'PATCH',
      body: JSON.stringify({ body: '본문' }),
    });
    expect(missing.status).toBe(404);
  });
});

describe('github issue', () => {
  test('PATCH /api/boards/:key sets the repo', async () => {
    await req('/api/boards', { method: 'POST', body: JSON.stringify({ key: 'rocky' }) });
    const res = await req('/api/boards/rocky', {
      method: 'PATCH',
      body: JSON.stringify({ repo: 'o/n' }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { repo: string }).repo).toBe('o/n');
  });

  test('PATCH rejects a malformed slug and an unknown board', async () => {
    await req('/api/boards', { method: 'POST', body: JSON.stringify({ key: 'rocky' }) });
    const bad = await req('/api/boards/rocky', {
      method: 'PATCH',
      body: JSON.stringify({ repo: 'not-a-slug' }),
    });
    expect(bad.status).toBe(400);

    const missing = await req('/api/boards/nosuch', {
      method: 'PATCH',
      body: JSON.stringify({ repo: 'o/n' }),
    });
    expect(missing.status).toBe(404);
  });

  test('POST /api/todos/:ref/issue is 400 without a repo and 404 for an unknown todo', async () => {
    const created = await req('/api/todos', {
      method: 'POST',
      body: JSON.stringify({ board: 'rocky', title: '작업' }),
    });
    const todo = (await created.json()) as { id: string };

    const noRepo = await req(`/api/todos/${todo.id}/issue`, { method: 'POST' });
    expect(noRepo.status).toBe(400);

    const missing = await req('/api/todos/nosuchid/issue', { method: 'POST' });
    expect(missing.status).toBe(404);
  });

  test('POST /api/todos/:ref/issue is 409 when an issue link already exists', async () => {
    const created = await req('/api/todos', {
      method: 'POST',
      body: JSON.stringify({
        board: 'rocky',
        title: '작업',
        links: [{ url: 'https://github.com/o/n/issues/3' }],
      }),
    });
    const todo = (await created.json()) as { id: string };
    await req('/api/boards/rocky', { method: 'PATCH', body: JSON.stringify({ repo: 'o/n' }) });

    const res = await req(`/api/todos/${todo.id}/issue`, { method: 'POST' });
    expect(res.status).toBe(409);
  });
});
