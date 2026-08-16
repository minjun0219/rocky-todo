---
'@minjun0219/rocky-todo': patch
---

모바일 댓글 도구의 좌우 탭 여백을 되살린다

`@media (max-width: 900px)` 의 `.comment-tool { padding: 0 8px }` 가 뒤에 오는 베이스
규칙의 `padding: 0` 에 덮여 있었다. 좁은 화면에서 댓글 수정·보관 버튼의 탭 타깃이
글자 폭만큼으로 좁아져 누르기 어려웠다.

반응형 파티션을 @import 목록의 마지막으로 옮겨 고쳤다 — 베이스를 `!important` 없이
덮으려면 순서가 뒤여야 한다는 원래 의도대로다.
