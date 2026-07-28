import { describe, expect, test } from 'bun:test';
import {
  type AgentSession,
  createCachedListSessions,
  listSessions,
  matchBoard,
  type RunCommand,
} from './sessions';

const SAMPLE = JSON.stringify([
  {
    pid: 19921,
    cwd: '/Users/minjun/dev/workspaces/rocky-todo',
    kind: 'interactive',
    startedAt: 1784964736538,
    sessionId: 'bc29bdd3-ba90-4547-96eb-9db0af935e6c',
    name: 'rocky-todo-1e',
    status: 'idle',
  },
  {
    pid: 32551,
    cwd: '/Users/minjun/orca/workspaces/rocky-todo/eelpout',
    kind: 'interactive',
    startedAt: 1785067158470,
    sessionId: '5591d3d2-9ac5-49c4-96b2-2b3e7bdcfce6',
    name: 'eelpout-a3',
    status: 'busy',
  },
]);

const SAMPLE_BACKGROUND = JSON.stringify([
  {
    pid: 24075,
    id: '5acaaaeb',
    cwd: '/repo/.claude/worktrees/todo-16',
    kind: 'background',
    startedAt: 1785151478042,
    sessionId: '5acaaaeb-1275-48d1-8f4c-3970c33ff6dc',
    name: 'rocky-todo-16',
    status: 'idle',
    state: 'done',
  },
]);

const runWith =
  (stdout: string, ok = true): RunCommand =>
  () => ({ ok, stdout, stderr: '' });

describe('listSessions', () => {
  test('claude agents --json 출력을 파싱한다', () => {
    const result = listSessions(runWith(SAMPLE));
    expect(result.available).toBe(true);
    expect(result.sessions).toHaveLength(2);
    expect(result.sessions[0]?.name).toBe('rocky-todo-1e');
    expect(result.sessions[1]?.status).toBe('busy');
  });

  test('세션이 하나도 없으면 available 이지만 빈 목록', () => {
    const result = listSessions(runWith('[]'));
    expect(result.available).toBe(true);
    expect(result.sessions).toEqual([]);
  });

  test('CLI 실행 실패는 available:false + reason', () => {
    const result = listSessions(() => ({ ok: false, stdout: '', stderr: 'command not found' }));
    expect(result.available).toBe(false);
    expect(result.reason).toContain('command not found');
    expect(result.sessions).toEqual([]);
  });

  test('깨진 JSON 은 available:false', () => {
    const result = listSessions(runWith('not json'));
    expect(result.available).toBe(false);
    expect(result.sessions).toEqual([]);
  });

  test('필수 필드가 빠진 항목은 건너뛴다', () => {
    const result = listSessions(runWith(JSON.stringify([{ pid: 1 }, JSON.parse(SAMPLE)[0]])));
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]?.name).toBe('rocky-todo-1e');
  });
});

describe('matchBoard', () => {
  const sessions = listSessions(runWith(SAMPLE)).sessions;

  test('경로 세그먼트가 보드 key 와 같으면 후보다 — 워크트리도 잡는다', () => {
    const matched = matchBoard(sessions, 'rocky-todo');
    expect(matched.map((s: AgentSession) => s.name)).toEqual(['rocky-todo-1e', 'eelpout-a3']);
  });

  test('basename 만 맞는 게 아니라 중간 세그먼트도 센다', () => {
    expect(matchBoard(sessions, 'eelpout').map((s: AgentSession) => s.name)).toEqual([
      'eelpout-a3',
    ]);
  });

  test('일치가 없으면 빈 배열', () => {
    expect(matchBoard(sessions, 'forses')).toEqual([]);
  });

  test('부분 문자열은 일치로 치지 않는다', () => {
    expect(matchBoard(sessions, 'rocky')).toEqual([]);
  });
});

describe('createCachedListSessions', () => {
  test('TTL 창 안의 반복 호출은 실제 spawn(run) 을 한 번만 부른다', () => {
    let calls = 0;
    const run: RunCommand = () => {
      calls += 1;
      return { ok: true, stdout: '[]', stderr: '' };
    };
    const cached = createCachedListSessions(3_000, run);

    cached();
    cached();
    cached();

    expect(calls).toBe(1);
  });

  test('TTL 이 지나면 다시 spawn 한다', async () => {
    let calls = 0;
    const run: RunCommand = () => {
      calls += 1;
      return { ok: true, stdout: '[]', stderr: '' };
    };
    const cached = createCachedListSessions(10, run);

    cached();
    await new Promise((resolve) => setTimeout(resolve, 30));
    cached();

    expect(calls).toBe(2);
  });
});

describe('listSessions — background 필드', () => {
  test('id 와 state 를 싣는다', () => {
    const result = listSessions(runWith(SAMPLE_BACKGROUND));
    expect(result.sessions[0]?.id).toBe('5acaaaeb');
    expect(result.sessions[0]?.state).toBe('done');
  });

  test('interactive 세션처럼 id/state 가 없으면 undefined 로 둔다', () => {
    const result = listSessions(runWith(SAMPLE));
    expect(result.sessions[0]?.id).toBeUndefined();
    expect(result.sessions[0]?.state).toBeUndefined();
  });
});
