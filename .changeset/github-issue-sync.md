---
"@minjun0219/rocky-todo": minor
---

todo 를 GitHub 이슈로 — 웹 UI 버튼 · CLI `issue` · MCP `todo_write.createIssue` (gh CLI 사용, 링크 자동 첨부)

- 웹 UI 상세 드로어의 `GitHub 이슈 만들기` 버튼, CLI `rocky-todo issue REF [--repo OWNER/NAME]`,
  MCP `todo_write { id, createIssue: true }` 셋 다 같은 경로를 탄다 — MCP 도구 수는 여전히 5개다.
- 인증은 `gh` CLI 를 빌린다. 토큰을 저장하지 않는다. `gh` 가 없거나 로그인 전이면 그 사유를
  그대로 보여준다.
- 만들어진 이슈 URL 은 그 todo 의 링크에 자동으로 붙는다(기존 `updateTodo` 를 거쳐 히스토리·
  SSE·훅 주입에도 그대로 실린다).
- 보드마다 GitHub 레포(`owner/name`)를 알아야 한다 — `rocky-todo board repo [OWNER/NAME]`
  으로 설정하거나, `issue` 실행 시 cwd 의 git remote 에서 유추해 저장하거나, 웹 UI 에서 버튼을
  처음 누를 때 1회 입력받는다.
- 이미 이슈 링크가 있는 todo 는 다시 만들지 않는다. 이슈 쪽 변경(닫힘 등)이 todo 에 역으로
  반영되지는 않는다.
