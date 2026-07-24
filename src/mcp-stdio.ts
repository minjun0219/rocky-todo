import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import pkg from '../../package.json' with { type: 'json' };
import { loadConfig } from '../core/rocky-config';
import { detectActor } from './actor';
import { buildContext, request } from './client';
import { DEFAULT_TODO_DIR, resolveTodoRuntimeConfig } from './config';
import { enableTodo } from './enable';
import { TODO_TOOL_SPECS } from './mcp-tools';

/**
 * rocky-todo 의 stdio MCP 브릿지 — plugin.json 에 선언되는 유일한 MCP 서버.
 *
 * 도구 호출을 데몬의 기존 /api/* REST 로 포워딩하고(client.ts), 데몬을 온디맨드로
 * health→spawn 한다. 비활성(todo.enabled=false) 상태에서는 todo_enable 만 실질 동작하고
 * 나머지 5개는 구조화된 안내 에러를 반환한다 — 도구가 세션에서 사라지지 않게 하는 게 핵심.
 */

function q(params: Record<string, string | undefined>): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') {
      usp.set(k, v);
    }
  }
  const s = usp.toString();
  return s ? `?${s}` : '';
}

/** 도구 호출을 데몬 REST 요청으로 매핑한다 (순수). */
export function toolToRest(
  name: string,
  args: Record<string, unknown>,
): { method: string; path: string; body?: unknown } {
  const s = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  switch (name) {
    case 'todo_list': {
      if (args.boards) {
        return { method: 'GET', path: '/api/boards' };
      }
      if (args.id) {
        return { method: 'GET', path: `/api/todos/${s(args.id)}` };
      }
      return {
        method: 'GET',
        path: `/api/todos${q({ board: s(args.board), status: s(args.status), label: s(args.label), includeArchived: args.includeArchived ? 'true' : undefined })}`,
      };
    }
    case 'todo_write': {
      if (args.id) {
        const { id, ...body } = args;
        return { method: 'PATCH', path: `/api/todos/${s(id)}`, body };
      }
      return { method: 'POST', path: '/api/todos', body: args };
    }
    case 'todo_status':
      return {
        method: 'POST',
        path: `/api/todos/${s(args.id)}/status`,
        body: { action: args.action },
      };
    case 'note_list': {
      if (args.id) {
        return { method: 'GET', path: `/api/notes/${s(args.id)}` };
      }
      return {
        method: 'GET',
        path: `/api/notes${q({ board: s(args.board), global: args.global ? 'true' : undefined, includeArchived: args.includeArchived ? 'true' : undefined })}`,
      };
    }
    case 'note_write': {
      if (args.id) {
        if (args.mode === 'archive' || args.mode === 'unarchive') {
          return { method: 'POST', path: `/api/notes/${s(args.id)}/${args.mode}`, body: undefined };
        }
        const { id, mode, ...rest } = args;
        return { method: 'PATCH', path: `/api/notes/${s(id)}`, body: { ...rest, mode } };
      }
      return { method: 'POST', path: '/api/notes', body: args };
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

/** 비활성 상태에서 5개 도구가 반환하는 구조화된 안내. */
export function disabledGuidance(): { error: string; guidance: string } {
  return {
    error: 'rocky-todo disabled',
    guidance:
      '켜기 전에 사용자에게 알리고 동의를 받아라: (1) 127.0.0.1:8636 에 상주 데몬이 뜬다 (2) 보드 데이터는 ~/.config/rocky/todo/todo.db 에 저장된다 (3) user rocky.json 에 todo.enabled=true 가 기록된다. 동의를 받은 뒤에만 todo_enable 을 호출한다.',
  };
}

export interface BridgeDeps {
  enabled: boolean;
  forward: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  enable: () => Promise<unknown>;
}

function jsonResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

/** 6개 도구가 등록된 McpServer 를 만든다 (DI — transport 바인딩은 호출자 몫). */
export function buildBridgeServer(deps: BridgeDeps): McpServer {
  const server = new McpServer({ name: 'rocky-todo', version: pkg.version });

  for (const spec of TODO_TOOL_SPECS) {
    server.registerTool(
      spec.name,
      { description: spec.description, inputSchema: spec.inputSchema },
      async (args: Record<string, unknown>) => {
        if (!deps.enabled) {
          return jsonResult(disabledGuidance());
        }
        return jsonResult(await deps.forward(spec.name, args));
      },
    );
  }

  server.registerTool(
    'todo_enable',
    {
      description:
        'rocky-todo 를 활성화한다. 사용자에게 노출 범위(상주 데몬 127.0.0.1:8636 / SQLite 저장 / rocky.json 기록)를 설명하고 동의를 받은 뒤에만 호출한다. user rocky.json 에 todo.enabled=true 를 기록하고 데몬을 기동한다.',
      inputSchema: {},
    },
    async () => jsonResult(await deps.enable()),
  );

  return server;
}

if (import.meta.main) {
  const { config } = await loadConfig({ projectRoot: DEFAULT_TODO_DIR });
  const runtime = resolveTodoRuntimeConfig(process.env, config.todo);
  const ctx = buildContext({ port: runtime.port, dir: runtime.dir, actor: detectActor() });
  const server = buildBridgeServer({
    enabled: runtime.enabled,
    forward: async (name, args) => {
      const { method, path, body } = toolToRest(name, args);
      return request(ctx, method, path, body);
    },
    enable: () => enableTodo({ port: runtime.port, dir: runtime.dir }),
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
