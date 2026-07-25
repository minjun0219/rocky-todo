import { version as PACKAGE_VERSION } from '../package.json';
import {
  buildContext,
  type CliContext,
  type DaemonHealth,
  daemonHealth,
  ensureDaemon,
  stopDaemon,
} from '../src/client';
import { resolveTodoRuntimeConfig } from '../src/config';
import { loadTodoConfig } from '../src/rocky-config';

/**
 * SessionStart(startup) hook: rocky-todo 데몬이 안 떠 있으면 detached spawn 하고,
 * 떠 있더라도 구버전 코드로 돌고 있으면 내리고 현재 버전으로 재기동한다.
 *
 * 왜 버전을 보나: 데몬은 플러그인 캐시의 **버전 디렉터리**(`.../rocky-todo/<v>/src/daemon.ts`)
 * 에서 실행되고 프로세스는 그 설치본보다 오래 산다. health 만 보고 no-op 하면 플러그인을
 * 업데이트해도 구버전 데몬이 영원히 자리를 지켜 새 코드가 절대 안 뜬다.
 *
 * 원칙:
 * - fail-open: 어떤 에러든 조용히 exit 0 (세션 시작을 막지 않는다).
 * - 구 데몬을 못 내리면 재기동도 하지 않는다 — 보드가 없는 것보다 구버전이라도 있는 게 낫다.
 * - 첫 세션에서 http MCP 초기화보다 데몬 기동이 늦으면 그 세션의 도구는 `/mcp` 패널
 *   retry 로 붙는다 — 이 순서 미보장은 감안한다 (launchd 상주로도 해소 가능).
 *
 * health/spawn/stop 은 DI 로 주입 가능해 테스트에서 실제 프로세스 없이 검증한다.
 */

export type { DaemonHealth };

export interface EnsureDeps {
  /** 이 설치본의 버전 — 데몬이 보고한 값과 다르면 stale 로 본다. */
  version: string;
  /** 데몬 health 조회. 없으면 null. 기본은 client 의 `daemonHealth`. */
  checkHealth: (baseUrl: string) => Promise<DaemonHealth | null>;
  /** 데몬 기동(detached spawn + health 대기). 기본은 client 의 `ensureDaemon`. */
  spawn: (ctx: CliContext) => Promise<void>;
  /** 구버전 데몬 종료. 기본은 client 의 `stopDaemon`. */
  stop: (ctx: CliContext, health: DaemonHealth) => Promise<boolean>;
}

const DEFAULT_DEPS: EnsureDeps = {
  version: PACKAGE_VERSION,
  checkHealth: daemonHealth,
  spawn: ensureDaemon,
  stop: (ctx, health) => stopDaemon(ctx, health.pid),
};

/**
 * user rocky.json 의 todo 설정으로 접속 컨텍스트를 만들고, 데몬이 없거나 구버전이면
 * 현재 버전으로 (재)기동한다.
 * @param deps health/spawn/stop/version 주입 (테스트용). 기본은 실제 client 함수.
 */
export async function run(deps: EnsureDeps = DEFAULT_DEPS): Promise<void> {
  const { todo } = loadTodoConfig();
  const runtime = resolveTodoRuntimeConfig(process.env, todo);
  const ctx = buildContext({ port: runtime.port, dir: runtime.dir, actor: 'rocky-todo' });

  const running = await deps.checkHealth(ctx.baseUrl);
  if (running === null) {
    await deps.spawn(ctx);
    return;
  }
  if (running.version === deps.version) {
    return;
  }
  // stale — version 미보고(≤0.1.0) 도 여기로 온다.
  if (await deps.stop(ctx, running)) {
    await deps.spawn(ctx);
  }
}

if (import.meta.main) {
  run()
    .catch(() => {
      // fail-open — 훅 실패가 세션 시작을 막지 않는다.
    })
    .finally(() => {
      process.exit(0);
    });
}
