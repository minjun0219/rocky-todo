import { describe, expect, test } from 'bun:test';
import type { ClaimedHandoff } from '../src/store';
import { run, type StopDeps } from './handoff-stop';

const CLAIMED: ClaimedHandoff = {
  handoff: {
    id: 'h1',
    todoId: 't1',
    sessionId: 'sess-1',
    sessionName: 'eelpout-a3',
    note: '',
    actor: 'logan',
    status: 'delivered',
    createdAt: '2026-07-26T12:00:00.000Z',
  },
  todoRef: 'rocky-todo#11',
  todoTitle: '핸드오프 대상',
  remaining: 0,
};

const deps = (over: Partial<StopDeps> = {}): StopDeps => ({
  claim: async () => CLAIMED,
  ...over,
});

describe('handoff-stop', () => {
  test('claim 이 있으면 주입문을 돌려준다', async () => {
    const reason = await run({ session_id: 'sess-1' }, deps());
    expect(reason).toContain('rocky-todo#11');
    expect(reason).toContain('핸드오프 대상');
  });

  test('claim 이 없으면 null — 세션을 막지 않는다', async () => {
    const reason = await run({ session_id: 'sess-1' }, deps({ claim: async () => null }));
    expect(reason).toBeNull();
  });

  test('서브에이전트 컨텍스트에서는 claim 자체를 하지 않는다', async () => {
    let called = false;
    const reason = await run(
      { session_id: 'sess-1', agent_type: 'Explore' },
      deps({
        claim: async () => {
          called = true;
          return CLAIMED;
        },
      }),
    );
    expect(reason).toBeNull();
    expect(called).toBe(false);
  });

  test('session_id 가 없으면 아무것도 하지 않는다', async () => {
    expect(await run({}, deps())).toBeNull();
  });

  test('claim 이 던져도 fail-open — null 을 돌려준다', async () => {
    const reason = await run(
      { session_id: 'sess-1' },
      deps({
        claim: async () => {
          throw new Error('daemon down');
        },
      }),
    );
    expect(reason).toBeNull();
  });
});
