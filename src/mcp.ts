import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import pkg from '../../package.json' with { type: 'json' };
import type { StatusAction, TodoStore } from './store';

/**
 * rocky-todo 의 MCP 표면 — 데몬의 `/mcp` (streamable HTTP) 에만 존재한다.
 *
 * 도구는 5개로 압축한다 (세션마다 실리는 스키마 토큰 고정비 최소화):
 * todo_list / todo_write / todo_status / note_list / note_write.
 * 섹션은 todo_write 의 `section` 이 이름 기반 upsert 하므로 별도 도구가 없다.
 * 삭제 도구는 의도적으로 없다 — 아카이브만 존재한다.
 */

export interface TodoMcpOptions {
  store: TodoStore;
}

function jsonResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

const actorSchema = z
  .string()
  .optional()
  .describe('who is acting (e.g. claude-code / codex / opencode); recorded in history');

const linkSchema = z.object({ url: z.string(), title: z.string().optional() });

/** 5개 도구가 등록된 McpServer 를 만든다 — transport 바인딩은 호출자 몫. */
export function buildTodoMcpServer(options: TodoMcpOptions): McpServer {
  const { store } = options;
  const server = new McpServer({ name: 'rocky-todo', version: pkg.version });

  server.registerTool(
    'todo_list',
    {
      description:
        '공유 todo 보드 조회. board 로 보드 하나, 생략 시 전체. id 를 주면 해당 todo 상세 + 히스토리, boards:true 면 보드 목록. 필터: status / label / includeArchived.',
      inputSchema: {
        board: z.string().optional().describe('board key (usually the repo name)'),
        id: z.string().optional().describe('todo id (or unique prefix) for detail + history'),
        boards: z.boolean().optional().describe('true → list boards instead of todos'),
        status: z.enum(['todo', 'doing', 'done']).optional(),
        label: z.string().optional(),
        includeArchived: z.boolean().optional(),
      },
    },
    async ({ board, id, boards, status, label, includeArchived }) => {
      if (boards) {
        return jsonResult({ boards: store.listBoards(includeArchived ?? false) });
      }
      if (id) {
        const todo = store.getTodo(id);
        if (!todo) {
          throw new Error(`todo not found: ${id}`);
        }
        return jsonResult({ todo, history: store.listHistory({ entityId: todo.id }) });
      }
      return jsonResult({ todos: store.listTodos({ board, status, label, includeArchived }) });
    },
  );

  server.registerTool(
    'todo_write',
    {
      description:
        'todo 생성/수정. id 없으면 생성(board + title 필수), 있으면 부분 수정. section 은 이름으로 자동 upsert. links 에 GitHub 이슈 / Todoist URL 을 첨부해 맥락을 연결한다. 삭제는 없다 — todo_status 의 archive 를 쓴다.',
      inputSchema: {
        id: z.string().optional().describe('omit to create, set to patch an existing todo'),
        board: z.string().optional().describe('board key — required when creating'),
        title: z.string().optional().describe('required when creating'),
        description: z.string().optional().describe('markdown detail'),
        section: z.string().optional().describe('section name (upserted within the board)'),
        parentId: z.string().optional().describe('parent todo id for hierarchy'),
        priority: z.enum(['p1', 'p2', 'p3', 'p4']).optional(),
        due: z.string().optional().describe('ISO date, e.g. 2026-08-01'),
        labels: z.array(z.string()).optional(),
        links: z.array(linkSchema).optional(),
        actor: actorSchema,
      },
    },
    async ({ id, board, title, actor, ...rest }) => {
      const who = actor ?? 'agent';
      if (id) {
        return jsonResult(store.updateTodo(id, { title, ...rest }, who));
      }
      if (!board || !title) {
        throw new Error('board and title are required to create a todo');
      }
      return jsonResult(store.createTodo({ board, title, ...rest }, who));
    },
  );

  server.registerTool(
    'todo_status',
    {
      description:
        'todo 상태 전이. start=처리 시작(누가 작업중인지 웹 UI 에 표시됨 — 작업 착수 시 반드시 호출), stop=중단, done=완료, reopen=재오픈, archive/unarchive=보관/복원.',
      inputSchema: {
        id: z.string().describe('todo id (or unique prefix)'),
        action: z.enum(['start', 'stop', 'done', 'reopen', 'archive', 'unarchive']),
        actor: actorSchema,
      },
    },
    async ({ id, action, actor }) =>
      jsonResult(store.setTodoStatus(id, action as StatusAction, actor ?? 'agent')),
  );

  server.registerTool(
    'note_list',
    {
      description:
        '스크래치패드/메모 조회. board 로 보드 소속, global:true 로 보드 미소속 메모. id 를 주면 상세 + 히스토리.',
      inputSchema: {
        board: z.string().optional(),
        global: z.boolean().optional(),
        id: z.string().optional(),
        includeArchived: z.boolean().optional(),
      },
    },
    async ({ board, global: isGlobal, id, includeArchived }) => {
      if (id) {
        const note = store.getNote(id);
        if (!note) {
          throw new Error(`note not found: ${id}`);
        }
        return jsonResult({ note, history: store.listHistory({ entityId: note.id }) });
      }
      return jsonResult({ notes: store.listNotes({ board, global: isGlobal, includeArchived }) });
    },
  );

  server.registerTool(
    'note_write',
    {
      description:
        '스크래치패드/메모 작성. id 없으면 생성(title 필수), 있으면 수정. mode: set=content 교체(기본) / append=뒤에 이어붙임 / archive=보관 / unarchive=복원. 삭제는 없다.',
      inputSchema: {
        id: z.string().optional(),
        board: z.string().optional().describe('omit for a global note'),
        title: z.string().optional(),
        content: z.string().optional(),
        mode: z.enum(['set', 'append', 'archive', 'unarchive']).optional(),
        actor: actorSchema,
      },
    },
    async ({ id, board, title, content, mode, actor }) => {
      const who = actor ?? 'agent';
      if (!id) {
        if (!title) {
          throw new Error('title is required to create a note');
        }
        return jsonResult(store.createNote({ board, title, content }, who));
      }
      if (mode === 'archive') {
        return jsonResult(store.archiveNote(id, who));
      }
      if (mode === 'unarchive') {
        return jsonResult(store.unarchiveNote(id, who));
      }
      return jsonResult(
        store.updateNote(id, { title, content, mode: mode === 'append' ? 'append' : 'set' }, who),
      );
    },
  );

  return server;
}

/**
 * `/mcp` 용 fetch 핸들러 — stateless 모드로 요청마다 서버+transport 를 새로 만든다.
 * 로컬 단일 사용자 데몬이라 세션 관리가 불필요하고, 요청 간 상태는 전부 store 에 있다.
 */
export function createMcpFetchHandler(
  options: TodoMcpOptions,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const server = buildTodoMcpServer(options);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(req);
    } finally {
      // 응답 스트림이 닫힌 뒤 리소스 정리 — stateless 라 요청 단위 수명이다.
      void transport.close().catch(() => {});
    }
  };
}
