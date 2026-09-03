# @minjun0219/rocky-todo

## 0.15.0-next.1

### Minor Changes

- [#75](https://github.com/minjun0219/rocky-todo/pull/75) [`035298c`](https://github.com/minjun0219/rocky-todo/commit/035298c7f30c0ff272536bc78d72fb8eeb7fa646) Thanks [@minjun0219](https://github.com/minjun0219)! - 플러그인 훅·CLI 가 네이티브 바이너리로 돈다 — `bin/rocky-todo` 부트스트랩이 플러그인 버전에
  맞는 릴리스 tarball(CLI + 데몬 + 웹 UI)을 `~/.local/share/rocky-todo/v<version>/` 에 한 번
  받아 실행한다. bun 이 더는 필요 없다. 데몬은 실행 파일 옆 `dist/` 를 서빙한다.

## 0.15.0-next.0

### Minor Changes

- [#73](https://github.com/minjun0219/rocky-todo/pull/73) [`c6be5b1`](https://github.com/minjun0219/rocky-todo/commit/c6be5b162d18c793b45ae50f512f3119ca36e76c) Thanks [@minjun0219](https://github.com/minjun0219)! - Rust 재작성 — 데몬(`rocky-todod`)·CLI(`rocky-todo`)·훅 3종을 Rust 로 옮기고, 보드를 여는 데스크톱 앱(`rocky-todo.app`)을 추가했다. 프리릴리즈 채널(`next`)로 먼저 나간다.

## 0.14.0

### Minor Changes

- [#64](https://github.com/minjun0219/rocky-todo/pull/64) [`d139e43`](https://github.com/minjun0219/rocky-todo/commit/d139e43bd99aa16b14d28142eff4ba8f26b639e7) Thanks [@minjun0219](https://github.com/minjun0219)! - todo 를 다른 보드로 옮긴다

  드로어의 새 "보드" 선택으로 옮기고, CLI 는 `rocky-todo move REF --to BOARD`
  (같은 커맨드가 `--before REF | --last` 로 순서 이동도 한다). REST 는
  `POST /api/todos/:ref/board { board }`.

  - 번호는 대상 보드에서 새로 발급된다 — 참조가 바뀐다(원래 번호는 빈 자리로 남음)
  - 섹션은 같은 이름이 대상에 있을 때만 이어지고, 이동이 대상 보드에 섹션을 몰래
    만들지 않는다
  - 하위 항목이 있으면 거부한다 — 부모/자식 링크를 조용히 끊지 않는다
  - 히스토리에 move-board (보드·번호 변화) 기록

- [#63](https://github.com/minjun0219/rocky-todo/pull/63) [`9294a60`](https://github.com/minjun0219/rocky-todo/commit/9294a6078557ce35874c5e29e81012ea76527d25) Thanks [@minjun0219](https://github.com/minjun0219)! - todo 를 핸들로 끌어 순서를 바꾼다

  행에 정렬 핸들(⠿)이 생겼다 — 데스크톱은 행 hover 에 나타나고, 좁은 화면은 늘 흐리게
  보인다. 핸들을 끌면 삽입선이 따라오고, 놓으면 그 자리로 이동한다(터치 포함 — 핸들에서
  시작한 터치는 스크롤로 새지 않는다). 이동은 같은 보드·섹션·부모 안에서만 — 섹션을
  넘기는 건 정렬이 아니라 소속 변경이라 드로어의 몫이다.

  서버는 `POST /api/todos/:ref/move { before: ref | null }` — 보드 전체 position 을
  트랜잭션으로 재부여하고 히스토리에 reorder 를 남긴다.

- [#66](https://github.com/minjun0219/rocky-todo/pull/66) [`714afdd`](https://github.com/minjun0219/rocky-todo/commit/714afdd3872a8b9c64f82afbd04bfa82e6cf57d3) Thanks [@minjun0219](https://github.com/minjun0219)! - 이모지·글리프 아이콘을 lucide 로 교체한다

  💬(댓글)·↗(링크)·✕(닫기)·◐●○(테마)·▶⏸✓↺▣(상태 버튼)·⌚(히스토리)·⠿(핸들)·
  ▸▾(접힘 캐럿)가 lucide-react 스트로크 아이콘으로 바뀐다 — OS 이모지 렌더링 편차가
  사라지고 라이트/다크 모두 currentColor 로 일관된다. 트리셰이킹으로 쓰는 아이콘만
  번들에 실린다(사전 실측 gzip ~1.4KB). `LINK ♪` 와 파비콘 🪨 는 정체성이라 유지.

### Patch Changes

- [#67](https://github.com/minjun0219/rocky-todo/pull/67) [`ef12953`](https://github.com/minjun0219/rocky-todo/commit/ef12953a43d0953cc88922702372d7fd402e9b4d) Thanks [@minjun0219](https://github.com/minjun0219)! - PC 상세를 중앙 모달로

  우측 440px 드로어는 긴 설명을 좁은 기둥에 가둬 스크롤만 길어졌다. 상세는
  설명·댓글·히스토리까지 있는 문서라, 읽기 자연스러운 **중앙 모달**(680px ≈ 80ch,
  최대 86vh, 둥근 카드)로 바꾼다 — 좁은 화면의 바텀시트와 "보드 위에 뜨는 카드"
  문법도 통일된다. 바텀시트는 그대로다.

## 0.13.1

### Patch Changes

- [#60](https://github.com/minjun0219/rocky-todo/pull/60) [`c6c62ac`](https://github.com/minjun0219/rocky-todo/commit/c6c62ac4af87e6e2f647cb5456d1470d2103a722) Thanks [@minjun0219](https://github.com/minjun0219)! - 실기기 제보 후속 — 좁은 화면 다듬기 4건

  - 테마 토글이 들어가며 폭이 넘칠 때 actor 칩이 혼자 다음 줄 왼쪽에 떨어졌다.
    컨트롤(테마·보관됨·actor)을 한 그룹으로 묶어, 줄바꿈이 나면 그룹째 떨어지고
    그 줄에서도 우측 정렬을 유지한다.
  - 고정된 새 작업 입력이 스크롤 시 리스트 위에 경계 없이 떠 보였다("덩그러니").
    아래 헤어라인을 더해 고정 헤더 밴드로 읽히게 한다.
  - 430px 이하에선 LINK 텍스트를 접고 펄스 점만 남겨 상단 바가 **한 줄**로 선다 —
    그룹째 줄바꿈은 안전망으로만 남는다.
  - 핸드오프 세션 select 가 긴 옵션(세션 경로) 폭으로 늘어나 시트에 가로 스크롤을
    만들던 것을 가두고, 시트는 overflow-x hidden 으로 가로 팬을 원천 차단.
  - 바텀시트 위 틈을 12dvh → 32px 스크림 띠로 — 시트가 열린 동안 아무 역할 없는
    상단 바가 통째로 보이던 것을 없애고, 탭 닫기·레이어 신호는 유지.
  - 시트의 그랩바 제거 — 스와이프 닫기를 만들지 않았으므로 그 신호는 거짓
    어포던스였다. 닫기는 스크림 탭·Esc·우하단 pill 세 경로 그대로.

## 0.13.0

### Minor Changes

- [#58](https://github.com/minjun0219/rocky-todo/pull/58) [`73b78b0`](https://github.com/minjun0219/rocky-todo/commit/73b78b0638e8bb54bd30706556341bbc4d1f3888) Thanks [@minjun0219](https://github.com/minjun0219)! - 라이트 모드

  상단 바의 테마 토글(◐ 시스템 → ● 다크 → ○ 라이트 순환)로 켠다. 기본은 시스템
  설정 추종이고 명시 선택은 localStorage 에 남는다. 첫 페인트 전에 인라인 스크립트가
  `data-theme` 을 확정해 깜빡임(FOUC)이 없다.

  라이트 팔레트는 순백이 아니라 웜 아이보리다 — 순백 위에서는 앰버가 탁해져
  "두 대기"(warm=에이전트 / cool=사람)의 온도 대비가 죽는다. 값은 대비 튜닝을 마친
  닫힌 브랜치의 팔레트를 그대로 살렸다. 다크는 기존 그대로가 기본값이다.

### Patch Changes

- [#57](https://github.com/minjun0219/rocky-todo/pull/57) [`b3ca2dd`](https://github.com/minjun0219/rocky-todo/commit/b3ca2dd60cd4b75de07c7729d569afad2e9053ab) Thanks [@minjun0219](https://github.com/minjun0219)! - 브라우저發 CSRF 심층 방어 두 겹을 더한다

  cross-site 변경 가드(Sec-Fetch-Site/Origin)는 이미 전 변경 라우트에 걸려 있다.
  이번에 남은 갭 둘을 닫는다:

  - **변경 본문은 `application/json` 만** — `<form enctype="text/plain">` 은 Fetch
    Metadata 를 모르는 구형 브라우저에서 preflight 없이 나가는 마지막 통로였다.
    정상 클라이언트(CLI·웹 UI·훅)는 전부 이 타입을 이미 보낸다. 빈 본문 POST 는
    타입을 따지지 않는다.
  - **보드 `path`·`repo` 변경은 로컬 요청만** — path 는 spawn 워크트리 경로, repo 는
    이슈 생성 대상이다. 노출 채널이 이걸 바꿔두면 로컬 사용자의 다음 spawn/이슈
    버튼이 조용히 다른 곳을 향한다. 제목·설명·key 는 노출 채널에서도 그대로 편집된다.

## 0.12.1

### Patch Changes

- [#55](https://github.com/minjun0219/rocky-todo/pull/55) [`c814dd3`](https://github.com/minjun0219/rocky-todo/commit/c814dd37151ebcdb5a0be7b0930d8a93b936ccb8) Thanks [@minjun0219](https://github.com/minjun0219)! - 좁은 화면 터치 다듬기 — 실기기 피드백 3건

  - 체크박스 시각 크기 15 → 18px (히트 영역 44px 는 그대로)
  - 번호의 예약 폭 32px → 2ch — 체크박스와 번호 사이 빈 공터가 사라지고 두 자리까지
    우정렬 유지. 히트 영역은 그만큼 좌우로 더 벌림.
  - 드로어 액션 줄 간격 row-gap 8 → 12px — 44px 버튼이 줄바꿈되면 붙어 보이던 것.

## 0.12.0

### Minor Changes

- [#53](https://github.com/minjun0219/rocky-todo/pull/53) [`e89e69f`](https://github.com/minjun0219/rocky-todo/commit/e89e69f6a303ac31b64e25b0d8e135ea689d2791) Thanks [@minjun0219](https://github.com/minjun0219)! - 상세 드로어를 Radix Dialog 셸로 바꾼다

  수제 셸의 유일한 접근성 결함이던 **포커스 트랩·복원**이 생겼다 — 열리면 포커스가
  드로어 안으로 들어가고, Tab 이 밖으로 새지 않으며, 닫으면 원래 자리로 돌아간다.
  Esc(편집 중 가드 유지)·백드롭 탭·배경 스크롤 잠금은 Radix 로 넘어갔고 시각은 그대로다.
  912줄 단일 파일이던 DetailDrawer 는 셸 + 6파일로 분해됐다.

- [#40](https://github.com/minjun0219/rocky-todo/pull/40) [`3a9835e`](https://github.com/minjun0219/rocky-todo/commit/3a9835e2de7ef3a105147f1401ec0bdd1030feaa) Thanks [@minjun0219](https://github.com/minjun0219)! - handoff 가 idle 세션에도 닿게 한다

  `handoff` 배달(claim)은 훅에서만 일어나고 훅은 턴 경계(`UserPromptSubmit` / `Stop`)에서만
  돈다. idle 세션에는 그 경계가 오지 않아 요청이 큐에 앉은 채 방치됐고, CLI 는 그걸
  "✓ … 에게 보냄" 이라고 알려 배달된 것처럼 보이게 했다.

  - `POST /api/todos/:ref/handoff` 응답에 `poke: { to, message }` 추가 — 대상 세션의 턴을 여는
    `SendMessage` 페이로드. 호출한 에이전트가 그대로 보내면 그 턴의 훅이 상세 지시를 주입한다.
  - CLI 출력을 "큐에 넣음 (아직 배달 전)" 으로 고치고, 턴을 여는 방법을 에이전트/사람 양쪽으로
    안내한다.
  - `/rocky-todo:next` 의 넘기기 절차에 poke 단계를 명시.

- [#37](https://github.com/minjun0219/rocky-todo/pull/37) [`f4fa3d3`](https://github.com/minjun0219/rocky-todo/commit/f4fa3d32bc8d65d8a42a0237ee3029d379324a26) Thanks [@minjun0219](https://github.com/minjun0219)! - 보드 메타 관리 — 이름·key·설명·GitHub 을 보고 고친다

  보드를 열면 목록 위에 헤더가 뜬다: 이름 · key · 한 줄 설명 · GitHub 링크 · 레포 경로.
  `편집` 으로 그 자리에서 이름·key·설명·GitHub 을 한 번에 고치고, CLI 는 `board show|rename|title|desc`
  가 같은 일을 한다. `PATCH /api/boards/:key` 도 이제 여러 필드를 함께 받는다 — 한
  트랜잭션이라 부분 적용이 없다(예전의 "repo 와 path 를 같이 보내면 400" 제약이 사라졌다).

  **key 를 바꿔도 옛 참조는 죽지 않는다.** 옛 key 는 별칭으로 남아 `gotgan-12` 같은 참조와
  옛 `board` 인자를 계속 받는다. 내보내는 문자열은 언제나 새 key 다.

  곁들여, 변경 요청(POST/PATCH/PUT/DELETE)에 cross-site 가드를 붙였다 — 다른 사이트의
  페이지가 무인증 로컬 데몬에 폼을 POST 하던 통로를 막는다. CLI·훅·MCP·웹 UI 는 영향 없다.

- [#43](https://github.com/minjun0219/rocky-todo/pull/43) [`28b2e3d`](https://github.com/minjun0219/rocky-todo/commit/28b2e3d9cf0734e3773878200ad785d3ad0f961c) Thanks [@minjun0219](https://github.com/minjun0219)! - 좁은 화면에서 할 일 한 줄을 한 덩어리로 붙인다

  390px 에서 한 항목이 세 줄 120px 로 흩어져 한 화면에 5개밖에 안 들어갔다. 체크박스와
  번호만 있는 첫 줄이 제목과 떨어져 보여 한 항목이 두 개처럼 읽히기도 했다.

  원인은 `flex-wrap: wrap` + `.todo-ref`/`.todo-title` 양쪽의 `min-height: 44px` 였다 —
  탭 타깃을 맞추려던 그 min-height 가 각자 자기 flex 줄을 44px 로 밀어올렸다.

  2행 grid 로 바꿔 배치와 타깃 크기를 분리했다. 44px 는 컨트롤의 padding 으로 확보하므로
  칩이 없는 항목은 한 줄로 끝난다. 칩 줄은 제목 열에 맞춰 좌측을 정렬했고, 완료된 항목은
  칩 줄을 접어(댓글 배지는 남긴다) 남은 일을 덜 가리게 했다.

  같은 화면에 5개 → 9개. **넓은 화면 레이아웃은 바뀌지 않는다** — 새로 생긴 `.todo-meta`
  래퍼가 그쪽에서는 `display: contents` 다.

- [#48](https://github.com/minjun0219/rocky-todo/pull/48) [`0c3c5e9`](https://github.com/minjun0219/rocky-todo/commit/0c3c5e9bce3d50a9950a7c5d3ce3a87ec7e52b95) Thanks [@minjun0219](https://github.com/minjun0219)! - 모바일 사용성 — 바텀시트 드로어 + 메모 레일 접힘

  - 좁은 화면의 상세 드로어가 옆이 아니라 **아래에서 올라오는 시트**가 된다 (88dvh,
    상단 그랩바, 올라오는 전이 — reduced-motion 시 꺼짐). 닫기 버튼은 우상단에서
    **우하단 엄지 존의 고정 pill** 로 내려온다 (safe-area 대응).
  - 메모 레일이 좁은 화면에서 **기본 접힘**이다 — 헤더가 개수를 보여주는 토글이 되고,
    `+ 메모` 는 접힘을 강제로 편다. 넓은 화면은 그대로.

- [#45](https://github.com/minjun0219/rocky-todo/pull/45) [`db3eb94`](https://github.com/minjun0219/rocky-todo/commit/db3eb9436ff59be8ba55cb7938b913d889e45f44) Thanks [@minjun0219](https://github.com/minjun0219)! - Tailwind v4 토대를 깐다 — 시각 무변경

  `bun-plugin-tailwind` 를 `[serve.static]` 에 걸어 데몬이 서빙 시점에 CSS 를 Tailwind 로
  처리한다. 빌드 스텝은 여전히 없다. preflight 는 들이지 않고(theme + utilities 레이어만)
  `@theme inline` 으로 기존 의미 토큰(`--warm`/`--cool`/…)을 유틸리티에 다리 놓는다 —
  `text-warm` 처럼 의미 이름 그대로 쓰고, `text-amber-400` 류 원색 팔레트는 비활성.

  bunfig.toml 은 시작 시점 cwd 에서 읽히므로 spawn 쪽(cli/hook 의 `ensureDaemon`, launchd
  plist)이 cwd 를 레포 루트로 고정한다. 수제 keyframes 는 `rt-pulse` 로 네임스페이스 —
  Tailwind 스캐너가 bare `pulse` 를 클래스 후보로 오인해 자기 keyframes 를 싣는 충돌을
  원천 차단한다.

  기존 화면은 그대로다 — computed 스타일 스팟 체크로 확인. 파티션별 유틸리티 이관은
  후속 PR 에서 파일 단위로 간다.

- [#46](https://github.com/minjun0219/rocky-todo/pull/46) [`98facc7`](https://github.com/minjun0219/rocky-todo/commit/98facc7bfcb35c316f3731412fc4d49a0ad1eab3) Thanks [@minjun0219](https://github.com/minjun0219)! - 온도 띠 + 마이크로 폴리시

  - **온도 띠(thermal strip)** — 상단 바 중앙에 최근 활동 48건을 시간순 눈금으로 그린다.
    색은 두 대기 그대로(warm=에이전트, cool=사람), 과거로 갈수록 식는다(투명해진다).
    `/api/history` 가 이미 주는 `{actor, at}` 만 쓴다 — 스키마 변경 없음. 560px 아래에선
    숨긴다.
  - 상호작용 요소에 150ms 색 전이 (reduced-motion 시 꺼짐).
  - p1 칩에 14% 틴트 — 긴급이 외곽선뿐인 p2/p3 과 무게가 갈린다.
  - 보드 제목이 key 그대로면 같은 글자를 두 번 찍지 않는다.

### Patch Changes

- [#42](https://github.com/minjun0219/rocky-todo/pull/42) [`f35a6ff`](https://github.com/minjun0219/rocky-todo/commit/f35a6ff437cef643fc3470364897c87795786cf7) Thanks [@minjun0219](https://github.com/minjun0219)! - 모바일 댓글 도구의 좌우 탭 여백을 되살린다

  `@media (max-width: 900px)` 의 `.comment-tool { padding: 0 8px }` 가 뒤에 오는 베이스
  규칙의 `padding: 0` 에 덮여 있었다. 좁은 화면에서 댓글 수정·보관 버튼의 탭 타깃이
  글자 폭만큼으로 좁아져 누르기 어려웠다.

  반응형 파티션을 @import 목록의 마지막으로 옮겨 고쳤다 — 베이스를 `!important` 없이
  덮으려면 순서가 뒤여야 한다는 원래 의도대로다.

- [#54](https://github.com/minjun0219/rocky-todo/pull/54) [`f501d16`](https://github.com/minjun0219/rocky-todo/commit/f501d16b1e5f461528b7db1c6215c7c524b52ce2) Thanks [@minjun0219](https://github.com/minjun0219)! - 좁은 화면을 문서 스크롤로 되돌린다

  내부 스크롤 컨테이너(.layout overflow-y:auto)가 iOS 의 네이티브 스크롤 동작 —
  사파리 툴바 자동 숨김, 상태바 탭으로 맨 위, 자연스러운 고무줄 — 을 전부 죽이고
  있었다. 높이를 뷰포트에 가두지 않고 내용대로 흐르게 두면 문서가 스크롤한다.
  새 작업 입력(quick-add)의 sticky 는 문서 스크롤 기준으로 그대로 동작한다.

## 0.11.0

### Minor Changes

- [#35](https://github.com/minjun0219/rocky-todo/pull/35) [`7855777`](https://github.com/minjun0219/rocky-todo/commit/7855777b032cfe80a0009b4cf497ba0f02ad42d2) Thanks [@minjun0219](https://github.com/minjun0219)! - statusline 세그먼트 추가 — 창을 하나 더 띄우지 않고 보드를 본다

  `GET /api/statusline?cwd=&session=` 이 완성된 한 줄을 `text/plain` 으로 돌려준다.
  기본 템플릿은 이 세션이 잡은 항목(ref + 제목)과 댓글 수, 나에게 온 대기 요청,
  보드의 방치된 doing 을 싣고, 보여줄 게 없으면 아무것도 출력하지 않는다.
  템플릿은 `rocky.json` 의 `todo.statusline.template`(env `ROCKY_TODO_STATUSLINE`)로 바꾼다.

### Patch Changes

- [#33](https://github.com/minjun0219/rocky-todo/pull/33) [`0abc8f1`](https://github.com/minjun0219/rocky-todo/commit/0abc8f198f567645cebc6cd520662f9a0c0f4d82) Thanks [@minjun0219](https://github.com/minjun0219)! - 기동 시 tailscale serve 를 다른 데몬에게서 빼앗지 않는다

  `serve` 의 노출 지점은 443 의 `/` 하나뿐인 머신 공유 자원이라, 다른 포트로 뜬 개발/데모
  인스턴스가 기동하며 설치본의 테일넷 노출을 조용히 가져가는 일이 있었다. 이제 기동 시
  현재 serve 대상 포트를 먼저 확인해, 살아 있는 다른 rocky-todo 데몬이 쓰고 있으면 양보하고
  (그 인스턴스는 노출 없이 뜬다) 아무도 안 듣는 죽은 포트면 되찾는다. 수동 경로
  (`rocky-todo tailscale on`)는 그대로 인수한다.

## 0.10.0

### Minor Changes

- [#31](https://github.com/minjun0219/rocky-todo/pull/31) [`b5b2e87`](https://github.com/minjun0219/rocky-todo/commit/b5b2e87ff2c7d52eb16928eb12b27c4eda463c88) Thanks [@minjun0219](https://github.com/minjun0219)! - `/rocky-todo:next` 의 후보 목록이 늦게 나타나던 것을 고친다.

  CLI 는 40ms 였고 병목이 아니었다. 커맨드가 `--json`(후보 8건 10.8KB, 그중 `description` 만
  3.2KB)을 읽어 목록을 산문으로 다시 쓰고, 그 위에 툴 질문의 선택지 설명까지 새로 작문하는
  구조가 원인이었다. 특히 **툴 질문은 호출 블록이 전부 만들어져야 렌더돼서** 목록이 한 줄씩
  나타나는 체감을 낼 수 없다.

  - **커맨드에서 AskUserQuestion 을 걷어냈다.** 후보를 텍스트 목록으로 그대로 찍고 사용자가
    번호나 참조로 고른다. 클릭 한 번보다 "빨리 눈에 보이는 것" 이 이 커맨드에서는 낫다는
    판단이다. 보드가 다를 때 묻는 두 번째 질문도 같은 이유로 평문으로 바꿨다.
  - 커맨드는 이제 `--json` 대신 텍스트 출력을 그대로 옮긴다 — 재작문·재정렬 금지.
  - `next --json` 자체도 컴팩트 형태로 바꿨다(스크립트·CLI 를 직접 부르는 호스트용):
    `ref`·`number`·`board`·`title`·`reason`·`priority`·`status`·`due`·`labels`·`commentCount` +
    `description` 을 한 줄로 눌러 160자까지 자른 `summary`. 후보 8건 10.8KB → 4.5KB. 전문은
    `show REF` 에서 본다. `score` 와 `todo` 중첩은 없어졌다 — 0.9.0 의 그 모양에 기대는 스크립트는
    고쳐야 하므로 patch 가 아니라 minor 로 낸다.

## 0.9.0

### Minor Changes

- [#28](https://github.com/minjun0219/rocky-todo/pull/28) [`eba74b5`](https://github.com/minjun0219/rocky-todo/commit/eba74b56d4b83ebafac0e62e30ebbf9516bef9f6) Thanks [@minjun0219](https://github.com/minjun0219)! - 핸드오프를 배달 이후까지 추적하고, "처리중" 이 실제로 살아 있는지 보여준다.

  세션이 요청을 집어간 뒤 그 항목에 `start`(또는 start 를 건너뛴 `done`)를 부르면 착수로,
  `done` 이면 완료로 기록된다. 집어가 놓고 아무것도 안 하면 드로어에 "받았지만 착수하지
  않았다" 와 다시 보내기 버튼이 뜬다 — 대상 세션이 사라졌거나 일을 멈췄을 때만 뜨고, 아직
  작업 중이면 조용하다. 자동 재배달은 하지 않는다.

  "처리중" 뱃지는 이제 그 작업을 든 세션을 대조한다. 세션이 사라졌으면 "세션 없음", 살아
  있는데 턴이 끝났고 완료 처리가 없으면 "멈춤" 으로 뜬다. 세션을 확인할 수 없을 때만
  예전처럼 경과 30분 기준 "오래됨" 으로 물러난다.

- [#30](https://github.com/minjun0219/rocky-todo/pull/30) [`7245b7b`](https://github.com/minjun0219/rocky-todo/commit/7245b7bb6e40af2c1faffdc04989bcea5a4e3012) Thanks [@minjun0219](https://github.com/minjun0219)! - 다음 작업을 세션에서 바로 고른다 — `/rocky-todo:next` 커맨드 + `rocky-todo next` CLI.

  브라우저를 열어 번호를 클릭해 붙여넣는 우회 없이, 착수 후보를 랭킹해 보여주고 고른 항목을
  `start` 표시한 뒤 그 자리에서 시작한다. 참조를 알고 있으면 `/rocky-todo:next rocky-12` 로
  픽커를 건너뛴다.

  랭킹 순서: **주인 없는 진행중**(세션이 사라졌거나 멈춘 doing) → 마감(지남 > 오늘 > 7일 내)
  → 판정할 수 없는 진행중 → 우선순위 → 최근 댓글. 아래쪽 기준이 쌓여도 위쪽 기준을 뒤집지
  못한다. 살아 있는 세션이 붙들고 있는 항목과 열린 자식을 가진 우산 항목은 후보에서 빠진다.
  근거는 목록에 그대로 찍히고, 동점은 우선순위·position 으로 결정적으로 갈려 같은 보드를 두
  번 물어도 순서가 흔들리지 않는다.

## 0.8.0

### Minor Changes

- [#22](https://github.com/minjun0219/rocky-todo/pull/22) [`2ab7029`](https://github.com/minjun0219/rocky-todo/commit/2ab702921eec8cf46f5be993ee2d053261bf90b5) Thanks [@minjun0219](https://github.com/minjun0219)! - 보드 항목의 참조 표기를 `rocky#12` 에서 `rocky-12` 로 바꿨다. GitHub 이슈 번호와
  겹치던 `#` 를 없앤다. 보드에 속하지 않는 전역 메모는 `note-3` 으로 표기하며 `note` 는
  그 참조의 예약 접두사가 됐다(보드 이름으로는 여전히 쓸 수 있으나, 그 보드의 항목은
  `note-3` 과 겹치지 않도록 raw id 로만 참조된다). 옛 표기(`rocky#12` / `[#12](https://github.com/minjun0219/rocky-todo/issues/12)`)는 입력으로
  계속 받는다. 웹 UI 의 번호 버튼은 이제 `/rocky-todo:board rocky-12` 를 복사한다.

## 0.7.0

### Minor Changes

- [#20](https://github.com/minjun0219/rocky-todo/pull/20) [`d77faef`](https://github.com/minjun0219/rocky-todo/commit/d77faefc12b8415725744605beb4aac30ed90f1a) Thanks [@minjun0219](https://github.com/minjun0219)! - 보드에서 todo 전용 워크트리에 백그라운드 Claude Code 세션을 띄울 수 있다 (로컬 전용)

## 0.6.0

### Minor Changes

- [#15](https://github.com/minjun0219/rocky-todo/pull/15) [`0e64c67`](https://github.com/minjun0219/rocky-todo/commit/0e64c670a0022302e50fc696a3d08b8e63870129) Thanks [@minjun0219](https://github.com/minjun0219)! - 보드에서 실행 중인 Claude Code 세션으로 todo 를 넘기는 핸드오프. 웹 UI 버튼 / `rocky-todo handoff` CLI 로 보내면 대상 세션이 턴을 끝내는 순간 자동으로 착수한다. 세션 목록은 `claude agents --json` 에서 얻고, 보드 key 와 세션 cwd 가 애매하면 사용자가 고른다. MCP 도구는 5개 그대로.

### Patch Changes

- [#16](https://github.com/minjun0219/rocky-todo/pull/16) [`4687c61`](https://github.com/minjun0219/rocky-todo/commit/4687c61d6d9416a4bc06650b0c35b253b6c37d3a) Thanks [@minjun0219](https://github.com/minjun0219)! - 웹 UI 의 조용한 실패 셋을 드러낸다.

  연결 배지는 SSE 링크 상태만 반영한다 — REST 재조회 한 번의 실패로 배지를 내리면 열린
  `EventSource` 가 `onopen` 을 다시 쏘지 않아 배지가 영영 내려간 채 굳기 때문이다. 그 대가로,
  데몬이 살아 SSE 는 흐르는데 REST 만 실패하는 경우 배지는 초록인데 보드만 낡고 화면에는
  아무 신호도 남지 않았다. 이제 그 실패가 콘솔 경고로 남는다.

  주소 해석의 실패는 따로 적는다. 퍼머링크가 가리키는 항목을 열지 못한 것까지 "보드 재조회
  실패" 로 적으면 로그가 엉뚱한 곳을 가리킨다.

  뒤로가기로 죽은 퍼머링크에 돌아갔을 때 남던 처리되지 않은 rejection 을 없앴다.

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
