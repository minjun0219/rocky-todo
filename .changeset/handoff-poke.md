---
'@minjun0219/rocky-todo': minor
---

handoff 가 idle 세션에도 닿게 한다

`handoff` 배달(claim)은 훅에서만 일어나고 훅은 턴 경계(`UserPromptSubmit` / `Stop`)에서만
돈다. idle 세션에는 그 경계가 오지 않아 요청이 큐에 앉은 채 방치됐고, CLI 는 그걸
"✓ … 에게 보냄" 이라고 알려 배달된 것처럼 보이게 했다.

- `POST /api/todos/:ref/handoff` 응답에 `poke: { to, message }` 추가 — 대상 세션의 턴을 여는
  `SendMessage` 페이로드. 호출한 에이전트가 그대로 보내면 그 턴의 훅이 상세 지시를 주입한다.
- CLI 출력을 "큐에 넣음 (아직 배달 전)" 으로 고치고, 턴을 여는 방법을 에이전트/사람 양쪽으로
  안내한다.
- `/rocky-todo:next` 의 넘기기 절차에 poke 단계를 명시.
