/**
 * actor 분류 — "이 변경을 사람이 했나 에이전트가 했나".
 *
 * 세 곳이 같은 판정을 필요로 한다:
 * - `src/notify.ts` — 에이전트 자신의 변경을 걸러 자기 반향을 막는다.
 * - `src/ui/lib.ts` — doing 뱃지의 온도(warm/cool)를 가른다.
 * - `src/store.ts` — 사람이 누른 `start` 는 핸드오프에 귀속하지 않는다.
 *
 * 목록이 갈라지면 같은 actor 가 화면에서는 에이전트인데 주입 필터에서는 사람이 되는
 * 식으로 어긋나므로 여기 한 벌만 둔다. 순수 상수라 브라우저 번들에도 안전하다.
 */

/** 에이전트로 간주하는 actor 이름. */
export const AGENT_ACTORS: ReadonlySet<string> = new Set([
  'claude-code',
  'codex',
  'opencode',
  'agent',
  'rocky',
]);

/** 이 actor 가 에이전트인가. 모르는 이름은 사람으로 본다. */
export function isAgentActor(actor: string): boolean {
  return AGENT_ACTORS.has(actor);
}
