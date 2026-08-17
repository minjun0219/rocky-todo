---
'@minjun0219/rocky-todo': minor
---

todo 를 다른 보드로 옮긴다

드로어의 새 "보드" 선택으로 옮기고, CLI 는 `rocky-todo move REF --to BOARD`
(같은 커맨드가 `--before REF | --last` 로 순서 이동도 한다). REST 는
`POST /api/todos/:ref/board { board }`.

- 번호는 대상 보드에서 새로 발급된다 — 참조가 바뀐다(원래 번호는 빈 자리로 남음)
- 섹션은 같은 이름이 대상에 있을 때만 이어지고, 이동이 대상 보드에 섹션을 몰래
  만들지 않는다
- 하위 항목이 있으면 거부한다 — 부모/자식 링크를 조용히 끊지 않는다
- 히스토리에 move-board (보드·번호 변화) 기록
