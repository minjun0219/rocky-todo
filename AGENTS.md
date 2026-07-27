# AGENTS.md

AI 코딩 에이전트(Claude Code, opencode, codex 등)를 위한 rocky-todo 레포 가이드.

> **Single sources of truth.** 사람은 [`FEATURES.md`](./FEATURES.md)(한국어 — 도구/설정/Quick start),
> 에이전트는 이 파일(레이아웃/코딩 규칙/변경 체크리스트)을 읽는다. [`README.md`](./README.md) 는 두
> 문서로 잇는 한 페이지 진입점. 사용자 대상 설치/운영 문서는 [`docs/rocky-todo.md`](./docs/rocky-todo.md).

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
│   ├── store.ts                    # SQLite 스토어 — CRUD + 계층/섹션 + 댓글 + 아카이브 + history + change 이벤트
│   ├── migrations.ts               # PRAGMA user_version 마이그레이션 러너 (적용 전 DB 백업)
│   ├── cli.ts                      # CLI — 얇은 HTTP 클라이언트 + 컴팩트 출력 (runCli)
│   ├── client.ts                   # REST 클라이언트 (buildContext/daemonHealth/health/ensureDaemon/stopDaemon/request)
│   ├── actor.ts                    # actor 감지 + board key 유추(git remote > toplevel > cwd)
│   ├── config.ts                   # 런타임 설정 해석 (env > user rocky.json todo > 기본)
│   ├── rocky-config.ts             # ★ 경량 config 로더 (todo 블록만, enabled 미read, expandTilde 자체)
│   ├── notify.ts                   # UserPromptSubmit 훅 순수 로직 (사람 변경 필터 + 세션별 커서)
│   ├── sessions.ts                 # claude agents --json 래퍼 (활성 세션 목록 + 보드 매칭)
│   ├── handoff.ts                  # 핸드오프 주입문 생성 (순수)
│   ├── spawn.ts                    # 백그라운드 세션 기동 (워크트리 이름 규약 + claude --bg)
│   ├── tailscale.ts / launchd.ts   # tailscale serve 연동 / launchd install
│   ├── github.ts                   # gh CLI 연동 — createIssue/createIssueForTodo, git remote → owner/name 파싱
│   ├── local-request.ts            # 요청 출처 판별(루프백 + 프록시 헤더 없음) — 이슈 생성 게이트
│   ├── ui/                         # React 웹 UI — index.html + main.tsx + zustand store + route.ts(URL↔화면 순수 변환) + components/
│   └── *.test.ts                   # store / server / mcp / cli / actor / config / rocky-config 테스트
├── hooks/
│   ├── hooks.json                  # SessionStart→ensure-daemon(startup), UserPromptSubmit→notify-todo, Stop→handoff-stop
│   ├── ensure-daemon.ts (+test)    # health→없으면 spawn / 구버전이면 stop 후 재기동 (fail-open, DI)
│   ├── notify-todo.ts              # 사람 변경 주입 (fail-open, 데몬 미기동 시 no-op) — 핸드오프 claim 도 같이 본다
│   └── handoff-stop.ts (+test)     # Stop 훅 — 대기 중인 보드 요청을 집어 자동 착수 (fail-open, DI)
├── skills/board/SKILL.md           # 보드 활용 에티켓 + 설치 안내 (rocky-todo:board 스킬)
├── docs/rocky-todo.md              # 사용자용 설치/운영 문서
└── .github/workflows/ + .husky/    # CI/release + git hooks (rocky 미러)
```

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
- **번호 참조(ref)**: todo/note 는 랜덤 id(`921gvwnr`, PK 로 유지) 외에 보드별 순번을 갖는다.
  id 를 받는 자리는 어디서든 `rocky#12`(보드 접두사) → `#12`/`12`(현재 보드 컨텍스트 안의
  번호) → id 정확 일치 → id 유일 prefix 순으로 시도해 해석한다(`resolveRef` in `src/store.ts`).
  notes 만 board 없이도 존재할 수 있어(글로벌 메모) 전역 번호 공간을 따로 갖고 `#3` 처럼
  접두사 없이 렌더된다 — 글로벌에서 맨숫자 `#N` 은 이 전역 공간을 가리키지만, todos 는 항상
  보드에 속하므로 보드 컨텍스트 없는 맨숫자는 에러다. 번호는 보드 안에서 `MAX(number)+1` 로
  발급되어 아카이브해도 회수(재사용)되지 않는다. **댓글은 이 번호 체계 밖이다** — 보드별
  순번 없이 댓글 id 로만 지정한다(`PATCH /api/comments/:id` 등). mutation 은 부모 todo 의
  히스토리(`entity: 'todo'`, action `comment`/`comment-edit`/`comment-archive`/
  `comment-unarchive`)로 기록되어 SSE·훅 주입 경로를 그대로 탄다.
- **핸드오프(보드 → 세션)**: 보드에서 todo 를 실행 중인 Claude Code 세션에 넘긴다.
  데몬은 세션에 밀 수 없다(훅으로 유휴 세션을 깨울 수단이 없다) — `handoffs` 큐에 쌓고
  세션 훅이 당겨간다. `Stop` 훅이 집으면 `decision: block` 으로 그 자리에서 착수하고,
  `UserPromptSubmit` 훅은 사용자가 말을 걸 때 같은 큐를 본다. 한 번에 한 건만 배달한다.
  세션 목록은 `claude agents --json` (`src/sessions.ts`, 주입 가능 `RunCommand`) — `claude`
  CLI 가 없으면 이 기능만 비활성되고(`available: false` + `reason`) 보드 나머지는 정상이다.
  대상은 보드 key ↔ 세션 cwd **경로 세그먼트** 매칭 — 후보가 정확히 1개일 때만 자동으로
  보내고 아니면 사용자가 고른다. 대기 중인 요청에 TTL 은 없다 — 대상 세션이 사라지면
  "세션 없음"(stale)으로 표시만 하고 큐에는 남는다. **MCP 도구는 늘리지 않았다(5개 유지)**
  — 사람이 에이전트에게 넘기는 기능이지 에이전트끼리 일을 미루는 경로가 아니다.
- **새 세션 띄우기(보드 → 새 워크트리)**: 실행 중인 세션이 없으면 보드가 `claude --bg
  --worktree todo-<번호>` 로 새 백그라운드 세션을 띄운다(`src/spawn.ts`). 워크트리 생성·
  재사용·정리는 전부 Claude Code 몫이고(`<repo>/.claude/worktrees/`, 정리는 `claude rm
  <id>`), 데몬은 이름을 결정론적으로 계산할 뿐이라 "이 todo 의 워크트리" 를 저장하지
  않는다. 대상 레포 경로는 `boards.path`(user_version 4). 그 워크트리에서 이미 도는
  세션이 있으면 **띄우지 않고** 기존 handoff 큐로 넘긴다 — 두 에이전트가 한 워크트리를
  같이 고치는 것을 막는 가드다. `--permission-mode` 는 넘기지 않는다(사용자 기본 설정).
  **이슈 생성과 같은 로컬 요청 전용**(`isLocalRequest`, 403) — 보드 쓰기 권한이 프로세스를
  띄우는 권한으로 확대되는 지점이다. MCP 도구는 여전히 5개다.

## Coding rules

- **Language**: TypeScript (`type: module`). Bun 이 `.ts` 를 직접 실행 — no build, no `dist/`.
- **Imports**: `.js`/`.ts` 확장자 붙이지 않는다 (`moduleResolution: Bundler`). 모두 상대경로.
- **ESM safety**: `__dirname` 금지. `import.meta.dir` / `import.meta.url` 사용.
- **Dependencies**: 최소화. 현재 prod-dep: `@modelcontextprotocol/sdk`(MCP), `react`+`react-dom`+
  `zustand`(웹 UI — Bun fullstack 이 서빙 시 자동 번들, 데몬 전용), `zod`(MCP 툴 스키마).
  `bun:sqlite`/`bun:test` 는 내장. HTTP 는 Bun native `fetch`. 신규 런타임 dep 은 별도 논의.
- **Tests**: `*.test.ts` 를 소스 옆에 두고 `bun test`. fs 의존 테스트는 `mkdtempSync` 로 격리.
- **JSDoc**: exported 함수/클래스에 작성. 한국어 주석 OK (코드 식별자/경로/명령/URL 은 영어 원형).

## Common commands

```bash
bun install
bun run check       # Biome verify
bun run fix         # Biome safe fix + format
bun run typecheck   # tsc --noEmit
bun test            # 모든 테스트
bunx changeset      # user-facing 변경의 버전 의도 선언
```

## Change checklist

1. `bun run check` 통과
2. `bun run typecheck` 통과
3. `bun test` 통과
4. 사용자 표면(도구/env/CLI)이 바뀌면 **두 single source** 동기화 — `FEATURES.md`(사람) +
   이 `AGENTS.md`(에이전트) — 와 진입 페이지 `README.md`, 운영 문서 `docs/rocky-todo.md`.
5. 새 env var 추가 시 소비 지점(`src/config.ts` / `src/rocky-config.ts`) 갱신 + `FEATURES.md`
   env 표 갱신.
6. MCP 도구 계약이 바뀌면 `src/mcp.ts`(등록) + `src/server.ts`/`src/store.ts`(구현) 갱신.
7. `rocky.json` 의 `todo` 모양이 바뀌면 `src/rocky-config.ts`(런타임) 갱신 (+ 스키마 문서화 시 함께).
8. 사용자 표면 변경이면 `bunx changeset` 으로 버전 의도 선언.

## Output / communication

- 사용자와 기본 대화 언어는 한국어. 코드 식별자/경로/명령은 영어.
- 커밋/PR 제목은 Conventional Commits (`type(scope): 한국어 요약`, 50자 내외).
- 변경 요약은 짧게 (한 줄 + 필요한 만큼 불릿). 장문 리포트 지양.
