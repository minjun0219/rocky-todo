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
 * 종료한다 (포트 자체가 락). 기본은 127.0.0.1 바인딩 — 인증 없음이 안전한 전제.
 * 노출(`todo.expose`)의 대상은 보드까지다: 이슈 생성은 사용자의 `gh` 인증을 빌리므로
 * 노출 여부와 무관하게 로컬 요청만 허용한다 — 그래서 두 핸들러에 peer 주소를 넘긴다
 * (`src/local-request.ts`).
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
  let server: ReturnType<typeof Bun.serve> | undefined;
  const api = buildTodoServer({ store });
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
      // peer 주소를 넘기는 이유: 이슈 생성은 사용자의 `gh` 인증을 빌리므로 노출된 표면에서
      // 실행되면 안 된다 (`src/local-request.ts`). 두 핸들러가 같은 판별을 공유한다.
      '/mcp': (req, server) => mcp(req, server.requestIP(req)?.address),
      '/api/*': (req, server) => api.fetch(req, server.requestIP(req)?.address),
      // 웹 UI 퍼머링크(`/rocky/12`)는 클라이언트 라우팅이라 서버에 그 경로가 없다.
      // 이 fallback 이 없으면 새로고침이 아래 `fetch`(REST) 로 떨어져 404 가 된다.
      // Bun 은 더 구체적인 패턴을 먼저 매칭하므로 `/api/*`·`/mcp` 는 영향받지 않는다.
      '/*': ui,
    },
    fetch: (req, server) => api.fetch(req, server.requestIP(req)?.address),
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
    console.log('      (GitHub 이슈 생성은 예외 — 로컬 요청만 허용된다)');
  }

  // 옵션: expose 에 tailscale 채널이 있을 때만 serve 보장 — 없으면 tailscale 을 일절 안 건드린다 (회사 환경 대비)
  if (runtime.expose.includes('tailscale-serve')) {
    ensureTailscaleServe(runtime.port);
  }
}

if (import.meta.main) {
  await startDaemon();
}
