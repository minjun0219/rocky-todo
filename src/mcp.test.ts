import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildTodoMcpServer } from './mcp';
import { TodoStore } from './store';

const TODO_MCP_TOOLS = [
  'todo_list',
  'todo_write',
  'todo_status',
  'note_list',
  'note_write',
] as const;

let dir: string;
let store: TodoStore;
let client: Client;

async function connect(): Promise<Client> {
  const server = buildTodoMcpServer({ store });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), c.connect(clientTransport)]);
  return c;
}

function resultJson(result: unknown): unknown {
  const content = (result as { content: { type: string; text: string }[] }).content;
  const text = content.find((c) => c.type === 'text')?.text ?? '';
  return JSON.parse(text);
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'rocky-todo-mcp-'));
  store = new TodoStore({ dbPath: join(dir, 'todo.db') });
  client = await connect();
});

afterEach(async () => {
  await client.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('surface', () => {
  test('exactly the 5 compact tools are registered', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TODO_MCP_TOOLS].sort());
  });
});

describe('todo_write / todo_list / todo_status', () => {
  test('create → list → detail → status round-trip', async () => {
    const created = resultJson(
      await client.callTool({
        name: 'todo_write',
        arguments: {
          board: 'rocky',
          title: 'MCP 로 만든 작업',
          section: '설계',
          priority: 'p2',
          labels: ['mcp'],
          links: [{ url: 'https://github.com/minjun0219/rocky/issues/1' }],
          actor: 'claude-code',
        },
      }),
    ) as { id: string; title: string; priority: string };
    expect(created.title).toBe('MCP 로 만든 작업');
    expect(created.priority).toBe('p2');

    const listed = resultJson(
      await client.callTool({ name: 'todo_list', arguments: { board: 'rocky' } }),
    ) as { todos: { id: string }[] };
    expect(listed.todos).toHaveLength(1);

    const detail = resultJson(
      await client.callTool({ name: 'todo_list', arguments: { id: created.id } }),
    ) as { todo: { id: string }; history: { actor: string }[] };
    expect(detail.todo.id).toBe(created.id);
    expect(detail.history.at(-1)?.actor).toBe('claude-code');

    const doing = resultJson(
      await client.callTool({
        name: 'todo_status',
        arguments: { id: created.id, action: 'start', actor: 'claude-code' },
      }),
    ) as { status: string; doingBy: string };
    expect(doing.status).toBe('doing');
    expect(doing.doingBy).toBe('claude-code');
  });

  test('todo_write with id patches an existing todo', async () => {
    const created = resultJson(
      await client.callTool({
        name: 'todo_write',
        arguments: { board: 'rocky', title: '수정 전', actor: 'tester' },
      }),
    ) as { id: string };

    const updated = resultJson(
      await client.callTool({
        name: 'todo_write',
        arguments: { id: created.id, title: '수정 후', actor: 'tester' },
      }),
    ) as { title: string };
    expect(updated.title).toBe('수정 후');
  });

  test('todo_list with boards flag returns board list', async () => {
    await client.callTool({
      name: 'todo_write',
      arguments: { board: 'rocky', title: 'x', actor: 'tester' },
    });
    const boards = resultJson(
      await client.callTool({ name: 'todo_list', arguments: { boards: true } }),
    ) as { boards: { key: string }[] };
    expect(boards.boards.map((b) => b.key)).toEqual(['rocky']);
  });

  test('errors surface as isError result, not protocol failure', async () => {
    const result = await client.callTool({
      name: 'todo_status',
      arguments: { id: 'zzzzzzzz', action: 'done', actor: 'tester' },
    });
    expect(result.isError).toBe(true);
  });
});

describe('note_write / note_list', () => {
  test('create, append, archive lifecycle over MCP', async () => {
    const created = resultJson(
      await client.callTool({
        name: 'note_write',
        arguments: { board: 'rocky', title: '메모', content: '첫 줄', actor: 'claude-code' },
      }),
    ) as { id: string };

    await client.callTool({
      name: 'note_write',
      arguments: { id: created.id, content: '둘째 줄', mode: 'append', actor: 'claude-code' },
    });

    const listed = resultJson(
      await client.callTool({ name: 'note_list', arguments: { board: 'rocky' } }),
    ) as { notes: { content: string }[] };
    expect(listed.notes[0]?.content).toBe('첫 줄\n둘째 줄');

    await client.callTool({
      name: 'note_write',
      arguments: { id: created.id, mode: 'archive', actor: 'claude-code' },
    });
    const after = resultJson(
      await client.callTool({ name: 'note_list', arguments: { board: 'rocky' } }),
    ) as { notes: unknown[] };
    expect(after.notes).toHaveLength(0);
  });
});
