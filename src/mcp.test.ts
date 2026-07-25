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

  // finding 4 회귀: note_list/note_write 설명이 예전엔 "맨숫자 #12 로 조회/수정하려면
  // board 를 함께 줘야 한다" 고만 말해, 접두사 없는 #N 이 사실은 board 를 "생략"해야
  // 하는 전역 메모 공간이라는 걸 알려주지 않았다. board 를 같이 주면(설명이 시키는 대로)
  // 그 보드의 같은 번호 메모가 대신 잡혀 엉뚱한 행을 archive/수정하게 된다.
  test('note_list/note_write 설명은 board 를 생략해야 전역 메모가 풀린다고 명시한다', async () => {
    const { tools } = await client.listTools();
    for (const name of ['note_list', 'note_write'] as const) {
      const tool = tools.find((t) => t.name === name);
      expect(tool?.description).toMatch(/global|전역/i);
      expect(tool?.description).not.toMatch(
        /맨숫자 #12 로 (조회|수정)하려면 board 를 함께 줘야 한다/,
      );
    }
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

describe('number / ref 참조 문법', () => {
  test('todo_write 응답에 number 가 실리고, board-scoped ref 로 detail 조회가 된다', async () => {
    const created = resultJson(
      await client.callTool({
        name: 'todo_write',
        arguments: { board: 'rocky', title: '참조 확인', actor: 'tester' },
      }),
    ) as { number: number };
    expect(created.number).toBe(1);

    const detail = resultJson(
      await client.callTool({ name: 'todo_list', arguments: { id: 'rocky#1' } }),
    ) as { todo: { title: string } };
    expect(detail.todo.title).toBe('참조 확인');
  });

  test('todo_status 도 board-scoped ref 로 전이할 수 있다', async () => {
    await client.callTool({
      name: 'todo_write',
      arguments: { board: 'rocky', title: '상태 확인', actor: 'tester' },
    });
    const doing = resultJson(
      await client.callTool({
        name: 'todo_status',
        arguments: { id: 'rocky#1', action: 'start', actor: 'tester' },
      }),
    ) as { status: string };
    expect(doing.status).toBe('doing');
  });

  test('보드 컨텍스트 없는 맨숫자 참조는 isError 결과로 실패한다 (크래시 아님)', async () => {
    await client.callTool({
      name: 'todo_write',
      arguments: { board: 'rocky', title: '번호만', actor: 'tester' },
    });
    const result = await client.callTool({
      name: 'todo_status',
      arguments: { id: '1', action: 'done', actor: 'tester' },
    });
    expect(result.isError).toBe(true);
  });

  test('note_write 응답에 number 가 실리고, board-scoped ref 로 조회된다', async () => {
    const created = resultJson(
      await client.callTool({
        name: 'note_write',
        arguments: { board: 'rocky', title: '메모 참조', actor: 'tester' },
      }),
    ) as { number: number };
    expect(created.number).toBe(1);

    const detail = resultJson(
      await client.callTool({ name: 'note_list', arguments: { id: 'rocky#1' } }),
    ) as { note: { title: string } };
    expect(detail.note.title).toBe('메모 참조');
  });

  test('todo_list 는 board 를 같이 주면 맨숫자 #1 을 풀 수 있다', async () => {
    await client.callTool({
      name: 'todo_write',
      arguments: { board: 'rocky', title: '맨숫자 조회', actor: 'tester' },
    });
    const detail = resultJson(
      await client.callTool({
        name: 'todo_list',
        arguments: { id: '#1', board: 'rocky' },
      }),
    ) as { todo: { title: string } };
    expect(detail.todo.title).toBe('맨숫자 조회');
  });

  test('todo_write 는 board 를 같이 주면 맨숫자 #1 로 patch 할 수 있다', async () => {
    await client.callTool({
      name: 'todo_write',
      arguments: { board: 'rocky', title: '맨숫자 patch 전', actor: 'tester' },
    });
    const updated = resultJson(
      await client.callTool({
        name: 'todo_write',
        arguments: { id: '#1', board: 'rocky', title: '맨숫자 patch 후', actor: 'tester' },
      }),
    ) as { title: string };
    expect(updated.title).toBe('맨숫자 patch 후');
  });

  test('todo_status 는 board 를 같이 주면 맨숫자 #1 로 전이할 수 있다', async () => {
    await client.callTool({
      name: 'todo_write',
      arguments: { board: 'rocky', title: '맨숫자 상태', actor: 'tester' },
    });
    const doing = resultJson(
      await client.callTool({
        name: 'todo_status',
        arguments: { id: '#1', board: 'rocky', action: 'start', actor: 'tester' },
      }),
    ) as { status: string };
    expect(doing.status).toBe('doing');
  });

  test('note_list 는 board 를 같이 주면 맨숫자 #1 을 풀 수 있다', async () => {
    await client.callTool({
      name: 'note_write',
      arguments: { board: 'rocky', title: '맨숫자 메모', actor: 'tester' },
    });
    const detail = resultJson(
      await client.callTool({
        name: 'note_list',
        arguments: { id: '#1', board: 'rocky' },
      }),
    ) as { note: { title: string } };
    expect(detail.note.title).toBe('맨숫자 메모');
  });

  test('note_write 는 board 를 같이 주면 맨숫자 #1 로 수정할 수 있다', async () => {
    await client.callTool({
      name: 'note_write',
      arguments: { board: 'rocky', title: '맨숫자 메모 patch 전', actor: 'tester' },
    });
    const updated = resultJson(
      await client.callTool({
        name: 'note_write',
        arguments: { id: '#1', board: 'rocky', content: '수정됨', actor: 'tester' },
      }),
    ) as { content: string };
    expect(updated.content).toBe('수정됨');
  });

  test('board 없이 맨숫자 참조를 쓰면 note_write 도 isError 결과로 실패한다 (크래시 아님)', async () => {
    await client.callTool({
      name: 'note_write',
      arguments: { board: 'rocky', title: '보드 없는 참조', actor: 'tester' },
    });
    const result = await client.callTool({
      name: 'note_write',
      arguments: { id: '1', content: '수정 시도', actor: 'tester' },
    });
    expect(result.isError).toBe(true);
  });

  test('존재하지 않는 board key 를 줘도 보드를 지어내지 않고 store 에러가 그대로 표면화된다', async () => {
    await client.callTool({
      name: 'todo_write',
      arguments: { board: 'rocky', title: '없는 보드', actor: 'tester' },
    });
    const result = await client.callTool({
      name: 'todo_status',
      arguments: { id: '#1', board: 'no-such-board', action: 'done', actor: 'tester' },
    });
    expect(result.isError).toBe(true);
  });

  // finding C: todos 는 board context 가 없으면(맨숫자에 전역 번호 공간이 없어) 우연히
  // 에러가 났지만, notes 는 board 가 안 풀리면 currentBoardId 가 undefined 로 폴백해
  // 맨숫자를 "board 를 아예 안 준 것"처럼 전역 메모 번호 공간에서 조용히 풀어버렸다 —
  // typo 하나로 완전히 다른(전역) 행을 돌려주는 wrong-row 위험. board 를 줬는데 안 풀리면
  // 무조건 에러여야 한다.
  test('note_list 에 알 수 없는 board key 를 주면 전역 메모로 조용히 폴백하지 않고 에러다', async () => {
    const global = resultJson(
      await client.callTool({
        name: 'note_write',
        arguments: { title: '전역 메모', actor: 'tester' },
      }),
    ) as { number: number };
    expect(global.number).toBe(1);

    const result = await client.callTool({
      name: 'note_list',
      arguments: { id: `#${global.number}`, board: 'typo-board' },
    });
    expect(result.isError).toBe(true);
  });

  test('note_write 에 알 수 없는 board key 를 주면 전역 메모를 조용히 수정하지 않고 에러다', async () => {
    await client.callTool({
      name: 'note_write',
      arguments: { title: '전역 메모', actor: 'tester' },
    });
    const result = await client.callTool({
      name: 'note_write',
      arguments: { id: '#1', board: 'typo-board', content: '엉뚱하게 수정', actor: 'tester' },
    });
    expect(result.isError).toBe(true);
  });
});

describe('MCP 응답의 ref 직렬화 (finding 3 회귀)', () => {
  // 스펙: REST 와 MCP 모두 응답에 number 뿐 아니라 ref 를 실어야 한다. 고쳐지기 전엔
  // mcp.ts 가 store 모델을 그대로 반환해 서로 다른 보드의 todo 가 둘 다 `number: 1` 로만
  // 보이고 boardId(랜덤 id) 로만 구분 가능했다 — #N 으로 말하라고 지시받은 에이전트가
  // `rocky#1` 을 만들어낼 방법이 없었다.
  test('todo_write 응답에 ref 필드가 실린다', async () => {
    const created = resultJson(
      await client.callTool({
        name: 'todo_write',
        arguments: { board: 'rocky', title: 'ref 확인', actor: 'tester' },
      }),
    ) as { ref: string };
    expect(created.ref).toBe('rocky#1');
  });

  test('두 보드의 항목이 같은 number 를 가져도 ref 로 구분된다', async () => {
    await client.callTool({
      name: 'todo_write',
      arguments: { board: 'rocky', title: 'rocky 1번', actor: 'tester' },
    });
    await client.callTool({
      name: 'todo_write',
      arguments: { board: 'other', title: 'other 1번', actor: 'tester' },
    });

    const rockyList = resultJson(
      await client.callTool({ name: 'todo_list', arguments: { board: 'rocky' } }),
    ) as { todos: { number: number; ref: string }[] };
    const otherList = resultJson(
      await client.callTool({ name: 'todo_list', arguments: { board: 'other' } }),
    ) as { todos: { number: number; ref: string }[] };

    expect(rockyList.todos[0]?.number).toBe(1);
    expect(otherList.todos[0]?.number).toBe(1);
    expect(rockyList.todos[0]?.ref).toBe('rocky#1');
    expect(otherList.todos[0]?.ref).toBe('other#1');
    expect(rockyList.todos[0]?.ref).not.toBe(otherList.todos[0]?.ref);
  });

  test('todo_list 상세 조회 / todo_status 응답에도 ref 가 실린다', async () => {
    const created = resultJson(
      await client.callTool({
        name: 'todo_write',
        arguments: { board: 'rocky', title: '상태 ref 확인', actor: 'tester' },
      }),
    ) as { id: string };

    const detail = resultJson(
      await client.callTool({ name: 'todo_list', arguments: { id: created.id } }),
    ) as { todo: { ref: string } };
    expect(detail.todo.ref).toBe('rocky#1');

    const status = resultJson(
      await client.callTool({
        name: 'todo_status',
        arguments: { id: created.id, action: 'start', actor: 'tester' },
      }),
    ) as { ref: string };
    expect(status.ref).toBe('rocky#1');
  });

  test('보드 소속 메모는 rocky#1, 글로벌 메모는 #1 로 ref 가 구분된다', async () => {
    const boardNote = resultJson(
      await client.callTool({
        name: 'note_write',
        arguments: { board: 'rocky', title: '보드 메모', actor: 'tester' },
      }),
    ) as { ref: string };
    expect(boardNote.ref).toBe('rocky#1');

    const globalNote = resultJson(
      await client.callTool({
        name: 'note_write',
        arguments: { title: '글로벌 메모', actor: 'tester' },
      }),
    ) as { ref: string };
    expect(globalNote.ref).toBe('#1');

    const list = resultJson(
      await client.callTool({ name: 'note_list', arguments: { board: 'rocky' } }),
    ) as { notes: { ref: string }[] };
    expect(list.notes[0]?.ref).toBe('rocky#1');
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
