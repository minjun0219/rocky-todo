---
"@minjun0219/rocky-todo": minor
---

보드에서 실행 중인 Claude Code 세션으로 todo 를 넘기는 핸드오프. 웹 UI 버튼 / `rocky-todo handoff` CLI 로 보내면 대상 세션이 턴을 끝내는 순간 자동으로 착수한다. 세션 목록은 `claude agents --json` 에서 얻고, 보드 key 와 세션 cwd 가 애매하면 사용자가 고른다. MCP 도구는 5개 그대로.
