/**
 * 활성 Claude Code 세션 목록 — `claude agents --json` 을 감싼다.
 *
 * 데몬은 세션에 아무것도 밀 수 없으므로(훅으로 유휴 세션을 깨울 수단이 없다) 세션을
 * "고르는" 일만 여기서 한다. 세션이 자기를 데몬에 등록하는 프로토콜을 따로 만들지 않는
 * 이유가 이것 — CLI 가 이미 pid/cwd/sessionId/name/status 를 다 준다.
 *
 * `src/tailscale.ts` 와 같은 형태로 외부 명령은 주입 가능한 `RunCommand` 를 거친다 —
 * `claude` 가 없는 머신에서도 전 테스트가 통과한다.
 */

export interface AgentSession {
  pid: number;
  cwd: string;
  /** 'interactive' | 'background' — CLI 가 주는 값을 그대로 둔다. */
  kind: string;
  sessionId: string;
  /** 사람이 읽는 세션 이름 (예: `eelpout-a3`). */
  name: string;
  /** 'idle' | 'busy' — CLI 가 주는 값을 그대로 둔다. */
  status: string;
  startedAt: number;
}

export interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export type RunCommand = (cmd: string[], timeoutMs: number) => RunResult;

export interface SessionsResult {
  /** 세션 목록을 얻을 수 있었는가. false 면 이 기능 전체가 비활성이다. */
  available: boolean;
  sessions: AgentSession[];
  /** available 이 false 인 이유 — 사용자에게 그대로 보여준다. */
  reason?: string;
}

/** 기본 실행기 — Bun 참조를 이 함수 본문 안에만 둬서 다른 번들 타깃에서 안전하다. */
const defaultRun: RunCommand = (cmd, timeoutMs) => {
  try {
    const proc = Bun.spawnSync({ cmd, stdout: 'pipe', stderr: 'pipe', timeout: timeoutMs });
    return {
      ok: proc.exitCode === 0,
      stdout: proc.stdout.toString(),
      stderr: proc.stderr.toString(),
    };
  } catch (error) {
    return {
      ok: false,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
};

function toSession(value: unknown): AgentSession | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const row = value as Record<string, unknown>;
  if (
    typeof row.pid !== 'number' ||
    typeof row.cwd !== 'string' ||
    typeof row.sessionId !== 'string' ||
    typeof row.name !== 'string'
  ) {
    return null;
  }
  return {
    pid: row.pid,
    cwd: row.cwd,
    kind: typeof row.kind === 'string' ? row.kind : 'interactive',
    sessionId: row.sessionId,
    name: row.name,
    status: typeof row.status === 'string' ? row.status : 'idle',
    startedAt: typeof row.startedAt === 'number' ? row.startedAt : 0,
  };
}

/**
 * 활성 세션(interactive + background)을 나열한다.
 * @param run 테스트 주입용. 기본은 `claude agents --json` 을 실제로 실행한다.
 */
export function listSessions(run: RunCommand = defaultRun): SessionsResult {
  const result = run(['claude', 'agents', '--json'], 5_000);
  if (!result.ok) {
    const reason = `${result.stderr || result.stdout}`.trim() || 'claude CLI 를 실행할 수 없다';
    return { available: false, sessions: [], reason };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return { available: false, sessions: [], reason: 'claude agents --json 출력을 읽을 수 없다' };
  }
  if (!Array.isArray(parsed)) {
    return { available: false, sessions: [], reason: 'claude agents --json 출력이 배열이 아니다' };
  }
  const sessions: AgentSession[] = [];
  for (const item of parsed) {
    const session = toSession(item);
    if (session) {
      sessions.push(session);
    }
  }
  return { available: true, sessions };
}

/**
 * 보드 key 로 후보 세션을 고른다 — **cwd 의 경로 세그먼트 중 하나가 key 와 정확히
 * 일치**하면 후보다.
 *
 * basename 만 보면 워크트리를 놓친다: `/Users/x/orca/workspaces/rocky-todo/eelpout` 의
 * basename 은 `eelpout` 이다. 세그먼트로 보면 원본 레포와 워크트리가 둘 다 잡히고,
 * 후보가 2개면 호출자가 사용자에게 묻는다 — 의도한 동작이다.
 */
export function matchBoard(sessions: AgentSession[], boardKey: string): AgentSession[] {
  if (boardKey === '') {
    return [];
  }
  return sessions.filter((session) => session.cwd.split('/').includes(boardKey));
}
