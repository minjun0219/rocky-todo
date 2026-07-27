import type { AgentSession, RunResult } from './sessions';

/**
 * 보드에서 백그라운드 Claude Code 세션을 띄운다.
 *
 * 워크트리 생성·재사용·정리는 전부 Claude Code 의 `-w/--worktree` 가 한다 — 데몬은 git 을
 * 만지지 않는다. 이름을 `todo-<번호>` 로 결정론적으로 계산하는 것이 "이 todo 의 워크트리"
 * 라는 기억을 대신하며, 같은 이름을 다시 주면 Claude Code 가 기존 워크트리를 재사용한다.
 *
 * `src/sessions.ts` 와 같은 형태로 외부 명령은 주입 가능한 실행기를 거친다 — `claude` 가
 * 없는 머신에서도 전 테스트가 통과한다.
 */

/** Claude Code 가 워크트리를 만드는 자리 — 레포 안의 이 경로다. */
const WORKTREE_DIR = '.claude/worktrees';

/** `--bg` 가 stdout 첫 줄에 찍는 형식: `backgrounded · 5acaaaeb · <name>`. */
const BACKGROUNDED = /^backgrounded\s+·\s+(\S+)\s+·/m;

/**
 * `claude --bg` 는 즉시 반환하지만, 프로세스 기동 자체가 늦어질 여지를 남긴다
 * (대형 레포의 `git worktree add` 가 그 안에 들어있다).
 */
export const SPAWN_TIMEOUT_MS = 30_000;

/** 방금 띄운 워크트리를 기억해 두는 기간 — `agents --json` 등록 지연을 덮는다. */
export const RECENT_SPAWN_TTL_MS = 60_000;

export interface SpawnCommandInput {
  worktreeName: string;
  sessionName: string;
  prompt: string;
}

export interface SpawnInput extends SpawnCommandInput {
  /** 메인 레포 절대경로 — 이 자리에서 명령을 실행한다. */
  boardPath: string;
}

/**
 * `cwd` 를 지정해 외부 명령을 실행한다. `src/sessions.ts` 의 `RunCommand` 에 cwd 를 더한 꼴.
 *
 * 동기가 아니라 `Promise` 다 — `claude --bg` 는 워크트리 생성까지 포함해 최악 30초를
 * 쓸 수 있고, 그동안 `Bun.spawnSync` 는 데몬 전체(MCP·SSE·CLI·다른 세션 훅)를 멈춘다.
 * `src/sessions.ts` 가 실측 220ms 짜리 동기 블로킹을 캐시로 눌러야 했던 것과 같은 이유다.
 */
export type RunInDir = (cmd: string[], cwd: string, timeoutMs: number) => Promise<RunResult>;

/**
 * 직접 자식이 끝난 뒤 파이프에 남은 출력을 마저 긁어모으는 유예.
 *
 * 이 유예가 지나도 닫히지 않는 파이프는 **자손이 물고 있는 것**으로 본다 — 우리가
 * 기다려 줄 이유가 없는 상대다. `claude --bg` 가 정확히 그 모양이라 짧아도 충분하다:
 * 우리가 읽어야 하는 것은 자식이 종료 전에 이미 써 둔 `backgrounded …` 한 줄뿐이다.
 */
const EXIT_DRAIN_GRACE_MS = 250;

interface Deadline {
  reached: Promise<void>;
  cancel: () => void;
}

/** 취소 가능한 타이머 대기 — 정상 경로에서 타이머를 남기지 않으려고 cancel 을 쥔다. */
function createDeadline(ms: number): Deadline {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const reached = new Promise<void>((resolve) => {
    handle = setTimeout(resolve, ms);
  });
  return { reached, cancel: () => clearTimeout(handle) };
}

/**
 * 스트림을 끝까지, 단 `stop` 이 resolve 되면 거기까지만 읽는다.
 *
 * `new Response(stream).text()` 를 쓰지 않는 이유가 이것 — 그 편의 함수는 파이프의
 * **모든** 쓰기 끝이 닫혀야 resolve 한다. 직접 자식이 종료해도 detach 된 손자가 fd 를
 * 물고 있으면 영원히 매달린다.
 */
async function readTextUntil(
  stream: ReadableStream<Uint8Array> | undefined,
  stop: Promise<unknown>,
): Promise<string> {
  if (!stream) {
    return '';
  }
  const reader = stream.getReader();
  // `stop` 이 이기면 undefined — 읽기 결과에는 없는 값이라 그대로 종료 신호가 된다.
  const halt = stop.then(() => undefined);
  const decoder = new TextDecoder();
  let out = '';
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), halt]);
      if (!next || next.done) {
        break;
      }
      out += decoder.decode(next.value, { stream: true });
    }
    out += decoder.decode();
  } catch {
    // 읽기 실패로 결과 전체를 버리지 않는다 — 여기까지 읽은 부분 출력을 돌려준다.
  } finally {
    void reader.cancel().catch(() => {});
  }
  return out;
}

/**
 * 기본 실행기 — `timeoutMs` 안에 **반드시** 결과를 돌려준다.
 *
 * 무한 대기의 자리는 파이프 읽기 하나뿐이라, 읽기를 두 마감에 묶는다: 직접 자식이
 * 종료하면 `EXIT_DRAIN_GRACE_MS` 만 더 긁고 그만두고, 자식이 종료조차 하지 않으면
 * `timeoutMs` 에서 끊는다(그 시각엔 `Bun.spawn` 의 `timeout` 이 자식을 이미 죽인다).
 * 그래서 `claude --bg` 의 백그라운드 세션이 stdout fd 를 계속 물고 있어도 라우트는
 * 매달리지 않는다 — "세션은 떴는데 응답이 없다" 는 조용한 유실이 구조적으로 없다.
 *
 * 마감에 걸렸는데 자식의 종료 코드조차 못 봤으면 실패로 돌려준다 — 무엇이 떴는지
 * 가리킬 수 없는 상태를 성공이라 부를 수 없다(`spawnBackgroundSession` 참고).
 */
export const runInDir: RunInDir = async (cmd, cwd, timeoutMs) => {
  const deadline = createDeadline(timeoutMs);
  let grace: Deadline | undefined;
  try {
    const proc = Bun.spawn({ cmd, cwd, stdout: 'pipe', stderr: 'pipe', timeout: timeoutMs });
    const stop = Promise.race([
      deadline.reached,
      proc.exited.then(() => {
        grace = createDeadline(EXIT_DRAIN_GRACE_MS);
        return grace.reached;
      }),
    ]);
    const [stdout, stderr] = await Promise.all([
      readTextUntil(proc.stdout, stop),
      readTextUntil(proc.stderr, stop),
    ]);
    const exitCode = await Promise.race([proc.exited, deadline.reached.then(() => undefined)]);
    if (exitCode === undefined) {
      const reason = `${timeoutMs}ms 안에 끝나지 않았다`;
      const trimmed = stderr.trim();
      return { ok: false, stdout, stderr: trimmed === '' ? reason : `${trimmed}\n${reason}` };
    }
    return { ok: exitCode === 0, stdout, stderr };
  } catch (error) {
    return {
      ok: false,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
    };
  } finally {
    deadline.cancel();
    grace?.cancel();
  }
};

/** todo 번호 → 워크트리 이름. 결정론적이라 같은 todo 는 늘 같은 워크트리로 간다. */
export function worktreeNameFor(todoNumber: number): string {
  return `todo-${todoNumber}`;
}

/** 워크트리의 절대경로 — Claude Code 규약(`<repo>/.claude/worktrees/<name>`)을 따른다. */
export function worktreePathFor(boardPath: string, todoNumber: number): string {
  const base = boardPath.replace(/\/+$/, '');
  return `${base}/${WORKTREE_DIR}/${worktreeNameFor(todoNumber)}`;
}

/** `--bg` stdout 에서 짧은 id 를 꺼낸다. 형식이 다르면 undefined. */
export function parseBackgroundId(stdout: string): string | undefined {
  return BACKGROUNDED.exec(stdout)?.[1];
}

/**
 * 그 워크트리에서 아직 돌고 있는 세션을 찾는다 — 있으면 새로 띄우면 안 된다.
 *
 * 두 에이전트가 한 워크트리의 파일을 같이 고치는 것을 막는 가드다. `state` 는 background
 * 세션에만 붙으므로, 없으면(= interactive) 살아있는 것으로 본다 — 사람이 그 워크트리를
 * 터미널에서 열어둔 경우가 정확히 그 꼴이고, 그때야말로 끼어들면 안 된다.
 */
export function findLiveSessionAt(
  sessions: AgentSession[],
  worktreePath: string,
): AgentSession | undefined {
  return sessions.find((s) => s.cwd === worktreePath && s.state !== 'done');
}

/**
 * 명령줄을 조립한다.
 *
 * `--permission-mode` 를 넣지 않는 것이 의도다 — 사용자 settings 의 `permissions.defaultMode`
 * 를 그대로 따른다. 보드에서 모드를 고르게 하면 `bypassPermissions` 를 원격 화면에서 고를 수
 * 있는 자리가 생긴다.
 */
export function buildSpawnCommand(input: SpawnCommandInput): string[] {
  return [
    'claude',
    '--bg',
    '--worktree',
    input.worktreeName,
    '-n',
    input.sessionName,
    input.prompt,
  ];
}

/**
 * 백그라운드 세션을 띄우고 짧은 id 를 돌려준다.
 *
 * @throws 명령이 실패했거나 stdout 에서 id 를 읽지 못하면. id 를 못 읽으면 성공으로 볼 수
 *   없다 — 보드가 배달됐다고 말하는데 무엇이 떴는지 가리킬 수 없는 상태가 된다.
 */
export async function spawnBackgroundSession(
  input: SpawnInput,
  run: RunInDir = runInDir,
): Promise<string> {
  const result = await run(buildSpawnCommand(input), input.boardPath, SPAWN_TIMEOUT_MS);
  if (!result.ok) {
    const reason = `${result.stderr || result.stdout}`.trim() || 'claude --bg 실행에 실패했다';
    throw new Error(reason);
  }
  const id = parseBackgroundId(result.stdout);
  if (!id) {
    throw new Error(`세션이 떴는지 확인할 수 없다 — claude --bg 출력: ${result.stdout.trim()}`);
  }
  return id;
}

/** 방금 띄운 워크트리를 기억하는 창 — `createRecentSpawns` 가 만든다. */
export interface RecentSpawns {
  /** TTL 안에 이 워크트리로 세션을 띄운(띄우는 중인) 적이 있는가. */
  isRecent: (worktreePath: string) => boolean;
  /**
   * 이 워크트리를 이번 spawn 이 **예약**한다. 실행 전(동기 구간)에 부른다 — 뒤로 미루면
   * `await` 창에 겹쳐 들어온 요청이 게이트를 같이 통과한다.
   */
  remember: (worktreePath: string) => void;
  /**
   * 예약을 되돌린다 — spawn 이 실패했을 때. 실패한 시도가 60초 동안 재시도를 막으면
   * 안 되고, 그렇다고 예약을 늦출 수도 없다(그게 곧 동시 실행 창이다).
   */
  forget: (worktreePath: string) => void;
}

/**
 * "방금 띄운 워크트리" 를 데몬 메모리에 짧게 기억하는 클로저를 만든다.
 *
 * 동시 실행 가드는 `claude agents --json` 목록에 의존하는데, 새로 뜬 세션이 그 목록에
 * 등록되기까지의 지연은 실측된 바 없다. 캐시를 우회해도 이 지연은 남으므로, 사용자가
 * 버튼을 두 번 누르거나 두 탭에서 누르면 가드를 그대로 통과해 **한 워크트리를 두
 * 에이전트가 고치는** 상태가 된다 — 설계가 "그대로 사고" 라고 부른 그것이다.
 *
 * 그래서 이 창 안의 재요청은 **409 로 거절한다**. 재사용 분기로 보내면 안 된다: 재사용은
 * 목록에서 찾은 세션의 full `sessionId` 로 pending 을 만드는데, 방금 띄운 세션에 대해
 * 우리가 아는 것은 짧은 8자 id 뿐이고, 세션의 `Stop` 훅은 full UUID 로 claim 한다
 * (`hooks/handoff-stop.ts`) — 짧은 id 로 만든 pending 은 영영 배달되지 않는다.
 *
 * 그래서 이 창은 **실행 전에 잡는 예약**이다(`remember` → 실패하면 `forget`). 성공한
 * spawn 뒤에 기록하면 `await` 가 열어 둔 창에 두 요청이 나란히 들어와 둘 다 통과한다.
 *
 * `createCachedListSessions` 와 같은 결로 상태는 클로저 안에만 있다 — 데몬 프로세스
 * 수명 동안만 유효하고, 재기동하면 자연히 비워진다. 키는 워크트리 경로(= todo 하나)라
 * 항목 수는 "이 데몬이 세션을 띄운 적 있는 todo" 만큼으로 묶인다. 만료 청소는 조회할
 * 때만 일어나므로 다시 조회되지 않는 항목은 만료된 채 남는다 — 그 크기라면 무해하다.
 *
 * @param ttlMs 기억하는 기간. 기본 `RECENT_SPAWN_TTL_MS`(60초).
 * @param now 시계 — 테스트가 시간을 통제할 수 있게 주입한다.
 */
export function createRecentSpawns(
  ttlMs: number = RECENT_SPAWN_TTL_MS,
  now: () => number = Date.now,
): RecentSpawns {
  const spawnedAt = new Map<string, number>();
  return {
    isRecent: (worktreePath) => {
      const at = spawnedAt.get(worktreePath);
      if (at === undefined) {
        return false;
      }
      if (now() - at >= ttlMs) {
        // 만료된 항목은 조회하는 김에 버린다.
        spawnedAt.delete(worktreePath);
        return false;
      }
      return true;
    },
    remember: (worktreePath) => {
      spawnedAt.set(worktreePath, now());
    },
    forget: (worktreePath) => {
      spawnedAt.delete(worktreePath);
    },
  };
}
