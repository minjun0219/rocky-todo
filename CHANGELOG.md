# @minjun0219/rocky-todo

## 0.5.1

### Patch Changes

- [#13](https://github.com/minjun0219/rocky-todo/pull/13) [`7ff7699`](https://github.com/minjun0219/rocky-todo/commit/7ff76997c1730aaaddaae4de1b83523a6ce91739) Thanks [@minjun0219](https://github.com/minjun0219)! - 모바일 사용성 — 폰에서 보드를 실제로 쓸 수 있게 하는 다섯 가지 수정.

  터치 타깃을 모바일 폭에서 44×44 로 맞췄다(체크박스는 시각 크기를 유지한 채 라벨 여백으로
  히트 영역만 확보). 탭이 백그라운드에 다녀오면 `EventSource` 와 타이머가 얼어 낡은 보드가
  보이던 문제를 `visibilitychange` 즉시 재조회로 고쳤다. 드로어가 열린 동안 iOS 에서 그 뒤
  페이지가 고무줄처럼 스크롤/바운스되던 것을 막았다. 보드가 늘면 가로 스크롤 칩 행 밖으로 밀려 도달할 수 없던 "보관됨
  표시" 토글을 상단 바로 옮겼다. 목록을 스크롤해도 새 작업 입력이 붙어 있게 했다.

## 0.5.0

### Minor Changes

- [#11](https://github.com/minjun0219/rocky-todo/pull/11) [`76fe269`](https://github.com/minjun0219/rocky-todo/commit/76fe269785133bccb40aba7492d2e66c20983eab) Thanks [@minjun0219](https://github.com/minjun0219)! - todo 를 GitHub 이슈로 — 웹 UI 버튼 · CLI `issue` · MCP `todo_write.createIssue` (gh CLI 사용, 링크 자동 첨부)

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
  - **이슈 생성은 로컬(루프백) 요청만 할 수 있다.** `gh` 인증을 빌리므로, `todo.expose` 로 보드를
    노출해도 이 표면은 열리지 않는다 — 보드 쓰기 권한이 GitHub 쓰기 권한으로 확대되지 않게
    한다. 노출된 주소로 접속한 브라우저는 버튼 대신 사유를 보고(이미 있는 이슈 링크는 그대로
    열린다), REST 는 403, MCP 는 도구 에러가 된다. `tailscale serve` 경유도 중계 헤더로 구분해
    막는다.

## 0.4.0

### Minor Changes

- [#8](https://github.com/minjun0219/rocky-todo/pull/8) [`aca8ec2`](https://github.com/minjun0219/rocky-todo/commit/aca8ec2809dbd5e1b9bcd6a94213122bc887ba51) Thanks [@minjun0219](https://github.com/minjun0219)! - todo 댓글 — 에이전트와 사용자가 같은 타임라인에서 대화한다 (웹 UI · MCP todo_write.comment · CLI comment · 훅 주입)

- [#10](https://github.com/minjun0219/rocky-todo/pull/10) [`9abf32e`](https://github.com/minjun0219/rocky-todo/commit/9abf32e155fd3cdb7756bf5f59783e5573c45c31) Thanks [@minjun0219](https://github.com/minjun0219)! - 웹 UI 퍼머링크 — `/rocky/12` 로 보드와 작업을 주소에 담는다 (새로고침 유지 · 링크 공유).

  주소가 보고 있는 화면을 담는다: `/`(전체 보기) · `/{board}`(그 보드) · `/{board}/{number}`(그
  todo 상세 열림 — 예: `/rocky/12` 는 참조 `rocky#12` 와 대응). 보드를 고르면 주소가 바뀌고
  새로고침해도 유지되며, todo 상세를 연 주소를 그대로 건네면 상대가 같은 화면을 본다. 드로어를
  닫으면 보드 경로로 돌아가고 브라우저 뒤로/앞으로가 드로어 열림·닫힘을 따라간다.

  없는 보드는 전체 보기로, 없거나 보관된 번호는 그 보드 화면으로 조용히 떨어진다 — 에러 화면
  없음. 꼬리가 붙은 주소(`/rocky/12/뭐든`)는 화면을 띄우면서 `/rocky/12` 로 정리된다.

  board key `api`/`mcp`(데몬의 `/api/*`·`/mcp` 라우트와 충돌)와 `.`/`..`(브라우저 URL 파서가
  `/` 로 정규화)는 URL 로 가리킬 수 없다 — 보드 자체는 그대로 만들어지고 동작하지만 주소는
  `/` 로 남고, 되돌아갈 수 없는 히스토리 항목도 만들지 않는다(그래서 상세를 닫아도 보드 선택이
  풀리지 않는다).

## 0.3.0

### Minor Changes

- [#6](https://github.com/minjun0219/rocky-todo/pull/6) [`59544b6`](https://github.com/minjun0219/rocky-todo/commit/59544b610ac636b36c62daa5f40ae3bef199bf8a) Thanks [@minjun0219](https://github.com/minjun0219)! - 웹 UI 에서 제목을 고치고 보드를 만들 수 있게 했다. 섹션은 배치만 UI 에 두고 생성·보관은
  CLI 로 넘겼다.

  - 상세 드로어의 제목을 클릭하면 입력창으로 바뀐다 (Enter 저장 · Esc 취소). 그동안 설명은
    고칠 수 있는데 제목만 못 고쳤다.
  - 사이드바에 `+ 새 보드` 를 추가했다. 보드 key 규칙(공백·`#` 불가) 위반은 서버 메시지를
    그대로 입력창 아래 보여준다 — 조용히 실패하면 왜 안 만들어지는지 알 수 없다.
  - 상세 드로어에 `섹션` 드롭다운을 추가해 항목을 섹션 사이로 옮길 수 있다. `(없음)` 이면
    미분류로 돌아온다.
  - 섹션 생성·보관 경로를 실제로 뚫었다: `POST /api/sections`, `POST /api/sections/:id/archive`,
    그리고 CLI `section add` / `section archive`. `section add` 는 그동안 안내 문구만 출력하고
    아무것도 만들지 않았다.

  버그 수정:

  - `updateTodo` 가 `section: null` 을 받아 섹션에서 뺄 수 있게 했다. `parentId` 는 되는데
    `section` 만 해제 경로가 없어, 한번 넣으면 되돌릴 수 없었다.
  - 섹션을 보관하면 그 안의 항목이 웹 UI 에서 사라졌다. 섹션 그룹은 없어지는데 항목의
    `section_id` 는 남아 미분류 그룹에도 못 들어갔기 때문이다. 이제 보관 시 항목을 미분류로
    돌려놓는다.

## 0.2.0

### Minor Changes

- [#4](https://github.com/minjun0219/rocky-todo/pull/4) [`bc81317`](https://github.com/minjun0219/rocky-todo/commit/bc81317bf33eef666393989f752489b1154667cf) Thanks [@minjun0219](https://github.com/minjun0219)! - todo/note 에 보드별 번호(`#12`)를 추가했다. `rocky#12` / `#12` / id / id 접두사를 어디서나
  같은 자리에 쓸 수 있고(CLI, MCP `id` 인자, 웹 UI), 웹 UI 에서 번호를 클릭하면 `rocky#12` 가
  클립보드에 복사되어 세션에 붙여넣기 좋다. 기존 랜덤 id 는 그대로 기본 키로 남는다.

## 0.1.1

### Patch Changes

- [#1](https://github.com/minjun0219/rocky-todo/pull/1) [`ea83dd7`](https://github.com/minjun0219/rocky-todo/commit/ea83dd7e4be5b1c63ee2deb25b275ae5a102f831) Thanks [@minjun0219](https://github.com/minjun0219)! - 데몬을 버전 인식으로 재기동하고, 깨져 있던 CLI 진입점을 고쳤다.

  - `SessionStart` 훅이 health 유무만 보고 no-op 하던 탓에, 플러그인을 업데이트해도 캐시의
    구버전 디렉터리에서 돌던 데몬이 계속 자리를 지켜 새 코드가 뜨지 않았다. 이제 `/api/health`
    가 `version`/`pid` 를 보고하고, 훅이 자기 버전과 다르면 SIGTERM 으로 내린 뒤 재기동한다.
    종료에 실패하면 재기동하지 않는다 (fail-open — 구버전이라도 보드를 살려 둔다).
    - launchd(KeepAlive) 로 상주 등록된 경우 PID 만 죽이면 launchd 가 같은 구버전을 즉시
      되살리므로, 훅이 상주 job 을 현재 설치 경로로 교체(bootout→plist 갱신→bootstrap)한다.
    - health 응답은 `ok === true` + `name === 'rocky-todo'` 로 신원을 검증한다 — 포트를
      가로챈 무관한 서비스를 데몬으로 오인해 그 PID 에 SIGTERM 을 보내지 않도록.
  - `bin/rocky-todo` 가 별도 레포 분리 이전 경로(`../src/todo/cli`)를 참조해 CLI 가 전혀 실행되지
    않았다. `bin/` 은 tsc(`include`)·biome 어느 쪽도 검사하지 않아 게이트를 통과했으므로, 진입점
    스모크 테스트를 추가해 회귀를 막는다.
