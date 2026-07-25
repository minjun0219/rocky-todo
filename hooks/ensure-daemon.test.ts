import { expect, test } from 'bun:test';
import type { CliContext } from '../src/client';
import { type EnsureDeps, run } from './ensure-daemon';

test('데몬이 떠 있으면 spawn 하지 않는다 (no-op)', async () => {
  const spawned: CliContext[] = [];
  const deps: EnsureDeps = {
    checkHealth: async () => true,
    spawn: async (ctx) => {
      spawned.push(ctx);
    },
  };
  await run(deps);
  expect(spawned).toHaveLength(0);
});

test('데몬이 없으면 기동을 시도한다', async () => {
  const spawned: CliContext[] = [];
  const deps: EnsureDeps = {
    checkHealth: async () => false,
    spawn: async (ctx) => {
      spawned.push(ctx);
    },
  };
  await run(deps);
  expect(spawned).toHaveLength(1);
  // 루프백 컨텍스트로 기동한다 (포트는 user config/env 의존이라 값은 단언하지 않는다).
  expect(spawned[0]?.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
});
