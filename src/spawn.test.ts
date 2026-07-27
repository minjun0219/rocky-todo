import { describe, expect, test } from 'bun:test';
import type { AgentSession } from './sessions';
import {
  buildSpawnCommand,
  createRecentSpawns,
  findLiveSessionAt,
  parseBackgroundId,
  RECENT_SPAWN_TTL_MS,
  type RunInDir,
  runInDir,
  SPAWN_TIMEOUT_MS,
  spawnBackgroundSession,
  worktreeNameFor,
  worktreePathFor,
} from './spawn';

const session = (over: Partial<AgentSession>): AgentSession => ({
  pid: 1,
  cwd: '/repo',
  kind: 'background',
  sessionId: 'aaaaaaaa-0000-0000-0000-000000000000',
  name: 'n',
  status: 'idle',
  startedAt: 0,
  ...over,
});

describe('worktree 이름·경로', () => {
  test('번호로 결정론적인 이름을 만든다', () => {
    expect(worktreeNameFor(16)).toBe('todo-16');
  });

  test('Claude Code 규약 경로를 만든다', () => {
    expect(worktreePathFor('/Users/x/dev/rocky-todo', 16)).toBe(
      '/Users/x/dev/rocky-todo/.claude/worktrees/todo-16',
    );
  });

  test('보드 경로 끝의 슬래시를 흡수한다', () => {
    expect(worktreePathFor('/Users/x/dev/rocky-todo/', 16)).toBe(
      '/Users/x/dev/rocky-todo/.claude/worktrees/todo-16',
    );
  });
});

describe('parseBackgroundId', () => {
  test('backgrounded 줄에서 짧은 id 를 꺼낸다', () => {
    const stdout = [
      'backgrounded · 5acaaaeb · rocky-todo-16',
      '  claude agents             list sessions',
    ].join('\n');
    expect(parseBackgroundId(stdout)).toBe('5acaaaeb');
  });

  test('경고 줄이 앞에 있어도 찾는다', () => {
    const stdout = 'warning: something\nbackgrounded · 8c8819b4 · n';
    expect(parseBackgroundId(stdout)).toBe('8c8819b4');
  });

  test('형식이 다르면 undefined', () => {
    expect(parseBackgroundId('nothing here')).toBeUndefined();
  });
});

describe('findLiveSessionAt', () => {
  const worktree = '/repo/.claude/worktrees/todo-16';

  test('같은 워크트리에서 도는 background 세션을 찾는다', () => {
    const found = findLiveSessionAt(
      [session({ cwd: worktree, state: 'working', id: 'aaaaaaaa' })],
      worktree,
    );
    expect(found?.id).toBe('aaaaaaaa');
  });

  test('끝난 세션(state=done)은 무시한다', () => {
    expect(
      findLiveSessionAt([session({ cwd: worktree, state: 'done' })], worktree),
    ).toBeUndefined();
  });

  test('state 가 없는 interactive 세션은 살아있는 것으로 본다', () => {
    const found = findLiveSessionAt(
      [session({ cwd: worktree, kind: 'interactive', name: 'hand-opened' })],
      worktree,
    );
    expect(found?.name).toBe('hand-opened');
  });

  test('다른 경로의 세션은 잡지 않는다', () => {
    expect(findLiveSessionAt([session({ cwd: '/repo' })], worktree)).toBeUndefined();
  });
});

describe('buildSpawnCommand', () => {
  test('--bg --worktree -n 과 프롬프트를 순서대로 조립한다', () => {
    expect(
      buildSpawnCommand({
        worktreeName: 'todo-16',
        sessionName: 'rocky-todo-16',
        prompt: '# rocky-todo: 보드에서 도착한 작업 요청',
      }),
    ).toEqual([
      'claude',
      '--bg',
      '--worktree',
      'todo-16',
      '-n',
      'rocky-todo-16',
      '# rocky-todo: 보드에서 도착한 작업 요청',
    ]);
  });

  test('--permission-mode 를 넣지 않는다 — 사용자 기본 설정을 따른다', () => {
    const cmd = buildSpawnCommand({ worktreeName: 'w', sessionName: 's', prompt: 'p' });
    expect(cmd).not.toContain('--permission-mode');
  });
});

describe('spawnBackgroundSession', () => {
  test('보드 경로를 cwd 로 실행하고 짧은 id 를 돌려준다', async () => {
    let seenCwd = '';
    let seenCmd: string[] = [];
    const run: RunInDir = async (cmd, cwd) => {
      seenCwd = cwd;
      seenCmd = cmd;
      return { ok: true, stdout: 'backgrounded · 5acaaaeb · rocky-todo-16', stderr: '' };
    };
    const id = await spawnBackgroundSession(
      { boardPath: '/repo', worktreeName: 'todo-16', sessionName: 'rocky-todo-16', prompt: 'p' },
      run,
    );
    expect(id).toBe('5acaaaeb');
    expect(seenCwd).toBe('/repo');
    expect(seenCmd[0]).toBe('claude');
  });

  test('SPAWN_TIMEOUT_MS 를 실행기에 그대로 넘긴다', async () => {
    let seenTimeout = -1;
    const run: RunInDir = async (_cmd, _cwd, timeoutMs) => {
      seenTimeout = timeoutMs;
      return { ok: true, stdout: 'backgrounded · 5acaaaeb · s', stderr: '' };
    };
    await spawnBackgroundSession(
      { boardPath: '/repo', worktreeName: 'w', sessionName: 's', prompt: 'p' },
      run,
    );
    expect(seenTimeout).toBe(SPAWN_TIMEOUT_MS);
    expect(SPAWN_TIMEOUT_MS).toBe(30_000);
  });

  test('0 아닌 종료면 stderr 를 담아 던진다', async () => {
    const run: RunInDir = async () => ({
      ok: false,
      stdout: '',
      stderr: 'claude: command not found',
    });
    expect(
      spawnBackgroundSession(
        { boardPath: '/repo', worktreeName: 'w', sessionName: 's', prompt: 'p' },
        run,
      ),
    ).rejects.toThrow(/command not found/);
  });

  test('id 를 못 읽으면 던진다 — 성공했다고 볼 수 없다', async () => {
    const run: RunInDir = async () => ({ ok: true, stdout: '???', stderr: '' });
    expect(
      spawnBackgroundSession(
        { boardPath: '/repo', worktreeName: 'w', sessionName: 's', prompt: 'p' },
        run,
      ),
    ).rejects.toThrow();
  });
});

/**
 * 기본 실행기는 실제 프로세스를 띄워야 계약이 검증된다 — 이 실패 모드(자손이 파이프를
 * 무는 것)는 주입 층에서 흉내낼 수 없기 때문이다. `claude` 대신 어디에나 있는 `sh` 만
 * 쓰므로 `claude` 없는 머신에서도 그대로 통과한다(`src/client.test.ts` 가 죽은 pid 를
 * 만들려고 실제 프로세스를 띄우는 것과 같은 결).
 */
describe('runInDir (기본 실행기)', () => {
  const here = import.meta.dir;

  test('자손이 stdout 파이프를 물고 있어도 마감 안에 결과를 준다', async () => {
    const startedAt = Date.now();
    // `claude --bg` 의 모양: 한 줄 찍고 즉시 반환하지만, detach 된 자손이 stdout fd 를
    // 계속 물고 있다. `new Response(stream).text()` 였다면 여기서 영영 매달린다.
    const result = await runInDir(
      ['sh', '-c', 'echo "backgrounded · 5acaaaeb · demo"; sleep 5 & exit 0'],
      here,
      5_000,
    );
    const elapsed = Date.now() - startedAt;
    expect(result.ok).toBe(true);
    expect(parseBackgroundId(result.stdout)).toBe('5acaaaeb');
    expect(elapsed).toBeLessThan(3_000);
  });

  test('평범한 명령은 stdout 을 온전히 돌려준다', async () => {
    const result = await runInDir(['sh', '-c', 'echo one; echo two'], here, 5_000);
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe('one\ntwo\n');
  });

  test('0 아닌 종료면 ok=false 이고 stderr 를 담는다', async () => {
    const result = await runInDir(['sh', '-c', 'echo boom >&2; exit 3'], here, 5_000);
    expect(result.ok).toBe(false);
    expect(result.stderr).toMatch(/boom/);
  });

  test('마감 안에 끝나지 않으면 실패로 돌려준다', async () => {
    const startedAt = Date.now();
    const result = await runInDir(['sh', '-c', 'sleep 5'], here, 300);
    expect(result.ok).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  });

  test('실행할 수 없는 명령은 던지지 않고 ok=false 로 돌아온다', async () => {
    const result = await runInDir(['rocky-todo-no-such-binary'], here, 1_000);
    expect(result.ok).toBe(false);
    expect(result.stderr).not.toBe('');
  });
});

describe('createRecentSpawns', () => {
  const worktree = '/repo/.claude/worktrees/todo-16';

  test('기억한 적 없는 워크트리는 recent 가 아니다', () => {
    expect(createRecentSpawns().isRecent(worktree)).toBe(false);
  });

  test('방금 기억한 워크트리는 TTL 안에서 recent 다', () => {
    let now = 1_000;
    const recent = createRecentSpawns(60_000, () => now);
    recent.remember(worktree);
    expect(recent.isRecent(worktree)).toBe(true);
    now += 59_999;
    expect(recent.isRecent(worktree)).toBe(true);
  });

  test('TTL 이 지나면 recent 가 아니다', () => {
    let now = 1_000;
    const recent = createRecentSpawns(60_000, () => now);
    recent.remember(worktree);
    now += 60_000;
    expect(recent.isRecent(worktree)).toBe(false);
  });

  test('다른 워크트리는 서로 간섭하지 않는다', () => {
    const recent = createRecentSpawns(60_000, () => 0);
    recent.remember(worktree);
    expect(recent.isRecent('/repo/.claude/worktrees/todo-17')).toBe(false);
  });

  test('forget 은 예약을 되돌린다 — 실패한 spawn 이 창을 잡아먹지 않게', () => {
    const recent = createRecentSpawns(60_000, () => 1_000);
    recent.remember(worktree);
    expect(recent.isRecent(worktree)).toBe(true);
    recent.forget(worktree);
    expect(recent.isRecent(worktree)).toBe(false);
  });

  test('기억한 적 없는 워크트리를 forget 해도 문제없다', () => {
    const recent = createRecentSpawns(60_000, () => 1_000);
    expect(() => recent.forget(worktree)).not.toThrow();
    expect(recent.isRecent(worktree)).toBe(false);
  });

  test('기본 TTL 은 60초', () => {
    expect(RECENT_SPAWN_TTL_MS).toBe(60_000);
  });
});
