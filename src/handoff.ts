import type { ClaimedHandoff } from './store';

/**
 * 핸드오프 훅의 순수 로직 — claim 결과를 세션에 넣을 한국어 지시문으로 만든다.
 * 훅 엔트리(`hooks/handoff-stop.ts`, `hooks/notify-todo.ts`)는 HTTP 왕복과
 * stdin/stdout 배선만 담당한다 — `src/notify.ts` 와 같은 구조다.
 */

/**
 * 세션에 주입할 지시문.
 *
 * todo 본문은 싣지 않는다 — 세션이 `todo_list` 로 직접 읽으면 댓글·히스토리까지
 * 최신으로 본다. 복사하면 그 시점에 굳어버린다.
 */
export function buildHandoffPrompt(claimed: ClaimedHandoff): string {
  const { handoff, todoRef, todoTitle, remaining } = claimed;
  const lines = [
    '# rocky-todo: 보드에서 도착한 작업 요청',
    '',
    `${handoff.actor} → ${todoRef} "${todoTitle}"`,
  ];
  if (handoff.note !== '') {
    lines.push(`메모: ${handoff.note}`);
  }
  lines.push(
    '',
    `이 항목을 지금 착수해라. 상세는 todo_list { id: "${todoRef}" } 로 읽고,`,
    `착수할 때 todo_status { id: "${todoRef}", action: "start" } 로 표시한다.`,
  );
  if (remaining > 0) {
    lines.push(`(대기 중인 요청이 ${remaining}건 더 있다 — 이 건을 마치면 이어서 도착한다.)`);
  }
  return lines.join('\n');
}
