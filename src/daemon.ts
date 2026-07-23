import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import ui from './ui/index.html';
import { loadConfig } from '../core/rocky-config';
import { DEFAULT_TODO_DIR, resolveTodoRuntimeConfig } from './config';
import { createMcpFetchHandler } from './mcp';
import { buildTodoServer } from './server';
import { TodoStore } from './store';
import { ensureTailscaleServe } from './tailscale';

/**
 * rocky-todo 데몬 — 시스템 유일 인스턴스, 단일 writer.
 *
 * 하나의 Bun fullstack 서버가 네 표면을 서빙한다:
 *   /            React 웹 UI (HTML import 자동 번들 — dist 없음)
 *   /api/*       REST (CLI + 웹 UI 공용)
 *   /api/events  SSE (웹 UI 실시간 갱신)
 *   /mcp         MCP streamable HTTP (Claude Code / opencode / Codex)
 *
 * 단일성 보장: 기동 시 같은 포트의 기존 인스턴스 health 를 확인하고 있으면 즉시
 * 종료한다 (포트 자체가 락). 127.0.0.1 바인딩 전용 — 인증 없음이 안전한 전제.
 * 설정은 env > user rocky.json 의 `todo` 블록 > 기본값 — project rocky.json 은
 * 보지 않는다 (어디서 기동돼도 같은 데몬이어야 하므로).
 */

async function isAlreadyRunning(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(1000),
    });
    if (!res.ok) {
      return false;
    }
    const body = (await res.json()) as { name?: string };
    return body.name === 'rocky-todo';
  } catch {
    return false;
  }
}

export async function startDaemon(): Promise<void> {
  // user rocky.json 만 반영 — projectRoot 를 데이터 디렉터리로 줘서 project config 를 무력화
  const { config } = await loadConfig({ projectRoot: DEFAULT_TODO_DIR });
  const runtime = resolveTodoRuntimeConfig(process.env, config.todo);

  // 마스터 스위치 (todo.enabled, 기본 off) — launchd 잔존 등록 등으로 실행돼도 조용히 종료
  if (!runtime.enabled) {
    console.log(
      'rocky-todo 는 기본 비활성이다 — user rocky.json 에 "todo": { "enabled": true } 를 설정하거나 ROCKY_TODO_ENABLED=1 로 켠다.',
    );
    return;
  }

  if (await isAlreadyRunning(runtime.port)) {
    console.log(`rocky-todo daemon already running on port ${runtime.port} — exiting`);
    return;
  }

  mkdirSync(runtime.dir, { recursive: true });
  const store = new TodoStore({ dbPath: join(runtime.dir, 'todo.db') });
  const api = buildTodoServer({ store });
  const mcp = createMcpFetchHandler({ store });

  const server = Bun.serve({
    port: runtime.port,
    // 기본 루프백 전용. `todo.host: "0.0.0.0"` opt-in 시 내부망 개방 (인증 없음 — 신뢰망 전제).
    // 0.0.0.0 은 루프백을 포함하므로 단일 인스턴스 가드/CLI 의 127.0.0.1 경로는 그대로 동작한다.
    hostname: runtime.host,
    development: false,
    routes: {
      '/': ui,
      '/mcp': (req) => mcp(req),
      '/api/*': (req) => api.fetch(req),
    },
    fetch: (req) => api.fetch(req),
  });

  const pidPath = join(runtime.dir, 'daemon.pid');
  writeFileSync(pidPath, String(process.pid));

  const shutdown = () => {
    void server.stop(true);
    store.close();
    if (existsSync(pidPath)) {
      rmSync(pidPath, { force: true });
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log(
    `rocky-todo daemon listening on http://${runtime.host}:${runtime.port} (db: ${runtime.dir})`,
  );
  if (runtime.host !== '127.0.0.1') {
    console.log('주의: 루프백 외 바인딩 — 같은 네트워크의 기기가 인증 없이 보드에 접근할 수 있다');
  }

  // 옵션: expose 에 tailscale 채널이 있을 때만 serve 보장 — 없으면 tailscale 을 일절 안 건드린다 (회사 환경 대비)
  if (runtime.expose.includes('tailscale-serve')) {
    ensureTailscaleServe(runtime.port);
  }
}

if (import.meta.main) {
  await startDaemon();
}
