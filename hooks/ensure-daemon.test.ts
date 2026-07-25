import { expect, test } from 'bun:test';
import type { CliContext } from '../src/client';
import type { DaemonHealth, EnsureDeps } from './ensure-daemon';
import { run } from './ensure-daemon';

/** 지정한 동작만 덮어쓰는 기본 deps — 테스트가 관심 있는 축만 드러내게 한다. */
function deps(overrides: Partial<EnsureDeps> = {}): {
  deps: EnsureDeps;
  spawned: CliContext[];
  stopped: DaemonHealth[];
} {
  const spawned: CliContext[] = [];
  const stopped: DaemonHealth[] = [];
  return {
    spawned,
    stopped,
    deps: {
      version: '1.0.0',
      checkHealth: async () => ({ ok: true, name: 'rocky-todo', version: '1.0.0', pid: 111 }),
      spawn: async (ctx) => {
        spawned.push(ctx);
      },
      stop: async (_ctx, health) => {
        stopped.push(health);
        return true;
      },
      ...overrides,
    },
  };
}

test('데몬이 떠 있고 버전이 같으면 아무것도 하지 않는다 (no-op)', async () => {
  const { deps: d, spawned, stopped } = deps();
  await run(d);
  expect(spawned).toHaveLength(0);
  expect(stopped).toHaveLength(0);
});

test('데몬이 없으면 기동을 시도한다', async () => {
  const { deps: d, spawned, stopped } = deps({ checkHealth: async () => null });
  await run(d);
  expect(spawned).toHaveLength(1);
  expect(stopped).toHaveLength(0);
  // 루프백 컨텍스트로 기동한다 (포트는 user config/env 의존이라 값은 단언하지 않는다).
  expect(spawned[0]?.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
});

test('구버전 데몬이 살아 있으면 내리고 현재 버전으로 재기동한다', async () => {
  const {
    deps: d,
    spawned,
    stopped,
  } = deps({
    checkHealth: async () => ({ ok: true, name: 'rocky-todo', version: '0.9.0', pid: 222 }),
  });
  await run(d);
  expect(stopped).toHaveLength(1);
  expect(stopped[0]?.pid).toBe(222);
  expect(spawned).toHaveLength(1);
});

test('version 을 보고하지 않는 데몬도 stale 로 보고 재기동한다', async () => {
  // health 에 version 이 없던 시절(≤0.1.0)의 데몬 — 그대로 두면 영원히 안 올라온다.
  const {
    deps: d,
    spawned,
    stopped,
  } = deps({
    checkHealth: async () => ({ ok: true, name: 'rocky-todo' }),
  });
  await run(d);
  expect(stopped).toHaveLength(1);
  expect(spawned).toHaveLength(1);
});

test('구버전 데몬을 못 내리면 재기동하지 않는다 (fail-open — 세션을 막지 않는다)', async () => {
  const attempts: DaemonHealth[] = [];
  const { deps: d, spawned } = deps({
    checkHealth: async () => ({ ok: true, name: 'rocky-todo', version: '0.9.0', pid: 333 }),
    stop: async (_ctx, health) => {
      attempts.push(health);
      return false;
    },
  });
  await run(d);
  expect(attempts).toHaveLength(1);
  expect(spawned).toHaveLength(0);
});
