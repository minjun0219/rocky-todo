---
'@minjun0219/rocky-todo': patch
---

브라우저發 CSRF 심층 방어 두 겹을 더한다

cross-site 변경 가드(Sec-Fetch-Site/Origin)는 이미 전 변경 라우트에 걸려 있다.
이번에 남은 갭 둘을 닫는다:

- **변경 본문은 `application/json` 만** — `<form enctype="text/plain">` 은 Fetch
  Metadata 를 모르는 구형 브라우저에서 preflight 없이 나가는 마지막 통로였다.
  정상 클라이언트(CLI·웹 UI·훅)는 전부 이 타입을 이미 보낸다. 빈 본문 POST 는
  타입을 따지지 않는다.
- **보드 `path`·`repo` 변경은 로컬 요청만** — path 는 spawn 워크트리 경로, repo 는
  이슈 생성 대상이다. 노출 채널이 이걸 바꿔두면 로컬 사용자의 다음 spawn/이슈
  버튼이 조용히 다른 곳을 향한다. 제목·설명·key 는 노출 채널에서도 그대로 편집된다.
