---
"@minjun0219/rocky-todo": minor
---

statusline 세그먼트 추가 — 창을 하나 더 띄우지 않고 보드를 본다

`GET /api/statusline?cwd=&session=` 이 완성된 한 줄을 `text/plain` 으로 돌려준다.
기본 템플릿은 이 세션이 잡은 항목(ref + 제목)과 댓글 수, 나에게 온 대기 요청,
보드의 방치된 doing 을 싣고, 보여줄 게 없으면 아무것도 출력하지 않는다.
템플릿은 `rocky.json` 의 `todo.statusline.template`(env `ROCKY_TODO_STATUSLINE`)로 바꾼다.
