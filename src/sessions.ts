/**
 * 활성 Claude Code 세션 목록 — `claude agents --json` 을 감싼다.
 *
 * 데몬은 세션에 아무것도 밀 수 없으므로 세션을 "고르는" 일만 여기서 한다. 세션이 자기를
 * 데몬에 등록하는 프로토콜을 따로 만들지 않는 이유가 이것 — CLI 가 이미
 * pid/cwd/sessionId/name/status 를 다 준다.
 *
 * **유휴 세션을 깨우는 건 호출자 몫이다.** handoff 배달(claim)은 훅에서만 일어나고 훅은
 * 턴 경계에서만 돈다(`UserPromptSubmit` / `Stop`) — idle 세션에는 그 경계가 오지 않아
 * 큐에 그대로 앉는다. `claude` CLI 에도 실행 중 세션에 입력을 넣는 서브커맨드는 없다.
 * 그래서 턴을 여는 일은 `SendMessage` 를 가진 **호출 에이전트**가 하고, 데몬은 그 문구를
 * `POST /api/todos/:ref/handoff` 응답의 `poke` 로 만들어 넘겨준다 (`src/handoff.ts`).
 *
 * `src/tailscale.ts` 와 같은 형태로 외부 명령은 주입 가능한 `RunCommand` 를 거친다 —
 * `claude` 가 없는 머신에서도 전 테스트가 통과한다.
 */

export interface AgentSession {
  pid: number;
  cwd: string;
  /** 'interactive' | 'background' — CLI 가 주는 값을 그대로 둔다. */
  kind: string;
  /**
   * 짧은 id(8자) — `claude attach/logs/stop/rm` 이 받는 값이자 `sessionId` 의 접두사다.
   * background 세션에만 붙는다.
   */
  id?: string;
  sessionId: string;
  /** 사람이 읽는 세션 이름 (예: `eelpout-a3`). */
  name: string;
  /** 'idle' | 'busy' — CLI 가 주는 값을 그대로 둔다. */
  status: string;
  /**
   * background 세션의 수명 상태 — 'working' | 'done'. interactive 세션에는 없다.
   * 없음(undefined)은 "죽지 않았다"로 읽는다 — 살아 있는 interactive 세션이 그 꼴이다.
   */
  state?: string;
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
    ...(typeof row.id === 'string' ? { id: row.id } : {}),
    sessionId: row.sessionId,
    name: row.name,
    status: typeof row.status === 'string' ? row.status : 'idle',
    ...(typeof row.state === 'string' ? { state: row.state } : {}),
    startedAt: typeof row.startedAt === 'number' ? row.startedAt : 0,
  };
}

/**
 * 활성 세션(interactive + background)을 나열한다.
 *
 * 실측 ~220ms — `Bun.spawnSync` 로 `claude agents --json` 을 띄우는 게 본질적으로
 * 동기 블로킹이라(최악은 timeout 5s), 요청마다 부르면 그 시간만큼 데몬 전체(MCP·SSE·
 * CLI·다른 세션 훅)가 멎는다. 호출 빈도가 높은 경로는 `createCachedListSessions` 를 쓴다.
 *
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

/**
 * `listSessions` 를 TTL 동안 메모이즈하는 클로저를 만든다.
 *
 * TTL 기본 3초 — 세션이 열리고 닫히는 빈도(사람이 터미널 탭을 여닫는 정도)에 비해
 * 훨씬 짧아 신선도 손실은 미미한 반면, `GET /api/handoffs`(SSE 이벤트마다 150ms 디바운스
 * + 60초 tick 로 웹 UI 가 반복 호출)와 `/api/sessions`, handoff 생성 경로가 겹쳐 부르는
 * 창을 대부분 흡수한다 — 실제 `claude agents --json` spawn 은 창당 최대 한 번으로 준다.
 *
 * 반환된 클로저는 호출자가 쥔 상태로만 유효하다(프로세스 전역이 아니다) — `daemon.ts` 가
 * 딱 한 번 만들어 `buildTodoServer` 에 넘기면 그게 곧 "데몬 프로세스 수명 동안" 이 된다.
 * 재기동하면 새 클로저가 생겨 자연히 비워진다.
 *
 * 테스트가 주입하는 `sessions` 옵션에는 이 래퍼를 쓰지 않는다 — `buildTodoServer` 는
 * `options.sessions` 를 그대로 호출자에게 노출하므로, 이 함수를 쓰지 않는 한 캐시가
 * 끼어들 일이 없다. 호출 횟수에 의존하는 테스트가 있고, 주입의 목적 자체가 결정론이라
 * 캐시로 흐리면 안 된다.
 */
export function createCachedListSessions(ttlMs = 3_000, run?: RunCommand): () => SessionsResult {
  let cached: SessionsResult | null = null;
  let expiresAt = 0;
  return () => {
    const now = Date.now();
    if (cached && now < expiresAt) {
      return cached;
    }
    cached = listSessions(run);
    expiresAt = now + ttlMs;
    return cached;
  };
}
