import { describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { type BridgeDeps, buildBridgeServer, disabledGuidance, toolToRest } from './mcp-stdio';

describe('toolToRest', () => {
  test('todo_list (필터) → GET /api/todos', () => {
    expect(toolToRest('todo_list', { board: 'rocky' })).toEqual({
      method: 'GET',
      path: '/api/todos?board=rocky',
    });
  });

  test('todo_list boards → GET /api/boards', () => {
    expect(toolToRest('todo_list', { boards: true })).toEqual({
      method: 'GET',
      path: '/api/boards',
    });
  });

  test('todo_list id → GET /api/todos/:id', () => {
    expect(toolToRest('todo_list', { id: 'abc' })).toEqual({
      method: 'GET',
      path: '/api/todos/abc',
    });
  });

  test('todo_write 생성 → POST /api/todos', () => {
    expect(toolToRest('todo_write', { board: 'r', title: 't' })).toEqual({
      method: 'POST',
      path: '/api/todos',
      body: { board: 'r', title: 't' },
    });
  });

  test('todo_write 수정 → PATCH /api/todos/:id', () => {
    expect(toolToRest('todo_write', { id: 'abc', title: 't2' })).toEqual({
      method: 'PATCH',
      path: '/api/todos/abc',
      body: { title: 't2' },
    });
  });

  test('todo_status → POST /api/todos/:id/status', () => {
    expect(toolToRest('todo_status', { id: 'abc', action: 'start' })).toEqual({
      method: 'POST',
      path: '/api/todos/abc/status',
      body: { action: 'start' },
    });
  });

  test('note_write archive → POST /api/notes/:id/archive', () => {
    expect(toolToRest('note_write', { id: 'n1', mode: 'archive' })).toEqual({
      method: 'POST',
      path: '/api/notes/n1/archive',
      body: undefined,
    });
  });

  test('note_write 생성 → POST /api/notes', () => {
    expect(toolToRest('note_write', { title: '메모' })).toEqual({
      method: 'POST',
      path: '/api/notes',
      body: { title: '메모' },
    });
  });
});

describe('disabledGuidance', () => {
  test('노출 범위 3가지와 todo_enable 지시를 담는다', () => {
    const g = disabledGuidance();
    expect(g.error).toBe('rocky-todo disabled');
    expect(g.guidance).toContain('127.0.0.1');
    expect(g.guidance).toContain('todo.db');
    expect(g.guidance).toContain('todo_enable');
  });
});

describe('BridgeDeps 가변 enabled 플래그', () => {
  test('isEnabled 클로저 — enable() 호출 후 true 로 바뀐다', async () => {
    let flag = false;
    const deps: BridgeDeps = {
      isEnabled: () => flag,
      forward: async () => ({ ok: true }),
      enable: async () => {
        flag = true;
        return { ok: true };
      },
    };

    expect(deps.isEnabled()).toBe(false);
    await deps.enable();
    expect(deps.isEnabled()).toBe(true);
  });

  test('McpServer 전이 — todo_enable 호출 전엔 disabled 안내, 호출 후 즉시 forward 된다', async () => {
    let flag = false;
    let forwardCalls = 0;
    const deps: BridgeDeps = {
      isEnabled: () => flag,
      forward: async (name, args) => {
        forwardCalls++;
        return { name, args, ok: true };
      },
      enable: async () => {
        flag = true;
        return { ok: true, url: 'http://127.0.0.1:8636' };
      },
    };
    const server = buildBridgeServer(deps);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'rocky-todo-test', version: '0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    // disabled 상태 — todo_list 는 안내를 반환하고 forward 는 호출되지 않는다
    const before = await client.callTool({ name: 'todo_list', arguments: {} });
    const beforeContent = (before.content as { type: 'text'; text: string }[])[0]?.text ?? '';
    expect(beforeContent).toContain('rocky-todo disabled');
    expect(forwardCalls).toBe(0);

    // todo_enable 호출 — 같은 프로세스(같은 server 인스턴스) 안에서 플래그가 즉시 바뀐다
    await client.callTool({ name: 'todo_enable', arguments: {} });
    expect(deps.isEnabled()).toBe(true);

    // 같은 연결에서 이어서 호출한 todo_list 는 이제 forward 된다 — 재시작 불필요
    const after = await client.callTool({ name: 'todo_list', arguments: { board: 'rocky' } });
    const afterContent = (after.content as { type: 'text'; text: string }[])[0]?.text ?? '';
    expect(afterContent).not.toContain('rocky-todo disabled');
    expect(forwardCalls).toBe(1);
  });
});
