import { buildContext, type CliContext, ensureDaemon, health } from '../src/client';
import { resolveTodoRuntimeConfig } from '../src/config';
import { loadTodoConfig } from '../src/rocky-config';

/**
 * SessionStart(startup) hook: rocky-todo 데몬이 안 떠 있으면 detached spawn 한다.
 *
 * 원칙:
 * - fail-open: 어떤 에러든 조용히 exit 0 (세션 시작을 막지 않는다).
 * - 이미 떠 있으면 no-op (health 확인 후 즉시 반환).
 * - 첫 세션에서 http MCP 초기화보다 데몬 기동이 늦으면 그 세션의 도구는 `/mcp` 패널
 *   retry 로 붙는다 — 이 순서 미보장은 감안한다 (launchd 상주로도 해소 가능).
 *
 * spawn/health 는 DI 로 주입 가능해 테스트에서 실제 프로세스 없이 검증한다.
 */

export interface EnsureDeps {
  /** 데몬 health 확인. 기본은 client 의 `health`. */
  checkHealth: (baseUrl: string) => Promise<boolean>;
  /** 데몬 기동(detached spawn + health 대기). 기본은 client 의 `ensureDaemon`. */
  spawn: (ctx: CliContext) => Promise<void>;
}

const DEFAULT_DEPS: EnsureDeps = { checkHealth: health, spawn: ensureDaemon };

/**
 * user rocky.json 의 todo 설정으로 접속 컨텍스트를 만들고, 데몬이 없으면 기동을 시도한다.
 * @param deps health/spawn 주입 (테스트용). 기본은 실제 client 함수.
 */
export async function run(deps: EnsureDeps = DEFAULT_DEPS): Promise<void> {
  const { todo } = loadTodoConfig();
  const runtime = resolveTodoRuntimeConfig(process.env, todo);
  const ctx = buildContext({ port: runtime.port, dir: runtime.dir, actor: 'rocky-todo' });
  if (await deps.checkHealth(ctx.baseUrl)) {
    return;
  }
  await deps.spawn(ctx);
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
