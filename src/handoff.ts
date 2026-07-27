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
