# AGENTS.md

AI 코딩 에이전트(Claude Code, opencode, codex 등)를 위한 rocky-todo 레포 가이드.

> **Single sources of truth.** 사람은 [`docs/rocky-todo.md`](./docs/rocky-todo.md)(설치·데몬·표면
> ·CLI·설정 — 한국어), 에이전트는 이 파일(레이아웃/코딩 규칙/변경 체크리스트)을 읽는다.
> [`README.md`](./README.md) 는 둘로 잇는 한 페이지 진입점 — 무엇인지와 링크만 둔다.

## Project in one line

**rocky-todo** — rocky 의 동반 Claude Code 플러그인(별도 레포). 시스템 유일 상주 데몬
(127.0.0.1:8636, `bun:sqlite`)이 공유 todo/스크래치패드 보드를 들고, 네 표면을 서빙한다:
`/` React 웹 UI(Bun fullstack 자동 번들 + SSE 실시간), `/api/*` REST, `/api/events` SSE,
`/mcp` streamable HTTP MCP(5도구 `todo_list` / `todo_write` / `todo_status` / `note_list` /
`note_write`). CLI(`rocky-todo`, `bin/rocky-todo` → `src/cli.ts`)는 얇은 HTTP 클라이언트로
데몬을 온디맨드 자동 기동한다. **이 플러그인 설치가 곧 활성화** — `todo.enabled` 스위치는
없다. SessionStart 훅(`hooks/ensure-daemon.ts`)이 데몬을 기동하고, UserPromptSubmit 훅
(`hooks/notify-todo.ts`)이 보드의 사람 변경을 세션에 주입한다(fail-open, Claude Code 전용).
계층(parentId)+섹션+보드(키=레포 이름), priority p1–p4/라벨/마감/링크(GitHub·Todoist URL),
doing 표시(start→actor+since), 전 mutation 히스토리 자동 기록,
댓글(todo 별 타임라인 — description 대신 진행 보고를 남기는 자리),
GitHub 이슈 생성(웹 UI 버튼/CLI `issue`/MCP `todo_write.createIssue` — `gh` CLI 를 빌려 토큰
미저장, 이슈 URL 을 links 에 자동 첨부, 보드마다 `owner/name` repo 필요, **로컬 요청 전용** —
아래 참고), **삭제 없음(아카이브만)**.
설정은 user `rocky.json` 의 `todo` 블록만 읽는다(`src/rocky-config.ts` 경량 로더 — rocky 본체의
`../core` 에 의존하지 않는다). project rocky.json 은 무시(전역 단일 인스턴스). 노출은 opt-in
(`todo.expose`: `lan` / `tailscale-serve`, 기본 루프백).

rocky 마켓플레이스가 이 레포를 github source 로 서빙한다 — 자체 marketplace.json 은 없다.
`dependencies:["rocky"]` 명목 선언(같은 마켓 안이라 자동 해석).

## Layout

```
rocky-todo/
├── .claude-plugin/plugin.json      # mcpServers(http 8636/mcp) + hooks + dependencies:["rocky"]
├── package.json + bun.lock         # self-contained (deps: mcp-sdk, react, react-dom, zod, zustand)
├── tsconfig.json / biome.json
├── bin/rocky-todo                  # #!/usr/bin/env bun → src/cli.ts 의 runCli
├── src/
│   ├── daemon.ts                   # Bun fullstack 진입 — 단일 인스턴스 가드 + / + /api/* + /mcp + '/*' fallback(퍼머링크)
│   ├── server.ts                   # buildTodoServer — REST 라우트 + SSE 허브 (DI)
│   ├── mcp.ts                      # MCP 5도구 + WebStandard streamable HTTP handler (stateless)
│   ├── store.ts                    # SQLite 스토어 — CRUD + 계층/섹션 + 댓글 + 아카이브 + 보드 메타/별칭 + history + change 이벤트
│   ├── migrations.ts               # PRAGMA user_version 마이그레이션 러너 (적용 전 DB 백업)
│   ├── cli.ts                      # CLI — 얇은 HTTP 클라이언트 + 컴팩트 출력 (runCli)
│   ├── client.ts                   # REST 클라이언트 (buildContext/daemonHealth/health/ensureDaemon/stopDaemon/request)
│   ├── actor.ts                    # actor 감지 + board key 유추(git remote > toplevel > cwd)
│   ├── actors.ts                   # AGENT_ACTORS/isAgentActor — 사람/에이전트 판정 단일 출처
│   ├── doing.ts                    # doingState/handoffPhase/isUnstarted 판정 (순수, 세션 대조)
│   ├── next.ts                     # 착수 후보 랭킹 + 렌더 (순수) — `next` CLI / :next 커맨드가 소비
│   ├── statusline.ts               # statusline 한 줄 템플릿 렌더 + cwd→보드 판정 (순수)
│   ├── config.ts                   # 런타임 설정 해석 (env > user rocky.json todo > 기본)
│   ├── rocky-config.ts             # ★ 경량 config 로더 (todo 블록만, enabled 미read, expandTilde 자체)
│   ├── notify.ts                   # UserPromptSubmit 훅 순수 로직 (사람 변경 필터 + 세션별 커서)
│   ├── sessions.ts                 # claude agents --json 래퍼 (활성 세션 목록 + 보드 매칭)
│   ├── handoff.ts                  # 핸드오프 주입문 + 대상 세션을 깨울 poke 생성 (순수)
│   ├── spawn.ts                    # 백그라운드 세션 기동 (워크트리 이름 규약 + claude --bg)
│   ├── tailscale.ts / launchd.ts   # tailscale serve 연동 / launchd install
│   ├── github.ts                   # gh CLI 연동 — createIssue/createIssueForTodo, git remote → owner/name 파싱
│   ├── local-request.ts            # 요청 출처 판별 — 로컬 게이트(이슈/spawn) + cross-site 변경 가드
│   ├── ui/                         # React 웹 UI — index.html + main.tsx + zustand store + route.ts(URL↔화면 순수 변환) + components/
│   │   ├── happydom.ts             # 렌더 테스트 preload (GlobalRegistrator) — test:dom 에서만 로드
│   │   └── test-support.tsx        # 렌더 테스트 픽스처/헬퍼 (todoFixture / boardFixture / renderWithStore)
│   └── *.test.ts(x)                # 순수 실행(.ts) / happy-dom 렌더 실행(.tsx) — 확장자가 실행 모드를 가른다
├── hooks/
│   ├── hooks.json                  # SessionStart→ensure-daemon(startup), UserPromptSubmit→notify-todo, Stop→handoff-stop
│   ├── ensure-daemon.ts (+test)    # health→없으면 spawn / 구버전이면 stop 후 재기동 (fail-open, DI)
│   ├── notify-todo.ts              # 사람 변경 주입 (fail-open, 데몬 미기동 시 no-op) — 핸드오프 claim 도 같이 본다
│   └── handoff-stop.ts (+test)     # Stop 훅 — 대기 중인 보드 요청을 집어 자동 착수 (fail-open, DI)
├── commands/next.md                # /rocky-todo:next — 후보 랭킹 → 선택 → 착수 (규칙은 board 스킬)
├── skills/board/SKILL.md           # 보드 활용 에티켓 + 설치 안내 (rocky-todo:board 스킬)
├── docs/rocky-todo.md              # 사용자용 설치/운영 문서
└── .github/workflows/ + .husky/    # CI/release + git hooks (rocky 미러)
```

**커맨드/스킬 경계**: `commands/*.md` 는 **얇은 진입점**이다 — 절차만 두고 보드 에티켓
(start/comment/done, actor, 가드레일)은 `skills/board/SKILL.md` 를 로드해 따르게 한다. 규칙을
커맨드로 복사하면 두 곳이 갈린다. 판정(랭킹 등)은 커맨드 본문이 아니라 `src/*.ts` 의 순수
함수에 두고 CLI 로 노출한다 — 그래야 테스트가 붙고 사람도 같은 결과를 본다.

**Import 규칙**: 전부 상대경로. `src/*` 는 서로 `./` 로, `hooks/*` 는 `../src/*` 로 import 한다.
`../core` 같은 rocky 본체 참조는 없다 (self-contained). `@modelcontextprotocol/sdk/...js` 처럼
외부 패키지가 요구하는 `.js` subpath 는 그대로 둔다.

## 데몬/설치 모델 (핵심)

- **설치 = 활성화**: `todo.enabled` 스위치 없음. `claude plugin disable rocky-todo` 로 끈다.
- **데몬 기동**: SessionStart(startup) 훅 `ensure-daemon.ts` 가 health→없으면 detached spawn.
  CLI 도 온디맨드 spawn. 상시 상주는 `rocky-todo daemon install`(launchd KeepAlive).
- **버전 인식 재기동**: 데몬은 플러그인 캐시의 **버전 디렉터리**(`.../rocky-todo/<v>/src/daemon.ts`)
  에서 실행되고 프로세스는 그 설치본보다 오래 산다. 그래서 훅은 health 유무만 보지 않고
  `/api/health` 의 `version` 을 자기 `package.json` 버전과 비교해, 다르면 `pid` 로 SIGTERM →
  종료 확인 → 현재 버전으로 재기동한다 (version 미보고 데몬 ≤0.1.0 도 stale 취급). 못 내리면
  재기동하지 않는다 — 보드가 없는 것보다 구버전이라도 있는 게 낫다.
  한계: **버전이 같으면 경로가 달라도 재기동하지 않는다** — 로컬 레포 데몬과 설치본 버전이
  같을 때(개발 중) 서로 갈아치우지 않는 건 의도된 동작. 강제 교체는 `rocky-todo daemon stop`.
- **첫 세션 순서 미보장**: SessionStart 데몬 기동 ↔ http MCP 초기화 순서는 보장 안 됨. 첫 세션
  MCP `failed` 는 `/mcp` retry / 다음 세션 / launchd 로 해소 — 감안 사항.
- **전역 단일 인스턴스**: 포트가 락. project rocky.json 무시, user rocky.json 의 todo 블록만.
- **데모/개발 인스턴스는 전역 설정을 상속하지 않는다** — `bun run demo` 로 띄운다.
  이 스크립트는 `ROCKY_CONFIG=./demo.rocky.json` 을 걸어 데몬이 user `rocky.json` 을 **아예
  안 읽게** 만든다 (전용 포트 8993 / `/tmp/rt-demo` / `expose: "off"`).
  `bun run src/daemon.ts` 를 맨손으로 부르면 포트·디렉터리를 env 로 갈라놔도 **`expose` 는
  전역 설정에서 딸려온다**. 실제로 그렇게 뜬 데모가 user config 의 `tailscale-serve` 를 물려받아
  기동 시 `tailscale serve` 를 자기 포트로 잡았고, 설치본이 열어둔 테일넷 노출을 빼앗아
  폰에서 빈 데모 보드가 보이는 사고가 났다 (`serve` 의 노출 지점은 443 의 `/` 하나뿐인
  머신 공유 자원인데, 단일 인스턴스 보장은 *같은 포트* 기준이라 둘은 공존한다).
  전역 설정을 일부러 태우고 싶을 때만 맨손으로 부른다.
- **serve 자동 보장은 남의 노출을 빼앗지 않는다**(위 사고의 코드 측 방어, `src/tailscale.ts`):
  기동 시 `serve status --json` 의 루트 프록시 포트를 보고 `decideServeAction` 이 판정한다 —
  빈 자리면 `claim`, 내 포트면 `keep`, **살아 있는 다른 rocky-todo 데몬**이면 `yield`(그
  인스턴스는 노출 없이 뜬다), 아무도 안 듣는 죽은 포트면 `reclaim`. `reclaim` 이 있어야
  한 번 빼앗긴 노출이 정상 데몬 재기동으로 복구된다 — 무조건 양보로 만들면 stale 설정이
  영구화된다. 점유자 판별은 `daemonHealth`(신원 검증 포함)라 무관한 서비스가 그 포트를
  물고 있어도 `reclaim` 이 아니라 그쪽을 데몬으로 오인하지 않는다. **수동 경로
  (`rocky-todo tailscale on` → `tailscaleServeOn`)는 가드하지 않는다** — 사용자가 명시적으로
  넘기라고 한 것이다.
- **이슈 생성은 로컬 요청 전용**: 보드는 무인증이고 `todo.expose` 로 노출하는 대상이지만,
  이슈 생성은 데몬 사용자의 `gh` 인증을 빌려 외부에 되돌릴 수 없는 글을 쓴다 — 보드 쓰기
  권한이 GitHub 쓰기 권한으로 확대되는 지점이라 노출 설정과 무관하게 막는다. 판별은
  `src/local-request.ts` 의 `isLocalRequest` 하나이고, REST(403)와 `/mcp`(도구 에러)가
  같이 쓴다. **peer 주소만으로는 부족하다** — `tailscale serve` 는 tailnet 요청을 루프백으로
  프록시하므로 원격도 `127.0.0.1` 로 보인다. 그래서 루프백 주소 **+ 프록시 헤더 없음**
  (`x-forwarded-*` / `forwarded` / `tailscale-user-*`)을 함께 본다. 헤더 위조는 요청을 덜
  신뢰하게만 만들 수 있어 우회 수단이 못 된다. peer 주소는 `daemon.ts` 가
  `server.requestIP(req)` 로 넘기고, 안 넘어오면 거부다(fail-closed). 웹 UI 는
  `/api/health` 의 `issueCreateAllowed` 를 부팅에 한 번 보고 버튼 대신 이유를 보여준다 —
  힌트일 뿐 강제는 서버가 한다.
- **cross-site 변경은 라우트 전에 끊는다**(`isCrossSiteRequest` in `src/local-request.ts`):
  데몬은 무인증이라 사용자가 방문한 악성 페이지가 `enctype="text/plain"` 폼으로 preflight
  없이 루프백에 POST 하면 `isLocalRequest` 를 그대로 통과한다(peer 는 `127.0.0.1`, 프록시
  헤더 없음). 그래서 `server.ts` 의 `fetch` 맨 앞에서 변경 메서드(POST/PATCH/PUT/DELETE)만
  걸러 403 을 낸다 — `/mcp`(`createMcpFetchHandler`)도 같은 가드를 자기 앞단에 둔다.
  그쪽은 `daemon.ts` 가 별도 라우트로 붙여 `api.fetch` 를 안 타기 때문이다(전송 규약이
  이미 폼 POST 를 걸러내지만 규칙에 예외를 남기지 않는다). 판정 1순위는 **`Sec-Fetch-Site`** 이고 `cross-site` 만 막는다 —
  브라우저가 요청 URL 과 개시자를 비교해 계산한 값이라 프록시가 `Host` 를 바꿔도 흔들리지
  않는다. `Origin` 문자열 비교를 1순위로 삼으면 `tailscale serve` 를 거친 정상 화면
  (브라우저는 `https://<host>.ts.net`, 데몬은 `127.0.0.1:8636`)을 막을 위험이 있어
  `Sec-Fetch-Site` 가 없을 때만 폴백으로 쓴다. 헤더가 **둘 다 없으면 통과** — 브라우저는
  cross-origin 쓰기에 `Origin` 을 반드시 붙이므로 부재는 비브라우저 클라이언트(CLI·훅·
  MCP)라는 뜻이다. 읽기는 막지 않는다(응답을 못 가져가는 cross-origin 읽기를 막을 값이 없다).
- **보드 메타(`updateBoard` in `src/store.ts`)**: key(slug)·title·description·repo·path 를
  **한 트랜잭션에** 고친다. `PATCH /api/boards/:key` 가 다섯 필드를 함께 받고(예전의
  "repo 와 path 를 같이 보내면 400" 제약은 부분 적용 위험 때문이었는데 트랜잭션이 그걸
  없앴다), `null` 은 "지운다"·빈 문자열은 400 이다(폼이 실수로 비워 보낸 값이 설정을
  날리지 않게 하는 구분). `setBoardRepo`/`setBoardPath` 는 이제 이 함수의 얇은 입구다.
  **key 변경은 옛 key 를 `board_aliases` 에 남긴다**(user_version 6) — key 는 참조
  접두사이자 cwd 유추 대상이라, 그냥 바꾸면 히스토리·댓글·GitHub 이슈에 박힌 `gotgan-12`
  와 훅/CLI 가 보내는 옛 `board` 인자가 통째로 죽는다. 별칭은 **입력 전용**이다:
  `boardIdOf`/`resolveRef`/`ensureBoard` 가 전부 별칭을 보고, `refOf` 가 내보내는 문자열은
  언제나 새 key 다. `ensureBoard` 까지 별칭을 보는 이유는 읽기/쓰기 갈라짐을 막기 위해서다
  — 안 그러면 `todo_list { board: "gotgan" }` 은 이름 바뀐 보드를 읽는데
  `todo_write { board: "gotgan" }` 은 같은 이름의 빈 보드를 새로 만든다. 그 대가로 한 번
  쓴 key 는 은퇴한다(다른 보드가 재사용 불가 — 시도하면 `board key already in use`).
  웹 UI 는 보드 목록 위 `BoardHeader` 가 이 전부를 보여주고 편집한다.
  **별칭이 닿지 않는 곳이 하나 있다**: `matchBoard`(`src/sessions.ts`)는 세션 cwd 의
  경로 세그먼트에 **현재 key** 가 있는지만 본다 — 핸드오프 대상 고르기와 `doing` 의
  `gone` 판정이 그걸 쓴다. 즉 key 를 디렉터리 이름과 **어긋나게** 바꾸면 그 두 자리에서
  후보를 못 찾는다(기능은 죽지 않고 사람이 고르게 된다). 이름 변경의 통상 방향은 반대
  (디렉터리에 맞추는 것)라 별칭 매칭까지는 넣지 않았다 — `boardKeyForCwd`(statusline)만
  `boards.path` 를 먼저 보므로 경로가 설정된 보드는 이 어긋남에 영향받지 않는다.
- **번호 참조(ref)**: todo/note 는 랜덤 id(`921gvwnr`, PK 로 유지) 외에 보드별 순번을 갖는다.
  id 를 받는 자리는 어디서든 `rocky-12`(보드 접두사) → `12`(현재 보드 컨텍스트 안의
  번호) → id 정확 일치 → id 유일 prefix 순으로 시도해 해석한다(`resolveRef` in
  `src/store.ts`). 구분자가 `-` 인 이유는 `#` 가 GitHub 이슈 번호와 겹쳐서다 — 보드는
  이슈를 만들어 붙일 수 있어 한 항목에 두 종류의 `#N` 이 나타날 수 있었다. 파싱은
  **가장 오른쪽** `-` 에서 갈린다(`rocky-todo-1` = 보드 `rocky-todo` 의 1번). 옛 표기
  `rocky#12`/`#12` 는 **입력으로만** 계속 받는다 — 제품이 내보내는 문자열은 전부 `-`
  형태다. notes 만 board 없이도 존재할 수 있어(글로벌 메모) 전역 번호 공간을 따로 갖고
  예약 접두사를 붙여 `note-3` 으로 렌더된다 — `note-N` 은 board 인자와 무관하게 늘
  전역 메모다. `note` 도 board key 로 만들 수 있다(`api`/`mcp` 와 같은 원칙 — board key 는
  레포 이름에서 유추되는 값이라 생성을 막지 않는다). 다만 `isRefSafeBoardKey('note') ===
  false` 라 그 보드의 항목은 `refOf` 가 `note-N` 대신 raw id 로 폴백한다. todos 는 항상
  보드에 속하므로 보드
  컨텍스트 없는 맨숫자는 에러다. 번호는 보드 안에서 `MAX(number)+1` 로 발급되어
  아카이브해도 회수(재사용)되지 않는다. **댓글은 이 번호 체계 밖이다** — 보드별
  순번 없이 댓글 id 로만 지정한다(`PATCH /api/comments/:id` 등). mutation 은 부모 todo 의
  히스토리(`entity: 'todo'`, action `comment`/`comment-edit`/`comment-archive`/
  `comment-unarchive`)로 기록되어 SSE·훅 주입 경로를 그대로 탄다.
  웹 UI 의 번호 버튼은 참조가 아니라 `/rocky-todo:board rocky-12` 슬래시 커맨드를
  복사한다(`boardCommand` in `src/ui/lib.ts`) — 붙여넣기 한 번이 곧 착수 요청이 된다.
- **핸드오프(보드 → 세션)**: 보드에서 todo 를 실행 중인 Claude Code 세션에 넘긴다.
  데몬은 세션에 밀 수 없다 — `handoffs` 큐에 쌓고 세션 훅이 당겨간다. `Stop` 훅이 집으면
  `decision: block` 으로 그 자리에서 착수하고, `UserPromptSubmit` 훅은 턴이 열릴 때 같은
  큐를 본다. 한 번에 한 건만 배달한다.
  **배달은 턴 경계에서만 일어나므로 idle 세션에는 닿지 않는다** — 턴을 여는 건 handoff 를
  호출한 에이전트 몫이다. `POST /api/todos/:ref/handoff` 는 그래서 `poke: { to, message }`
  (`buildHandoffPoke`)를 함께 돌려주고, 호출자가 그대로 `SendMessage` 로 보내면 그 턴의
  `UserPromptSubmit` 훅이 상세 지시를 주입한다. poke 본문을 늘리지 마라 — 같은 턴에
  주입문이 따로 오므로 내용이 겹친다.
  세션 목록은 `claude agents --json` (`src/sessions.ts`, 주입 가능 `RunCommand`) — `claude`
  CLI 가 없으면 이 기능만 비활성되고(`available: false` + `reason`) 보드 나머지는 정상이다.
  대상은 보드 key ↔ 세션 cwd **경로 세그먼트** 매칭 — 후보가 정확히 1개일 때만 자동으로
  보내고 아니면 사용자가 고른다. 대기 중인 요청에 TTL 은 없다 — 대상 세션이 사라지면
  "세션 없음"(stale)으로 표시만 하고 큐에는 남는다. **MCP 도구는 늘리지 않았다(5개 유지)**
  — 사람이 에이전트에게 넘기는 기능이지 에이전트끼리 일을 미루는 경로가 아니다.
- **핸드오프 라이프사이클 + doing 의 세션 귀속**(user_version 5): 배달(`delivered`)은
  "집어갔다"까지만 말한다. 그 세션이 실제로 착수했는지·끝냈는지는 `setTodoStatus` 가
  채운다 — `start` 가 오면 그 todo 의 *미수락 delivered* 중 가장 오래된 건에
  `accepted_at` 을 찍고 그 `session_id` 를 `todos.doing_session_id` 로 물려주며, `done` 은
  `completed_at` 을 찍고 귀속을 비운다(`stop` 도 비우지만 착수 기록은 남긴다).
  `status` enum 은 늘리지 않았다 — accepted/completed 는 타임스탬프뿐이고 단계는
  `handoffPhase` 가 파생한다(`?status=pending` 을 쓰는 기존 코드가 안 깨진다).
  두 예외: **start 없이 바로 done** 이면 `accepted_at` 을 `completed_at` 과 같이 찍고
  (안 그러면 "끝났는데 미착수"라는 모순이 남는다), **사람이 누른 start 는 귀속하지
  않는다**(그 요청은 여전히 세션이 안 집은 것이다).
  귀속이 필요한 이유는 `/mcp` 가 stateless 라 도구 호출에 세션 식별자가 없고 에이전트가
  자기 `session_id` 를 모르기 때문 — 핸드오프가 그걸 아는 유일한 경로다.
  판정은 `src/doing.ts`(순수): `doingState` 는 `live`(세션 busy) / `idle`(세션은 사는데
  턴이 끝나고 완료가 없다 — **가장 흔한 실패**) / `gone` / `unknown`. 귀속이 없는 doing 은
  보드 근사로 본다 — 에이전트 actor 이고 그 보드 경로에 활성 세션이 **0개**일 때만 `gone`,
  하나라도 있으면 `unknown`(모르는 것과 없는 것은 다르다). 세션 조회는 `doing` 이 하나도
  없으면 건너뛴다. 세션 식별자는 full UUID 와 spawn 의 짧은 8자 id 를 **둘 다** 대조한다.
  "배달됐는데 미착수"(`isUnstarted`)에는 **시간 임계값이 없다** — 세션이 `gone`/`idle` 일
  때만 경고이고 `busy` 면 조용하다. 자동 만료·자동 재배달은 없고 표시만 하며, 다시 보낼지는
  사람이 정한다(새 핸드오프가 생기고 원본은 `delivered` 로 보존). 웹 UI 는
  `/api/handoffs?open=true`(대기 중 + 미완료 배달)로 받는다.
- **statusline 세그먼트(`GET /api/statusline`)**: 보드를 보려고 창을 하나 더 띄우지 않으려는
  표면. `?cwd=&session=` 을 받아 **완성된 한 줄**을 `text/plain` 으로 낸다 — 렌더를 데몬이
  하는 이유는 소비자(Claude Code statusline 명령)를 `curl` 한 줄로 유지하려는 것이다.
  그 자리는 1초마다 × 열어둔 세션 수만큼 도는 유일한 경로라 bun 기동(~30–50ms)을 없애는
  값이 크다. 같은 이유로 이 라우트만 **세션 캐시 TTL 이 15초**다(`statuslineSessions`) —
  다른 라우트의 3초를 쓰면 `claude agents --json`(~220ms)이 3초마다 영구히 도는 배경
  부하가 된다. 세션 목록에서 얻는 건 방치 경고 하나뿐이라 15초 지연은 손해가 없다.
  템플릿 문법은 `{name}` 치환과 `[...]` 옵셔널 그룹 둘뿐이고, **ESC 바로 뒤의 `[`/`]` 는
  리터럴**이다 — 색을 별도 DSL 로 만들지 않고 템플릿에 ANSI 이스케이프를 직접 적게 한
  선택의 대가를 한 줄로 치른 것. 판정은 전부 `src/statusline.ts`(순수)에 있고 라우트는
  재료만 모은다. **실패는 조용하다**(빈 문자열) — 여기서 에러 본문을 내면 사용자
  프롬프트에 JSON 덩어리가 박힌다. 보드 판정은 `boardKeyForCwd` 로 `boards.path` 하위 →
  key 가 경로 세그먼트 순인데, `basename(cwd)` 를 쓰면 워크트리에서 원본 보드를 놓치기
  때문이고 이는 `matchBoard` 와 같은 규약이다. `{mine.*}` 이 핸드오프로 시작된 작업에만
  붙는 것도 같은 이유다 — `doing_session_id` 귀속이 생기는 유일한 경로다.
- **새 세션 띄우기(보드 → 새 워크트리)**: 실행 중인 세션이 없으면 보드가 `claude --bg
  --worktree todo-<번호>` 로 새 백그라운드 세션을 띄운다(`src/spawn.ts`). 워크트리 생성·
  재사용·정리는 전부 Claude Code 몫이고(`<repo>/.claude/worktrees/`, 정리는 `claude rm
  <id>`), 데몬은 이름을 결정론적으로 계산할 뿐이라 "이 todo 의 워크트리" 를 저장하지
  않는다. 대상 레포 경로는 `boards.path`(user_version 4). 그 워크트리에서 이미 도는
  세션이 있으면 **띄우지 않고** 기존 handoff 큐로 넘긴다 — 두 에이전트가 한 워크트리를
  같이 고치는 것을 막는 가드다. 이 가드는 두 겹이다: (1) 이 라우트만 **캐시 없는** 세션
  목록(`spawnSessions` 기본 `listSessions`)을 본다 — TTL 3초 캐시로 보면 spawn 이전
  스냅샷으로 판정하게 된다, (2) `worktreePath → 띄운 시각` 을 60초 기억해
  (`createRecentSpawns`, 데몬 수명 클로저) 그 창 안의 재요청은 **409** 다 — 재사용 분기로
  보내면 짧은 8자 id 로 pending 이 만들어져 full UUID 로 claim 하는 `Stop` 훅에 영영
  배달되지 않는다. (2)는 **실행 전에 잡는 예약**이다(`remember` → 실패 시 `forget`) —
  `await spawnSession` 뒤로 미루면 겹쳐 들어온 두 요청이 게이트를 나란히 통과한다.
  `boards.path` 는 절대경로만 받고 `realpathSync` 로 정규화해 워크트리
  경로 계산·spawn cwd·보드 저장에 **같은 값**을 쓴다(cwd 비교가 정확 문자열 일치다).
  `claude --bg` 실행은 비동기(`Bun.spawn` + await)다 — 최악 30초를 데몬 전체가 멎으면
  안 된다. 파이프는 `new Response(stream).text()` 로 읽지 않는다(detach 된 손자가 fd 를
  물면 영원히 매달린다) — 자식 종료 + 짧은 유예, 또는 timeout 에서 끊는다(`runInDir`).
  `--permission-mode` 는 넘기지 않는다(사용자 기본 설정).
  **이슈 생성과 같은 로컬 요청 전용**(`isLocalRequest`, 403) — 보드 쓰기 권한이 프로세스를
  띄우는 권한으로 확대되는 지점이다. MCP 도구는 여전히 5개다.

## Coding rules

- **Language**: TypeScript (`type: module`). Bun 이 `.ts` 를 직접 실행 — no build, no `dist/`.
- **Imports**: `.js`/`.ts` 확장자 붙이지 않는다 (`moduleResolution: Bundler`). 모두 상대경로.
- **ESM safety**: `__dirname` 금지. `import.meta.dir` / `import.meta.url` 사용.
- **Dependencies**: 최소화. 현재 prod-dep: `@modelcontextprotocol/sdk`(MCP), `react`+`react-dom`+
  `zustand`(웹 UI — Bun fullstack 이 서빙 시 자동 번들, 데몬 전용), `zod`(MCP 툴 스키마).
  `bun:sqlite`/`bun:test` 는 내장. HTTP 는 Bun native `fetch`. 신규 런타임 dep 은 별도 논의.
- **Tests**: 테스트는 소스 옆에 두고 `bun run test`. fs 의존 테스트는 `mkdtempSync` 로 격리.
  **확장자가 실행 모드를 가른다** — `*.test.ts` 는 순수 실행(DOM 없음), `*.test.tsx` 는
  happy-dom 을 preload 한 렌더 실행. 자세한 건 아래 "웹 UI 렌더 테스트".
- **JSDoc**: exported 함수/클래스에 작성. 한국어 주석 OK (코드 식별자/경로/명령/URL 은 영어 원형).

## 웹 UI 렌더 테스트

React 컴포넌트를 실제로 렌더해 상호작용을 검증한다 — 클릭 → input 전환, Enter 저장 /
Esc 취소, 인라인 폼의 에러 표시처럼 로직을 순수 함수로 뽑아도 "그 상호작용이 실제로
되는가" 를 증명하지 못하는 자리들. 러너는 **`bun:test` 그대로**다 (vitest 없음).

- devDep 3개: `@happy-dom/global-registrator` + `@testing-library/react` +
  `@testing-library/user-event`. preload 는 `src/ui/happydom.ts` (3줄).
- 픽스처/헬퍼는 `src/ui/test-support.tsx` — `todoFixture` / `boardFixture` /
  `renderWithStore`. zustand 스토어는 모듈 싱글턴이라 테스트끼리 같은 인스턴스를 공유한다 —
  `renderWithStore` 가 매 렌더마다 `replace: true` 로 초기 상태를 깔고 인자로 받은 필드만
  얹어 격리한다. 그래도 각 테스트는 자기가 읽는 필드를 명시한다. `afterEach(cleanup)` 필수.
- 렌더 밖에서 스토어를 직접 바꿀 땐 `act()` 로 감싼다 — 안 그러면 리렌더가 flush 되지 않는다.

**실행이 두 갈래인 이유 (중요).** happy-dom 의 `GlobalRegistrator` 는 `fetch` 등 HTTP
전역을 갈아치운다. 이걸 전역 preload(`bunfig.toml` 의 `[test] preload`)로 걸면 데몬/CLI
테스트가 그 fetch 를 타면서 무더기로 타임아웃한다(실측: 1.1s → 52s, 11 fail). `--isolate`
로도 안 풀린다 — preload 가 파일마다 다시 돌기 때문이다. 그래서 확장자로 갈라 두 번 돌린다:

```bash
bun run test        # test:unit && test:dom — 이게 기본 진입점이다
bun run test:unit   # *.test.tsx 제외 — 순수 실행
bun run test:dom    # *.test.ts 제외 + happy-dom preload — 렌더 실행
```

`bun test` 를 맨손으로 부르면 두 갈래가 섞여 깨진다. 항상 `bun run test` 를 쓴다.

## Common commands

```bash
bun install
bun run check       # Biome verify
bun run fix         # Biome safe fix + format
bun run typecheck   # tsc --noEmit
bun run test        # 모든 테스트 (unit + dom) — 맨손 `bun test` 는 쓰지 않는다
bun run demo        # 데모 데몬 (전역 설정 미상속 — :8993 / /tmp/rt-demo / expose off)
bunx changeset      # user-facing 변경의 버전 의도 선언 (패키지 이름은 스코프까지 — 아래 참고)
```

## Change checklist

1. `bun run check` 통과
2. `bun run typecheck` 통과
3. `bun run test` 통과 (unit + dom 양쪽)
4. 사용자 표면(도구/env/CLI/커맨드)이 바뀌면 문서 셋을 동기화 — `docs/rocky-todo.md`(사람용
   설치·운영·표면 단일 출처) + 이 `AGENTS.md`(에이전트) + 진입 페이지 `README.md`.
5. 새 env var 추가 시 소비 지점(`src/config.ts` / `src/rocky-config.ts`) 갱신 +
   `docs/rocky-todo.md` 의 env 표 갱신.
6. MCP 도구 계약이 바뀌면 `src/mcp.ts`(등록) + `src/server.ts`/`src/store.ts`(구현) 갱신.
7. `rocky.json` 의 `todo` 모양이 바뀌면 `src/rocky-config.ts`(런타임) 갱신 (+ 스키마 문서화 시 함께).
8. 사용자 표면 변경이면 `bunx changeset` 으로 버전 의도 선언. **frontmatter 의 패키지 이름은
   `package.json` 의 `name` 그대로 — 스코프까지 적는다**(`"@minjun0219/rocky-todo": minor`).
   어긋나면 PR CI 가 아니라 main 머지 뒤 Release 워크플로가 죽어 릴리스만 조용히 멎는다.
   `scripts/check-changesets.ts`(= `bun run check:changesets`, CI 스텝)가 이걸 PR 에서 잡는다.

## Output / communication

- 사용자와 기본 대화 언어는 한국어. 코드 식별자/경로/명령은 영어.
- 커밋/PR 제목은 Conventional Commits (`type(scope): 한국어 요약`, 50자 내외).
- 변경 요약은 짧게 (한 줄 + 필요한 만큼 불릿). 장문 리포트 지양.
- **task id 는 레포에 남기지 않는다** — 커밋 메시지, PR 제목·본문, 브랜치명, 코드 주석,
  changeset 어디에도 보드 참조(`rocky-12`)를 적지 않는다. 보드 번호는 사용자 로컬
  데몬의 것이라 레포를 보는 다른 사람에게는 해석 불가능하고, 보드가 재생성되면 번호가
  달라진다. 작업과 항목의 연결은 보드 쪽(댓글·`links`)에 남긴다.
  **예외: 테스트 픽스처.** `renderHandoffCreated('rocky-12', …)` 처럼 ref 파서·렌더러에
  먹이는 합성 입력은 실재하는 항목을 가리키는 주장이 아니라 `<board>-<number>` 라는 **형태**
  자체가 테스트 대상이라, 중립 문자열로 바꾸면 오히려 무엇을 검증하는지가 흐려진다. 금지의
  이유(외부인이 해석 못 하는 식별자를 레포에 박는 것)가 여기엔 해당하지 않는다.
