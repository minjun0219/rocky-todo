import { resolveTodoRuntimeConfig } from '../src/config';
import { buildHandoffPrompt } from '../src/handoff';
import { loadTodoConfig } from '../src/rocky-config';
import type { ClaimedHandoff } from '../src/store';

/**
 * Stop hook: 이 세션 앞으로 온 보드 작업 요청이 있으면 턴을 끝내지 못하게 막고
 * (`decision: "block"`) 그 자리에서 착수시킨다.
 *
 * 원칙:
 * - fail-open: 데몬이 죽어 있거나 어떤 에러든 조용히 exit 0 (턴 종료를 막지 않는다).
 * - **서브에이전트에서는 빠진다** — 서브에이전트가 보드 요청을 가로채면 사용자가 보낸
 *   대상과 실제 처리 주체가 갈린다.
 * - 무한 루프는 구조적으로 없다: claim 된 건은 delivered 라 다시 나오지 않고, 큐가
 *   비면 block 하지 않는다. 큐가 유한하므로 반드시 끝난다.
 */

export interface StopHookInput {
  session_id?: string;
  /** 서브에이전트 컨텍스트에서만 채워진다. */
  agent_id?: string;
  agent_type?: string;
}

export interface StopDeps {
  claim: (sessionId: string) => Promise<ClaimedHandoff | null>;
}

async function readStdin(): Promise<string> {
  let raw = '';
  for await (const chunk of process.stdin) {
    raw += chunk;
  }
  return raw;
}

/** 데몬에서 이 세션 앞의 요청 한 건을 집어온다. 없거나 실패하면 null. */
async function defaultClaim(sessionId: string): Promise<ClaimedHandoff | null> {
  const { todo } = loadTodoConfig();
  const runtime = resolveTodoRuntimeConfig(process.env, todo);
  const res = await fetch(`http://127.0.0.1:${runtime.port}/api/handoffs/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, via: 'stop' }),
    signal: AbortSignal.timeout(1500),
  });
  if (res.status !== 200) {
    return null;
  }
  return (await res.json()) as ClaimedHandoff;
}

/**
 * 주입할 reason 을 만든다.
 * @returns 대기 중인 요청이 없거나 여기서 처리하면 안 되는 상황이면 null.
 */
export async function run(
  input: StopHookInput,
  deps: StopDeps = { claim: defaultClaim },
): Promise<string | null> {
  if (!input.session_id) {
    return null;
  }
  if (input.agent_id || input.agent_type) {
    return null;
  }
  try {
    const claimed = await deps.claim(input.session_id);
    return claimed ? buildHandoffPrompt(claimed) : null;
  } catch {
    return null;
  }
}

if (import.meta.main) {
  (async () => {
    let input: StopHookInput = {};
    try {
      input = JSON.parse(await readStdin()) as StopHookInput;
    } catch {
      // stdin 이 비어도 진행 — session_id 없으면 run 이 null 을 낸다.
    }
    const reason = await run(input);
    if (reason) {
      process.stdout.write(JSON.stringify({ decision: 'block', reason }));
    }
  })()
    .catch(() => {
      // fail-open — 훅 실패가 턴 종료를 막지 않는다.
    })
    .finally(() => {
      process.exit(0);
    });
}
