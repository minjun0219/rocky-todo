import type { ClaimedHandoff } from './store';

/**
 * 핸드오프 훅의 순수 로직 — claim 결과를 세션에 넣을 한국어 지시문으로 만든다.
 * 훅 엔트리(`hooks/handoff-stop.ts`, `hooks/notify-todo.ts`)는 HTTP 왕복과
 * stdin/stdout 배선만 담당한다 — `src/notify.ts` 와 같은 구조다.
 */

/** 주입문을 만드는 데 필요한 값 — claim 결과에서도, spawn 직전에도 같은 모양으로 만든다. */
export interface HandoffPromptInput {
  actor: string;
  note: string;
  todoRef: string;
  todoTitle: string;
  /** 이 세션 앞에 아직 남은 pending 건수. spawn 은 항상 0 이다. */
  remaining: number;
}

/**
 * 세션에 주입할 지시문.
 *
 * todo 본문은 싣지 않는다 — 세션이 `todo_list` 로 직접 읽으면 댓글·히스토리까지
 * 최신으로 본다. 복사하면 그 시점에 굳어버린다.
 */
export function buildHandoffPromptFrom(input: HandoffPromptInput): string {
  const lines = [
    '# rocky-todo: 보드에서 도착한 작업 요청',
    '',
    `${input.actor} → ${input.todoRef} "${input.todoTitle}"`,
  ];
  if (input.note !== '') {
    lines.push(`메모: ${input.note}`);
  }
  lines.push(
    '',
    `이 항목을 지금 착수해라. 상세는 todo_list { id: "${input.todoRef}" } 로 읽고,`,
    `착수할 때 todo_status { id: "${input.todoRef}", action: "start" } 로 표시한다.`,
  );
  if (input.remaining > 0) {
    lines.push(`(대기 중인 요청이 ${input.remaining}건 더 있다 — 이 건을 마치면 이어서 도착한다.)`);
  }
  return lines.join('\n');
}

/**
 * 대상 세션의 **턴을 여는** 짧은 신호. `SendMessage` 로 보낸다.
 *
 * 배달(claim)은 훅에서만 일어나고 훅은 턴 경계에서만 돈다 — `UserPromptSubmit`(턴 시작)
 * 또는 `Stop`(턴 종료). 그래서 idle 세션은 큐에 요청이 있어도 스스로 집어가지 못한다.
 * 데몬은 세션에 아무것도 밀 수 없으므로(`src/sessions.ts` 참고) 턴을 여는 일은 handoff 를
 * **호출한 에이전트**의 몫이다 — 그쪽에는 `SendMessage` 가 있다.
 */
export interface HandoffPoke {
  /** `SendMessage` 의 `to` — 세션 이름. */
  to: string;
  /** `SendMessage` 의 `message`. */
  message: string;
}

export interface HandoffPokeInput {
  sessionName: string;
  todoRef: string;
  todoTitle: string;
}

/**
 * poke 문구를 만든다.
 *
 * 짧게 두는 이유: 이 메시지가 여는 바로 그 턴의 `UserPromptSubmit` 훅이 상세 지시문
 * (`buildHandoffPrompt`)을 함께 주입하므로, 본문까지 실으면 같은 내용이 두 번 온다.
 * 다만 주입이 실패해도 굴러가야 하니 **이것만 읽고도 착수할 수 있을 만큼**은 남긴다.
 */
export function buildHandoffPoke(input: HandoffPokeInput): HandoffPoke {
  return {
    to: input.sessionName,
    message: [
      `# rocky-todo: 보드에서 작업 요청이 도착했다 — ${input.todoRef} "${input.todoTitle}"`,
      '',
      '이 메시지는 턴을 여는 신호다. 상세 지시는 같은 턴의 훅 주입으로 함께 도착한다 —',
      `주입이 보이지 않으면 todo_list { id: "${input.todoRef}" } 로 직접 읽고 착수해라.`,
    ].join('\n'),
  };
}

/** claim 결과로 주입문을 만든다 — 훅(`Stop` / `UserPromptSubmit`)이 쓰는 입구. */
export function buildHandoffPrompt(claimed: ClaimedHandoff): string {
  return buildHandoffPromptFrom({
    actor: claimed.handoff.actor,
    note: claimed.handoff.note,
    todoRef: claimed.todoRef,
    todoTitle: claimed.todoTitle,
    remaining: claimed.remaining,
  });
}
