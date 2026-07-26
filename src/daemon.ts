import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import ui from './ui/index.html';
import { resolveTodoRuntimeConfig } from './config';
import { loadTodoConfig } from './rocky-config';
import { createMcpFetchHandler } from './mcp';
import { buildTodoServer } from './server';
import { TodoStore } from './store';
import { ensureTailscaleServe } from './tailscale';

/**
 * rocky-todo 데몬 — 시스템 유일 인스턴스, 단일 writer.
 *
 * 하나의 Bun fullstack 서버가 네 표면을 서빙한다:
 *   /            React 웹 UI (HTML import 자동 번들 — dist 없음)
 *   /*           같은 웹 UI — 퍼머링크(`/rocky/12`) 새로고침용 fallback
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
  // user rocky.json 의 todo 블록만 반영 — 데몬은 전역 단일 인스턴스라 project config 는 무시.
  const { todo } = loadTodoConfig();
  const runtime = resolveTodoRuntimeConfig(process.env, todo);

  if (await isAlreadyRunning(runtime.port)) {
    console.log(`rocky-todo daemon already running on port ${runtime.port} — exiting`);
    return;
  }

  mkdirSync(runtime.dir, { recursive: true });
  const store = new TodoStore({ dbPath: join(runtime.dir, 'todo.db') });
  // `server` 는 아래 Bun.serve 호출이 끝나야 채워지지만, 이 클로저가 실제로 불리는
  // 시점(요청 처리)은 반드시 그 이후다 — Bun.serve 가 반환하기 전에는 소켓이 열리지
  // 않는다. `POST /api/handoffs/claim` 의 루프백 판정에 필요한 원격 주소는 Request
  // 객체엔 없고 `server.requestIP(req)` 로만 얻을 수 있어(server.ts 의 `isLoopback`
  // 주석 참고) 여기서 DI 로 넘긴다.
  let server: ReturnType<typeof Bun.serve> | undefined;
  const api = buildTodoServer({
    store,
    isLoopback: (req) => {
      const addr = server?.requestIP(req);
      // 판별 불가(유닉스 소켓, 이미 닫힌 연결 등)는 루프백으로 간주한다 — 기능을
      // 죽이는 쪽보다 안전한 기본값.
      if (!addr) {
        return true;
      }
      return addr.address === '127.0.0.1' || addr.address === '::1';
    },
  });
  const mcp = createMcpFetchHandler({ store });

  // Bun 의 HTML 번들은 asset public path 를 process.cwd() 기준으로 계산한다.
  // CLI/브릿지가 호출자 cwd 를 상속시켜 spawn 하면 /../../<cwd> 로 깨지므로 ui 디렉터리로 고정한다.
  process.chdir(join(import.meta.dir, 'ui'));

  server = Bun.serve({
    port: runtime.port,
    // 기본 루프백 전용. `todo.host: "0.0.0.0"` opt-in 시 내부망 개방 (인증 없음 — 신뢰망 전제).
    // 0.0.0.0 은 루프백을 포함하므로 단일 인스턴스 가드/CLI 의 127.0.0.1 경로는 그대로 동작한다.
    hostname: runtime.host,
    development: false,
    routes: {
      '/': ui,
      '/mcp': (req) => mcp(req),
      '/api/*': (req) => api.fetch(req),
      // 웹 UI 퍼머링크(`/rocky/12`)는 클라이언트 라우팅이라 서버에 그 경로가 없다.
      // 이 fallback 이 없으면 새로고침이 아래 `fetch`(REST) 로 떨어져 404 가 된다.
      // Bun 은 더 구체적인 패턴을 먼저 매칭하므로 `/api/*`·`/mcp` 는 영향받지 않는다.
      '/*': ui,
    },
    fetch: (req) => api.fetch(req),
  });

  const pidPath = join(runtime.dir, 'daemon.pid');
  writeFileSync(pidPath, String(process.pid));

  const shutdown = () => {
    void server?.stop(true);
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
