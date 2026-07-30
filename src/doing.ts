/**
 * "이 doing 이 살아 있나" 와 "이 핸드오프가 어디까지 갔나" 판정 — 순수 함수.
 *
 * 데몬은 세션 안을 들여다볼 수 없다. 가진 재료는 `claude agents --json` 이 주는 세션
 * 목록과 스토어의 귀속 정보(`doingSessionId` / `acceptedAt`)뿐이라, 판정은 그 둘을
 * 맞춰보는 일이 전부다. 서버 라우트에서 떼어 둔 이유는 조합이 많아서다 — 세션 유무 ×
 * 상태 × 귀속 여부를 주입 없이 테스트하려면 순수해야 한다.
 */

import { isAgentActor } from './actors';
import { type AgentSession, matchBoard, type SessionsResult } from './sessions';
import type { Handoff, Todo } from './store';

/**
 * doing 하나의 생존 상태.
 *
 * - `live` — 그 세션이 살아 있고 지금 일하고 있다.
 * - `idle` — 세션은 살아 있는데 턴이 끝났고 `done` 이 안 왔다. **방치**다.
 * - `gone` — 그 세션이 사라졌다. 아무도 이 항목을 들고 있지 않다.
 * - `unknown` — 판별할 수 없다. 모르는 것과 없는 것은 다르므로 경고하지 않는다.
 */
export type DoingState = 'live' | 'idle' | 'gone' | 'unknown';

/**
 * 세션 하나를 식별자로 찾는다.
 *
 * `sessionId` 와 짧은 8자 `id` 를 **둘 다** 본다 — 보드가 새 백그라운드 세션을 띄울 때
 * (`createSpawnedHandoff`) 저장하는 값은 `claude attach/logs/stop/rm` 이 받는 짧은 id 라,
 * full UUID 로만 대조하면 멀쩡히 살아 있는 spawn 세션이 전부 "없음" 으로 보인다.
 */
function findSession(sessions: AgentSession[], identifier: string): AgentSession | undefined {
  return sessions.find((s) => s.sessionId === identifier || s.id === identifier);
}

/** 세션 하나의 상태를 doing 관점으로 옮긴다. */
function stateOfSession(session: AgentSession): DoingState {
  // background 세션은 끝나도 잠시 목록에 남는다 — 있지만 죽은 것이다.
  if (session.state === 'done') {
    return 'gone';
  }
  return session.status === 'busy' ? 'live' : 'idle';
}

/**
 * doing 인 todo 의 생존 상태를 판정한다.
 *
 * 판정은 두 갈래다. 세션 귀속이 있으면(핸드오프로 시작된 작업) 그 세션 하나만 보면 되고,
 * 없으면(에이전트가 자발적으로 `start` 한 작업) **그 보드에 활성 세션이 하나도 없을
 * 때만** 죽었다고 본다. 후자는 거칠지만 "다 꺼졌는데 처리중이 남아 있다" 는 가장 흔한
 * 실상황을 잡고, 세션이 하나라도 있으면 `unknown` 으로 물러나 오탐을 만들지 않는다.
 *
 * 사람이 잡아둔 doing 은 판정하지 않는다 — 사람은 세션 목록에 나타나지 않으므로 무엇을
 * 보든 "없음" 이 되어 전부 오탐이 된다.
 *
 * @param boardKey 이 todo 가 속한 보드 key. 세션 cwd 의 경로 세그먼트와 대조한다.
 */
export function resolveDoingState(
  todo: Pick<Todo, 'status' | 'doingBy' | 'doingSessionId'>,
  boardKey: string,
  sessions: SessionsResult,
): DoingState {
  if (todo.status !== 'doing') {
    return 'unknown';
  }
  // 세션 목록을 못 얻는 환경(claude 미설치, launchd PATH 누락 등)에서는 아무것도 단정할
  // 수 없다. 빈 목록을 "다 죽었다" 로 읽으면 멀쩡한 작업이 전부 경고로 뜬다.
  if (!sessions.available) {
    return 'unknown';
  }
  if (todo.doingSessionId) {
    const session = findSession(sessions.sessions, todo.doingSessionId);
    return session ? stateOfSession(session) : 'gone';
  }
  if (!todo.doingBy || !isAgentActor(todo.doingBy)) {
    return 'unknown';
  }
  return matchBoard(sessions.sessions, boardKey).length === 0 ? 'gone' : 'unknown';
}

/** 핸드오프가 어디까지 갔는지 — 타임스탬프에서 파생한다. */
export type HandoffPhase = 'pending' | 'delivered' | 'accepted' | 'completed' | 'cancelled';

/** 응답 전용 핸드오프 — 저장 모델에 세션 대조로만 알 수 있는 판정을 얹은 형태. */
export interface HandoffView extends Handoff {
  phase: HandoffPhase;
  /** 배달됐는데 그 세션이 아무것도 안 했다 ({@link isUnstarted}). */
  unstarted: boolean;
  /** pending 인데 대상 세션이 사라졌다. 큐에는 그대로 남는다 — 표시만 하는 값이다. */
  stale: boolean;
}

/**
 * 저장된 상태·타임스탬프를 한 단계로 접는다.
 *
 * `status` enum 을 늘리지 않은 대가로 여기서 읽어낸다 — 그 대신 "취소됐는데 완료됨"
 * 같은 불가능한 조합이 애초에 표현되지 않는다.
 */
export function handoffPhase(handoff: Handoff): HandoffPhase {
  if (handoff.status === 'cancelled') {
    return 'cancelled';
  }
  if (handoff.status === 'pending') {
    return 'pending';
  }
  if (handoff.completedAt) {
    return 'completed';
  }
  return handoff.acceptedAt ? 'accepted' : 'delivered';
}

/**
 * "집어갔는데 아무 일도 안 일어났다" 인가.
 *
 * **시간 임계값을 쓰지 않는다.** 배달 직후의 몇 초/몇 분은 정상적인 공백이라, "N분 지나면
 * 미착수" 로 잡으면 그 상수가 곧 오탐의 원천이 된다. 대신 세션 쪽을 본다 — 아직 일하는
 * 중(`live`)이면 조용하고, 세션이 사라졌거나(`gone`) 턴을 끝내고 노는 중(`idle`)인데
 * 착수 기록이 없을 때만 경고다. 그 두 경우는 시간이 더 흘러도 저절로 착수되지 않는다.
 *
 * @returns 판별할 수 없으면 false — 모르는 것을 경고로 만들지 않는다.
 */
export function isUnstarted(handoff: Handoff, sessions: SessionsResult): boolean {
  if (handoff.status !== 'delivered' || handoff.acceptedAt) {
    return false;
  }
  if (!sessions.available) {
    return false;
  }
  const session = findSession(sessions.sessions, handoff.sessionId);
  if (!session) {
    return true;
  }
  return stateOfSession(session) !== 'live';
}
