---
"rocky-todo": minor
---

보드 메타 관리 — 이름·key·설명·GitHub 을 보고 고친다

보드를 열면 목록 위에 헤더가 뜬다: 이름 · key · 한 줄 설명 · GitHub 링크 · 레포 경로.
`편집` 으로 그 자리에서 이름·key·설명·GitHub 을 한 번에 고치고, CLI 는 `board show|rename|title|desc`
가 같은 일을 한다. `PATCH /api/boards/:key` 도 이제 여러 필드를 함께 받는다 — 한
트랜잭션이라 부분 적용이 없다(예전의 "repo 와 path 를 같이 보내면 400" 제약이 사라졌다).

**key 를 바꿔도 옛 참조는 죽지 않는다.** 옛 key 는 별칭으로 남아 `gotgan-12` 같은 참조와
옛 `board` 인자를 계속 받는다. 내보내는 문자열은 언제나 새 key 다.

곁들여, 변경 요청(POST/PATCH/PUT/DELETE)에 cross-site 가드를 붙였다 — 다른 사이트의
페이지가 무인증 로컬 데몬에 폼을 POST 하던 통로를 막는다. CLI·훅·MCP·웹 UI 는 영향 없다.
