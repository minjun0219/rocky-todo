import { describe, expect, test } from 'bun:test';
import { handoffPhase, isUnstarted, resolveDoingState } from './doing';
import type { AgentSession, SessionsResult } from './sessions';
import type { Handoff, Todo } from './store';

function session(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    pid: 1234,
    cwd: '/Users/x/dev/rocky-todo',
    kind: 'interactive',
    sessionId: 'sess-full-uuid',
    name: 'eelpout-a3',
    status: 'busy',
    startedAt: 0,
    ...overrides,
  };
}

function available(sessions: AgentSession[]): SessionsResult {
  return { available: true, sessions };
}

/** 세션 목록을 못 얻는 환경 — `claude` 미설치 등. */
const unavailable: SessionsResult = {
  available: false,
  sessions: [],
  reason: 'claude CLI 를 실행할 수 없다',
};

function doingTodo(
  overrides: Partial<Todo> = {},
): Pick<Todo, 'status' | 'doingBy' | 'doingSessionId'> {
  return {
    status: 'doing',
    doingBy: 'claude-code',
    doingSessionId: undefined,
    ...overrides,
  };
}

function handoff(overrides: Partial<Handoff> = {}): Handoff {
  return {
    id: 'h1',
    todoId: 't1',
    sessionId: 'sess-full-uuid',
    note: '',
    actor: 'logan',
    status: 'delivered',
    createdAt: '2026-07-30T00:00:00.000Z',
    deliveredAt: '2026-07-30T00:00:01.000Z',
    deliveredVia: 'stop',
    ...overrides,
  };
}

describe('resolveDoingState — 세션 귀속이 있는 경우', () => {
  test('세션이 살아 있고 busy 면 live', () => {
    const state = resolveDoingState(
      doingTodo({ doingSessionId: 'sess-full-uuid' }),
      'rocky-todo',
      available([session({ status: 'busy' })]),
    );
    expect(state).toBe('live');
  });

  test('세션은 있는데 idle 이면 idle — 턴이 끝났는데 done 이 안 왔다', () => {
    const state = resolveDoingState(
      doingTodo({ doingSessionId: 'sess-full-uuid' }),
      'rocky-todo',
      available([session({ status: 'idle' })]),
    );
    expect(state).toBe('idle');
  });

  test('background 세션이 state:done 이면 gone — 목록에 남아 있어도 죽은 것이다', () => {
    const state = resolveDoingState(
      doingTodo({ doingSessionId: 'sess-full-uuid' }),
      'rocky-todo',
      available([session({ kind: 'background', status: 'idle', state: 'done' })]),
    );
    expect(state).toBe('gone');
  });

  test('목록에 없으면 gone', () => {
    const state = resolveDoingState(
      doingTodo({ doingSessionId: 'sess-full-uuid' }),
      'rocky-todo',
      available([session({ sessionId: 'other' })]),
    );
    expect(state).toBe('gone');
  });

  test('spawn 이 남긴 짧은 8자 id 로도 세션을 찾는다', () => {
    // `createSpawnedHandoff` 는 full UUID 가 아니라 `claude attach` 가 받는 짧은 id 를
    // 저장한다 — sessionId 만 대조하면 살아 있는 spawn 세션이 전부 gone 으로 보인다.
    const state = resolveDoingState(
      doingTodo({ doingSessionId: 'a1b2c3d4' }),
      'rocky-todo',
      available([session({ id: 'a1b2c3d4', sessionId: 'a1b2c3d4-full-uuid', status: 'busy' })]),
    );
    expect(state).toBe('live');
  });
});

describe('resolveDoingState — 귀속이 없는 경우(보드 근사)', () => {
  test('그 보드에 세션이 하나도 없으면 gone', () => {
    const state = resolveDoingState(
      doingTodo(),
      'rocky-todo',
      available([session({ cwd: '/Users/x/dev/other-repo' })]),
    );
    expect(state).toBe('gone');
  });

  test('그 보드에 세션이 하나라도 있으면 unknown — 어느 것인지 모른다', () => {
    const state = resolveDoingState(
      doingTodo(),
      'rocky-todo',
      available([session({ cwd: '/Users/x/dev/rocky-todo' })]),
    );
    expect(state).toBe('unknown');
  });

  test('워크트리도 그 보드의 세션으로 친다 — cwd 경로 세그먼트 매칭', () => {
    const state = resolveDoingState(
      doingTodo(),
      'rocky-todo',
      available([session({ cwd: '/Users/x/dev/rocky-todo/.claude/worktrees/todo-12' })]),
    );
    expect(state).toBe('unknown');
  });

  test('사람이 잡아둔 doing 은 판정하지 않는다 — 사람은 세션 목록에 없다', () => {
    const state = resolveDoingState(
      doingTodo({ doingBy: 'logan' }),
      'rocky-todo',
      available([session({ cwd: '/Users/x/dev/other-repo' })]),
    );
    expect(state).toBe('unknown');
  });
});

describe('resolveDoingState — 판정하지 않는 경우', () => {
  test('세션 목록을 못 얻으면 무조건 unknown', () => {
    expect(
      resolveDoingState(doingTodo({ doingSessionId: 'sess-x' }), 'rocky-todo', unavailable),
    ).toBe('unknown');
    expect(resolveDoingState(doingTodo(), 'rocky-todo', unavailable)).toBe('unknown');
  });

  test('doing 이 아닌 todo 는 unknown', () => {
    const state = resolveDoingState(
      { status: 'todo', doingBy: undefined, doingSessionId: undefined },
      'rocky-todo',
      available([]),
    );
    expect(state).toBe('unknown');
  });
});

describe('handoffPhase', () => {
  test('pending / cancelled 는 status 를 그대로 쓴다', () => {
    expect(handoffPhase(handoff({ status: 'pending', deliveredAt: undefined }))).toBe('pending');
    expect(handoffPhase(handoff({ status: 'cancelled' }))).toBe('cancelled');
  });

  test('배달만 됐으면 delivered', () => {
    expect(handoffPhase(handoff())).toBe('delivered');
  });

  test('착수 기록이 있으면 accepted', () => {
    expect(handoffPhase(handoff({ acceptedAt: '2026-07-30T00:01:00.000Z' }))).toBe('accepted');
  });

  test('완료 기록이 있으면 completed', () => {
    const done = handoff({
      acceptedAt: '2026-07-30T00:01:00.000Z',
      completedAt: '2026-07-30T00:09:00.000Z',
    });
    expect(handoffPhase(done)).toBe('completed');
  });

  test('취소가 완료보다 세다 — 불가능한 조합을 표현하지 않는다', () => {
    expect(handoffPhase(handoff({ status: 'cancelled', completedAt: 'x' }))).toBe('cancelled');
  });
});

describe('isUnstarted', () => {
  test('세션이 사라졌으면 미착수다', () => {
    expect(isUnstarted(handoff(), available([session({ sessionId: 'other' })]))).toBe(true);
  });

  test('세션이 idle 이면 미착수다 — 턴이 끝났는데 아무것도 안 했다', () => {
    expect(isUnstarted(handoff(), available([session({ status: 'idle' })]))).toBe(true);
  });

  test('세션이 아직 일하는 중이면 조용하다 — 시간 임계값을 쓰지 않는다', () => {
    expect(isUnstarted(handoff(), available([session({ status: 'busy' })]))).toBe(false);
  });

  test('착수 기록이 있으면 미착수가 아니다', () => {
    const accepted = handoff({ acceptedAt: '2026-07-30T00:01:00.000Z' });
    expect(isUnstarted(accepted, available([session({ status: 'idle' })]))).toBe(false);
  });

  test('아직 배달 전(pending)이면 미착수가 아니다 — 그건 stale 이 볼 몫이다', () => {
    const pending = handoff({ status: 'pending', deliveredAt: undefined });
    expect(isUnstarted(pending, available([]))).toBe(false);
  });

  test('세션 목록을 못 얻으면 판정하지 않는다', () => {
    expect(isUnstarted(handoff(), unavailable)).toBe(false);
  });
});
