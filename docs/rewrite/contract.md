# 동결 계약 — Rust 재작성의 정본

TS 원본(`src/*.ts`)에서 추출한 외부 표면 계약. 재작성의 성공 기준은 **동작 동일성**이고,
이 문서가 그 대조표다. 실행 가능한 스펙은 포팅되는 테스트(`server.test.ts` 등)이며, 이
문서는 그 지도다 — 어긋나면 테스트가 이긴다.

추출 시점: v0.14.0 (2026-08-31). 원본 근거는 각 절에 표기.

## 공통 규약

- **포트 8636 고정** — `plugin.json` 의 `mcpServers.url`(`http://127.0.0.1:8636/mcp`)이
  설치본에 박혀 있다.
- **actor**: REST 는 `x-rocky-actor` 헤더, 부재 시 `'unknown'`. MCP 는 도구 인자 `actor`,
  부재 시 `'agent'`. 이 기본값 차이는 의도된 것이다.
- **JSON 본문 규칙** (`readBody`, server.ts):
  - content-type 에 `application/json` 이 포함돼야 한다(대소문자 무시). 아니면 에러
    `content-type must be application/json (got: …)` — 구형 브라우저 폼
    (`text/plain`)의 cross-site 쓰기를 막는 심층 방어다.
  - 파싱 실패 → `invalid JSON body`. 객체가 아니거나 배열 → `body must be a JSON object`.
  - **옵션 본문 라우트**(issue/spawn, `readOptionalBody`): 빈 본문이면 undefined 로
    통과하되, 빈 본문에 content-type 헤더가 **있으면** JSON 타입을 강제한다. 헤더도
    본문도 없는 요청(CLI 기본 경로)만 무검사 통과.
- **에러 매핑** (`toHttpError`): 스토어 에러 메시지가 `/not found/i` 에 걸리면 404,
  아니면 400. 본문은 `{ "error": string }`.
  - **예외 — 이슈 생성 라우트**: 실패는 항상 400 (`gh` 의 "HTTP 404: Not Found …" 가
    404 로 새면 "todo not found" 계약이 깨진다). 중복만 409.
- **204**: claim 에서 집을 것이 없을 때 본문 없는 204.

## 보안 게이트 (라우팅 전에 적용 — 누락 최다발 지점)

### isLocalRequest (`src/local-request.ts`)

루프백 peer 주소 **그리고** 중계 헤더(`x-forwarded-*` / `forwarded` /
`tailscale-user-*`) 부재. peer 주소가 안 넘어오면 거부(fail-closed).
`tailscale serve` 가 테일넷 요청을 루프백으로 재다이얼하므로 주소만으로는 부족하다.
헤더 위조는 "있게" 만 가능해 덜 신뢰하는 방향으로만 작용한다.

적용 지점과 실패 형태:
| 지점 | 실패 |
|---|---|
| `POST /api/todos/:ref/issue` | 403 `NON_LOCAL_ISSUE_MESSAGE` — **todo 존재 검사보다 먼저** (ref 존재 여부도 흘리지 않는다) |
| `POST /api/todos/:ref/spawn` | 403 `NON_LOCAL_SPAWN_MESSAGE` |
| `PATCH /api/boards/:key` 의 `repo`/`path` 필드 | 403 `NON_LOCAL_BOARD_META_MESSAGE` (title/description/key 는 허용) |
| `POST /api/handoffs/claim` | **404** `not found: POST /api/handoffs/claim` — catch-all 과 구분 불가하게 위장 |
| MCP `todo_write.createIssue` | 도구 에러 `NON_LOCAL_ISSUE_MESSAGE` (`allowIssueCreate` 로 접어 전달) |
| `GET /api/health` 의 `issueCreateAllowed`/`spawnAllowed` | 힌트 필드 (강제는 각 라우트) |

### isCrossSiteRequest (`src/local-request.ts`)

변경 메서드(POST/PATCH/PUT/DELETE)에만 적용, 403 `CROSS_SITE_MESSAGE`.
판정 1순위 `Sec-Fetch-Site` == `cross-site` 만 차단. 없을 때만 `Origin` 문자열 비교
폴백. **둘 다 없으면 통과** (비브라우저 클라이언트). 읽기는 막지 않는다.
`/mcp` 도 GET 외 메서드에 같은 가드를 자기 앞단에 둔다.

## REST 표면 (server.ts — 총 31 메서드×경로)

`?board=` 쿼리 해석(`currentBoardIdOf`): 없으면 undefined. 있는데 안 풀리면 —
ref 가 맨숫자 꼴(`refNeedsBoardContext`)일 때만 `unknown board: <key>` 에러(400),
아니면 무시(CLI 가 cwd 유추 키를 무조건 붙이는 것 대응). MCP `resolveBoardId` 동일.

### 정적

| 메서드 경로 | 요청 | 응답 | 비고 |
|---|---|---|---|
| GET `/api/health` | — | `{ok:true, name:'rocky-todo', version, pid, issueCreateAllowed, spawnAllowed}` | version 은 stale 데몬 판별 근거 |
| GET `/api/statusline` | `?cwd=&session=` | `text/plain` 완성 한 줄 | 실패·빈 상태 = 빈 문자열. 아래 절 |
| GET `/api/events` | — | SSE | 아래 절 |
| GET `/api/boards` | `?includeArchived=true` | `Board[]` | |
| POST `/api/boards` | `{key!, title?}` | 201 `Board` | key 없으면 400 `key is required` |
| GET `/api/sections` | `?board=` **필수** | `Section[]` | board 없으면 400, 안 풀리면 `[]` |
| POST `/api/sections` | `{board!, title!}` | 201 `Section` | 없는 보드 404 (자동 생성 안 함 — todos 와 다름) |
| GET `/api/todos` | `?board=&status=&label=&includeArchived=` | `TodoView[]` | doing 있을 때만 세션 조회 → `doingState` 부착 |
| POST `/api/todos` | `{board!, title!, description?, section?, parentId?, priority?, due?, labels?, links?}` | 201 `TodoView` | 보드 자동 생성(ensureBoard) |
| GET `/api/notes` | `?board=&global=&includeArchived=` | `NoteView[]` | |
| POST `/api/notes` | `{title!, board?, content?}` | 201 `NoteView` | |
| GET `/api/sessions` | `?board=` | `{available, reason?, sessions: (AgentSession & {matched})[]}` | matched 는 board 없으면 전부 false |
| POST `/api/handoffs/claim` | `{sessionId!, via?}` | `ClaimedHandoff` 또는 **204** | 로컬 전용(404 위장). via 는 'prompt' 외엔 'stop' |
| GET `/api/handoffs` | `?board=&status=&open=true` | `HandoffView[]` | 없는 board 명시 → `[]`. stale/unstarted 판정은 아래 |
| GET `/api/changes` | `?sinceId=&limit=` | `ChangeFeedEntry[]` | sinceId 음수/비정수 400 |
| GET `/api/history` | `?entityId=&entity=&limit=` | `HistoryEntry[]` | |

### 동적 (`:ref` 는 URL 디코드 후 ref 문법 해석)

| 메서드 경로 | 요청 | 응답 | 비고 |
|---|---|---|---|
| PATCH `/api/boards/:key` | `{key?, title?, description?, repo?, path?}` | `Board` | 아래 "보드 메타" |
| POST `/api/sections/:id/archive` | — | `{ok:true}` | 섹션은 id 로만 |
| GET `/api/todos/:ref` | `?board=&includeArchived=` | `{todo: TodoView, history, comments}` | history 는 `DETAIL_HISTORY_EXCLUDED`(comment/comment-edit) 제외 |
| PATCH `/api/todos/:ref` | patch 필드 | `TodoView` | |
| POST `/api/todos/:ref/status` | `{action!}` | `TodoView` | action ∉ {start,stop,done,reopen,archive,unarchive} → 400 `invalid action: …` |
| POST `/api/todos/:ref/issue` | `{repo?}` (옵션 본문) | 201 `{url, todo}` | 중복 409 `{error, url}` (사전·사후 동일 본문). 로컬 전용 |
| POST `/api/todos/:ref/board` | `{board!}` | `TodoView` | 보드 간 이동 |
| POST `/api/todos/:ref/move` | `{before!}` — ref 또는 **명시적 null**(맨 끝) | `TodoView` | before 키 부재 400 (null 과 빠뜨림 구분) |
| POST `/api/todos/:ref/handoff` | `{sessionId?, note?}` | 201 `Handoff & {poke: {to, message}}` | 아래 "핸드오프" |
| POST `/api/todos/:ref/spawn` | `{note?, path?}` (옵션 본문) | 201 `{handoff, reused, worktreePath, sessionShortId?}` | 아래 "spawn". 로컬 전용 |
| POST `/api/todos/:ref/comments` | `{body!}` | 201 `Comment` | body 문자열 아니면 400 |
| PATCH `/api/comments/:id` | `{body!}` | `Comment` | 댓글은 번호 체계 밖 — id 로만 |
| POST `/api/comments/:id/(archive\|unarchive)` | — | `Comment` | |
| GET `/api/notes/:ref` | `?board=` | `{note: NoteView, history}` | |
| PATCH `/api/notes/:ref` | `{title?, content?, mode?}` | `NoteView` | |
| POST `/api/notes/:ref/(archive\|unarchive)` | — | `NoteView` | |
| POST `/api/handoffs/:id/cancel` | — | `Handoff` | |

### 보드 메타 (PATCH /api/boards/:key)

- 다섯 필드 독립·동시 전송 가능, `updateBoard` 가 **한 트랜잭션**에 적용.
- 분기는 값 타입이 아니라 **키 존재 여부**.
- 지우기는 `null` 로만(description/repo/path). 빈 문자열은 400 — 폼이 실수로 비워 보낸
  값이 설정을 날리지 않게. key/title 은 null 도 400.
- `repo` 는 `isRepoSlug`(OWNER/NAME) 검증. 값은 `trim()` 후 저장.
- patch 가 비면 400 `key, title, description, repo or path is required`.
- `repo`/`path` 변경은 로컬 전용(403), title/description/key 는 원격 허용.

### 핸드오프 (POST /api/todos/:ref/handoff)

1. todo 존재 404 → 이미 pending 있으면 409(한국어 메시지) → 세션 목록
   `available:false` 면 409(reason)
2. `sessionId` 타입 오류는 400 (조용한 자동 매칭 전락 금지). 지정했는데 비활성이면 400
3. 자동 매칭: `matchBoard` 후보 **정확히 1개**일 때만. 0개/복수 → 409
   `{error, candidates}` (0개면 candidates 는 전체 세션)
4. 성공: `createHandoff` + `buildHandoffPoke` 를 얹어 201. poke 본문은 늘리지 않는다
   (턴이 열리면 훅이 상세를 주입 — 중복 방지)

### spawn (POST /api/todos/:ref/spawn) — 순서가 계약이다

로컬 403 → todo 404 → 아카이브 400 → pending 409 → path 검증(절대경로 400, realpath
실패 400, `.git` 없음 400) → `recentSpawns.isRecent` 409 → 세션 목록 available 409 →
**live 세션 재사용 분기**(`findLiveSessionAt` — pending 핸드오프 생성, `reused:true`) →
예약 `remember` (**spawn 실행 전 동기 구간**) → `spawnSession` → 실패 시
`SpawnFailedError.started === false` 일 때만 `forget`(모르면 예약 유지) →
성공 후에만 `persistPathIfGiven` + `createSpawnedHandoff`.

- 세션 조회는 이 라우트만 **캐시 없는** `listSessions` (spawn 이전 스냅샷 금지)
- 세션 이름 `<boardKey>-<number>`, 워크트리 이름 `worktreeNameFor(number)` = `todo-<number>`
- `path` override 는 성공 후에만 영구 저장, 저장 값은 정규화된 경로

### GET /api/handoffs 판정

- 세션 조회는 `pending` 또는 `delivered && !acceptedAt` 이 있을 때만
- `stale`: pending 이고 세션 목록이 **신뢰 가능**(available)한데 대상 세션이 없음.
  available:false 면 판정하지 않는다(모름 ≠ 없음)
- `unstarted`: 세션 조회를 했을 때만 `isUnstarted`, 아니면 false(= 모름 포함)
- `phase`: `handoffPhase(handoff)` 파생 필드
- 자동 만료·자동 재배달 없음

## SSE (`/api/events`)

- 접속 직후 주석 프레임 `: connected\n\n`
- 이후 store change 이벤트마다 `data: <JSON(ChangeEvent)>\n\n`
- 헤더: `text/event-stream`, `cache-control: no-cache`, `connection: keep-alive`
- 해지: 스트림 cancel 에서 구독 해제

## statusline (`GET /api/statusline`)

- 항상 `text/plain; charset=utf-8`. **모든 실패·빈 상태 = 빈 문자열** (에러 본문이
  사용자 프롬프트에 박히면 안 된다)
- doing 0 && pending 0 이면 **세션 조회 전에** 빈 문자열로 귀환 (최빈 경로 비용 절감)
- 세션 별칭: full UUID 와 spawn 짧은 8자 id **둘 다** 대조 (`sessionAliases`)
- `{mine.*}` 은 `doingSessionId` 귀속 항목만. `{inbox}` 는 session 파라미터 필수.
  `{stale}` 은 doing 중 `idle`/`gone`. 보드 안 풀리면 전체 doing 으로 폴백(0 으로
  만들면 경고가 조용히 사라진다)
- 렌더 문법: `{name}` 치환 + `[...]` 옵셔널 그룹. **ESC(\x1b) 바로 뒤 `[`/`]` 는 리터럴**
- 세션 캐시: 이 라우트만 TTL **15초** (기본 3초, spawn 은 무캐시)

## MCP (`/mcp`)

- **stateless**: 요청마다 서버+transport 새로 생성, `sessionIdGenerator: undefined`,
  `enableJsonResponse: true`. 요청 종료 시 transport close.
  → rmcp 포팅 시 이 운용이 가능한지가 Phase 2 첫 스파이크
- cross-site 가드는 GET 외 메서드에 REST 와 동일 적용(403 JSON)
- `allowIssueCreate` 는 요청마다 `isLocalRequest` 로 접어 주입, 기본 false(fail-closed)
- 도구 5개 고정: `todo_list` / `todo_write` / `todo_status` / `note_list` / `note_write`.
  결과는 `{content:[{type:'text', text: JSON.stringify(값)}]}`
- 도구 스키마(설명 문구 포함)는 `src/mcp.ts` 원문이 정본 — 설명도 계약이다
  (에이전트 행동을 유도하는 문장들)

### todo_write 순서 보장 (all-or-nothing 지향)

1. `comment` 가 빈 문자열(trim 후)이면 **어떤 write 도 전에** 에러 `comment body is required`
2. `createIssue && !allowIssueCreate` 면 write 전에 에러
3. patch 경로: 이미 이슈 있으면 write 전에 에러. patch 필드가 하나도 없으면
   updateTodo 를 건너뛴다(빈 update 히스토리 방지)
4. create 경로: `assertBoardHasRepo` 를 createTodo **전에** (실패 시 todo 미생성 →
   재시도 안전). `gh` 실행 실패는 todo 를 남긴다(정당한 생성 + 발행만 실패)
5. comment 부착은 `comment !== undefined` 기준 (빈 문자열은 1에서 이미 차단)

## 응답 view 직렬화 (`src/refs.ts`)

- `TodoView` = `Todo` + `ref` + `commentCount`(미보관 수) + `lastCommentAt?` +
  `doingState?`(**부재 = 판정 안 함** — unknown 과 동일 취급)
- `NoteView` = `Note` + `ref`
- `refOf`: 항상 **현재 key** 를 내보낸다(별칭은 입력 전용). `isRefSafeBoardKey` 가
  false 인 보드(`note` 등)는 raw id 폴백

## ref 문법 (`src/store.ts` resolveRef + `src/refs.ts`)

해석 순서: `board-N`(가장 오른쪽 `-` 에서 분할) → 맨숫자 N(현재 보드 컨텍스트 필수 —
todos 는 컨텍스트 없으면 에러, notes 는 전역 번호 공간) → id 정확 일치 → id 유일
prefix. 레거시 입력 `#12`/`board#12` 는 **입력만** 허용. `note-N` 은 예약 — board
인자와 무관하게 항상 전역 메모. 별칭(`board_aliases`)은 `boardIdOf`/`resolveRef`/
`ensureBoard` 전부에서 해석되지만 출력은 항상 새 key.

## CLI (34 서브커맨드, `src/cli.ts`)

얇은 HTTP 클라이언트 + 온디맨드 데몬 기동(`ensureDaemon`). **사람이 읽는 컴팩트 출력
형식이 계약이다** — 실행 스펙은 `cli.test.ts`(888줄) 포팅분. 커맨드 표면:

ls · next · add · show · update · comment · issue · handoff(+--cancel) · spawn ·
sessions · move · start/stop/done/reopen/archive/unarchive · section add/archive/ls ·
note add/ls/show/edit/append/archive · history · board ls/show/add/rename/title/desc/
repo/path · open · daemon run/start/stop/status/install/uninstall · mcp setup ·
tailscale on/off/status

- ref 는 인자 그대로 서버에 전달, cwd 로 유추한 `?board=` 를 단건 라우트에 항상 부착
- actor 우선순위: `--actor` > `ROCKY_TODO_ACTOR` > 자동 감지(`detectActor`)
- 보드 key 유추: git remote > toplevel > cwd (`boardKeyFrom`)

## 훅 3종 (hooks/)

- `ensure-daemon`(SessionStart:startup): health → 없으면 기동. **버전 비교** — health 의
  `version` ≠ 자기 버전이면 SIGTERM → 종료 확인 → 재기동, 못 내리면 그대로 둔다.
  version 미보고(≤0.1.0)는 stale 취급. fail-open
- `notify-todo`(UserPromptSubmit, timeout 5): `/api/changes` 커서 기반 사람 변경 주입
  + 핸드오프 claim(via:'prompt'). 데몬 미기동 시 no-op. fail-open
- `handoff-stop`(Stop, timeout 3): claim(via:'stop') → 있으면 `decision:block` 으로
  즉시 착수. fail-open

Rust 화 시 `rocky-todo hook <name>` 서브커맨드로 흡수하되 위 동작·타임아웃·fail-open
성질을 유지한다.

## 데이터 계층

- SQLite `user_version` 6, 테이블 8: boards / sections / todos / notes / comments /
  history / handoffs / board_aliases
- 히스토리 entity enum: board/section/todo/note. 댓글 mutation 은 부모 todo 의
  히스토리(action: comment/comment-edit/comment-archive/comment-unarchive)
- 번호는 보드 내 `MAX(number)+1`, 아카이브해도 회수 없음. 삭제 없음
- 마이그레이션: 배열 인덱스+1 = user_version, 적용 전 DB 백업, 기존 항목 불변경
