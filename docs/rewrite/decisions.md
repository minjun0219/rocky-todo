# 포팅 결정 기록

TS→Rust 매핑에서 갈린 결정과 이유. 발견 시점에 짧게 누적한다 — 회고가 아니다.
계약 자체는 [contract.md](./contract.md), Rust 학습은 [rust-notes.md](./rust-notes.md).

## Phase 0

- **워크스페이스 3크레이트**(core / rocky-todod lib+bin / cli) — rocky-todod 가 lib 인
  이유는 Tauri 앱(app/)이 같은 프로세스에 마운트하기 위해서. 단독 bin 은 헤드리스/개발용.
- **버전 `0.15.0-dev`** — 재작성 결과물이 v0.14.0(TS) 다음 유저 표면 변경이라는 선언.
  릴리스 시점에 changeset 규약과 어떻게 접붙일지는 Phase 5 에서 정한다.
- **rusqlite bundled** — 시스템 SQLite 버전 편차를 없앤다. `bun:sqlite` 와 동작 차이가
  의심되는 지점이 나오면 여기 기록할 것.
- **CI rust 잡은 macos-latest** — 타깃 플랫폼이 macOS(Tauri)라 러너를 일치시켰다.
  기존 bun 잡(ubuntu)은 그대로 병행 — TS 표면이 살아 있는 동안 두 게이트 모두 유효하다.

## Phase 1 — 데이터 계층

- **에러 모델**: `StoreError(String)` 하나 — TS 의 `throw new Error(message)` 대응.
  메시지가 곧 계약(서버가 `/not found/i` 로 404 판정)이라 enum 대신 문자열을 유지했다.
- **스레딩**: `Mutex<Connection>` 하나로 전 호출 직렬화. 단일 사용자 로컬 데몬이라
  동시성 이득보다 단순성이 크고, TS(단일 스레드)와 실행 모델이 같아진다. 이벤트 발행은
  락 해제 후(`emit_all`) — 리스너 재진입 데드락 방지.
- **재진입 함정**: public 메서드가 다른 public 메서드를 부르면 같은 Mutex 를 두 번 잡아
  데드락 — `ensure_board_conn` 등 `*_conn` 헬퍼(락 안)와 public 입구(락 밖)를 분리했다.
- **resolveRef 는 행이 아니라 id 를 돌려준다** — TS 는 행 전체를 반환하지만 Rust 는
  타입별 제네릭이 복잡해져, id 해석 → id 재조회 2단으로 바꿨다(정확 일치 재조회라 의미
  동일, 추가 쿼리 비용은 무시 수준).
- **정규식 없이 손 파싱**: 레거시 `^([^#\s]+)#(\d+)$` = 첫 `#` 분할, 신규
  `^(\S+)-(\d+)$` = **가장 오른쪽** `-` 분할(rfind), 맨숫자 `^(#)?(\d+)$`. regex 크레이트
  의존을 아꼈다 — 대신 세 분기의 경계 테스트(대문자/`_` 시작 key, 8자리 숫자, `#` 길이
  게이트)를 전부 포팅해 고정했다.
- **직렬화**: serde camelCase + `skip_serializing_if(None)` — TS 의 undefined 필드
  생략과 일치(`previousKeys` 부재 == 별칭 없음). `TodoView` 는 `#[serde(flatten)]`.
- **undefined/null 이중성**: TS patch 의 `undefined`(안 고침)/`null`(지움)은
  `Option<Option<T>>` 로 옮겼다 (`BoardPatch`/`UpdateTodoPatch`).
- **updateTodo 변경 감지**: TS 의 `JSON.stringify(a)===JSON.stringify(b)` 를
  `serde_json::Value` 동등성으로 대체 — old-absent vs new-null 이 같게 접히는 동작 포함
  동일 결과.
- **마이그레이션 주입 타입**: 테스트가 클로저를 넣어야 해서 `MigrationRef<'a> =
  &'a dyn Fn(...)` 을 도입, 실 배열은 `MigrationFn`(fn 포인터) 유지.
- **원자성 스파이 테스트 대체**: TS 는 `db.run` 을 감싸 "PRAGMA user_version 이 COMMIT
  이전" 순서를 관찰했지만 Rust 러너는 내부 호출을 가로챌 수 없다 — 순서는 코드 구조로
  고정하고 테스트는 최종 상태 원자성만 검증한다(`migrations_test.rs` 주석 참고).

### Phase 1 게이트 결과 (실 DB 복사본, 2026-08-31)

`cargo run --example verify_real_db` — boards 11 / todos 129 / notes 2 / comments 98 /
history 563 / handoffs 7 / sections 20 모두 bun 기준과 일치. `rocky-todo-23` 참조 왕복,
변경 피드 555건(= 563 − handoff 계열 8) 파싱 무오류. user_version 6 재개방 무해(no-op).

## Phase 1 — 순수 판정 모듈

- **sessions 는 파싱만 코어에**: `listSessions` 의 프로세스 실행(RunCommand)과 TTL 캐시는
  데몬(Phase 2) 몫으로 미루고, `parse_sessions`/`match_board` 만 코어에 뒀다 — TS 테스트의
  실행 실패·캐시 케이스는 데몬 포팅 때 함께 옮긴다.
- **local_request 는 프레임워크 비종속**: `Request` 대신 헤더 조회 클로저를 받는다
  (`is_local_request(peer, has_header)` / `is_cross_site_request(get_header, req_url)`).
  axum 통합부가 자기 HeaderMap 을 접어 넣는다. URL hostname 파싱은 손으로 — TS
  `URL.hostname` 계약(IPv6 대괄호 유지, 포트 제거) 재현.
- **next 의 날짜**: TS 의 "Date.UTC 가 굴리는 달력 밖 날짜" 방어를
  `chrono::NaiveDate::from_ymd_opt`(달력 검증 내장)로 대체 — 되돌려 대조가 필요 없다.
  `today_number` 는 Local 타임존(마감은 사람이 사는 날짜).
- **statusline placeholder 는 손 파싱** — `{[a-z][a-z.]*}` 하나라 정규식 의존을 아꼈다.

### Phase 1 완료 (2026-08-31)

Rust 테스트 284개 전부 통과 (store 133 · migrations 18 · refs 8 · doing 22 · next 31 ·
statusline 23 · sessions 11 · local_request 17 · handoff 7 · actor 6 · unit 8).
fmt/clippy(-D warnings) 클린. 실 DB 게이트 통과(행수 전항목 일치 + ref 왕복).

## 확장 경로 제약 — 동기화는 머신별 opt-in (사용자 결정, 2026-08-31)

- 클라우드(D1) 동기화는 **설정으로 켜는 opt-in** 이다 — 개인 머신은 동기화 구성, 회사
  머신은 로컬 전용. 기본값은 항상 로컬 전용.
- 따라서 데몬 코어는 동기화 존재를 모른 채 동작해야 하고(하드 의존 금지), 동기화가
  꺼진 머신의 보드 데이터는 어떤 경로로도 기계를 떠나지 않아야 한다.
- 설정 표면은 `rocky.json` `todo` 블록의 하위 키(예: `todo.sync`)로 예약 — 지금은
  구현하지 않고 이름만 선점하지 않도록 비워 둔다.

## Phase 2 — rmcp 스파이크 결과 (2026-08-31)

- **stateless 운용 가능 확정** (rmcp 3.1.4): `StreamableHttpServerConfig` 의
  `legacy_session_mode: false` + `json_response: true` 가 TS 의
  `sessionIdGenerator: undefined` + `enableJsonResponse: true` 에 정확히 대응.
  세션 매니저는 `NeverSessionManager`.
- **`allowed_hosts` 는 비운다**(`disable_allowed_hosts`): rmcp 기본값은 루프백 Host 만
  허용(DNS rebinding 방어)인데, 이 데몬은 tailscale serve 경유 요청의 Host 가
  `*.ts.net` 이라 기본값이면 정상 요청이 막힌다. TS 데몬은 Host 검증이 없었고,
  브라우저發 공격은 우리 `is_cross_site_request` 가드(라우팅 전)가 같은 위치에서 막는다
  — rmcp 의 Origin 검증도 쓰지 않는다(우리 가드가 정본, 이중화하면 tailscale serve
  경로에서 어긋난다).
- **도구 스키마는 schemars 산출** — draft 2020-12 형태라 zod 산출과 구조가 다를 수
  있으나, 계약은 도구 이름·인자 이름·description 문구다. description 은 TS 원문
  그대로 옮긴다(에이전트 행동을 유도하는 문장들).

## Phase 2 — 데몬 구현 (2026-08-31, 스모크 통과)

- **단일 fetch 핸들러 유지**: axum 라우터로 흩지 않고 TS 처럼 수동 매칭 하나로 뒀다
  (`server.rs::dispatch`) — 라우팅 순서·404 본문(`not found: METHOD path`)·경로 디코딩까지
  계약이라 프레임워크에 맡기면 동일성 검증이 어렵다. axum 은 바인딩/추출만 한다.
- **MCP 는 allow 값이 다른 서비스 두 벌**: TS 는 요청마다 서버를 새로 만들어
  `allowIssueCreate` 를 접었다 — rmcp 의 service_factory 는 요청을 못 보므로,
  local/remote 두 `StreamableHttpService` 를 만들어 `isLocalRequest` 판정으로 고른다.
- **도구 에러는 isError 결과로**: TS SDK 는 throw 를 `{isError:true, content:[메시지]}` 로
  접는다 — Rust 도 `CallToolResult::error` 로 동일하게(프로토콜 에러가 아니라 도구 결과).
- **SSE 는 broadcast 채널**: 스토어의 sync 리스너가 `broadcast::Sender` 로 밀고(발신은
  sync 라 가능) 각 SSE 연결이 구독한다. lagged 유실은 무해 — 구독자는 refetch 만 한다.
- **외부 명령은 전부 tokio 비동기** — TS 의 `Bun.spawnSync`(데몬 전체 블로킹)보다 개선.
  `claude --bg` 만 전용 `run_in_dir`(자식 종료 + 250ms 유예 / 마감에서 파이프를 끊는다
  — detach 손자가 fd 를 물어도 안 매달린다).
- **UI 번들**: `scripts/build-ui.ts` (`Bun.build` + bun-plugin-tailwind, minify) → `dist/`
  3파일(html/js/css, js 1MB). Rust 는 `ServeDir` + index.html fallback(퍼머링크).
  bun 은 이제 **UI 빌드 시에만** 필요하다.

### 스모크 결과 (Rust 데몬 :8997, 실 `claude` CLI 연동)

REST 왕복(생성→ref 조회→404 본문→cross-site 403) · MCP(initialize, tools/list 5개,
todo_list/todo_status 왕복) · SSE(`: connected` + change 이벤트, TS 와 동일 형식) ·
웹 UI(`/` 번들 서빙 + 퍼머링크 fallback 200) · statusline(실 세션 대조로 방치 1 판정,
user rocky.json 템플릿 반영) — 전부 통과.

### Phase 2 완료 (2026-08-31)

테스트 552개 전부 통과 (core 284 + 데몬 268: server REST 50 · issue/보드메타 23 ·
handoff 29 · spawn 27 · statusline 12 · mcp 37 · github 31 · spawnctl 24 · tailscale 14 ·
config 21). fmt/clippy(-D warnings) 클린.

- **포팅 테스트가 실 배선 버그를 잡았다**: 주입된 sessions 가 spawn/statusline 조회기로
  폴백되지 않던 문제(TS `resolveSpawnSessions` 계약 누락) — spawn 라우트가 실제
  `claude` 를 부르고 있었다. 테스트 실패 4건이 전부 이 한 원인이었다.
- **MCP 테스트는 실제 HTTP JSON-RPC 표면**으로 검증 — InMemoryTransport 대신 rmcp
  stateless 통합까지 함께 커버한다. cross-site 403, allowIssueCreate 이중 서비스 선택
  (peer 주소별)도 실 라우팅으로 확인.
- **run_in_dir 는 실제 프로세스 테스트**: detach 손자가 stdout 을 물어도 안 매달리는
  것(`sleep 30 &`), 마감 초과 시 timedOut + 부분 출력 보존까지 실측.
- 게이트 잔여: 웹 UI 브라우저 렌더 확인은 Playwright Chrome 기동이 이 환경에서 실패해
  자산 무결성(css/js 200 + JS 번들 문법 검사 + API/SSE 왕복)으로 대체 — 실 브라우저
  확인은 사용자가 `ROCKY_TODO_UI_DIST=$PWD/dist target/debug/rocky-todod` 로 띄워
  한 번 열어보는 것으로 마무리한다.

TS 테스트 중 데몬 쪽 잔여: `sessions.test.ts` 의 TTL 캐시 2건(시간 의존)과
`notify.test.ts`/`client.test.ts`/훅 테스트는 Phase 3(CLI+훅)에서 함께 포팅한다.

## 브랜치 전략 — 통합 브랜치 + main 동결 (사용자 결정, 2026-08-31)

재작성은 `rust-rewrite` 통합 브랜치 위에서만 진행하고, **main 은 동결한다**.
phase 마다 `rust/phase-N` 브랜치를 따서 `rust-rewrite` 로 PR·스쿼시 머지하고,
전체가 끝나면 `rust-rewrite` 를 main 에 올린다.

- **phase 브랜치를 겹쳐 쌓지 않는다.** 스쿼시 머지는 커밋 SHA 계보를 끊으므로,
  phase N+1 을 phase N 브랜치 **위에** 두면 N 이 스쿼시된 순간 N+1 PR 이 N 의 변경을
  다시 새 것으로 들고 온다(diff 오염 + 그 줄마다 충돌). 피하려면 매번
  `rebase --onto <통합브랜치> <N의-옛-tip>` 로 버릴 구간을 손으로 지정해야 한다.
  그런데 phase 는 본래 순차라(3은 2가 끝나야 시작) 스택이 필요 없다 — N 을 머지한
  **뒤** 갱신된 `rust-rewrite` 에서 N+1 을 딴다. 그러면 이 문제가 아예 안 생긴다.
- **통합 브랜치를 두는 이유는 철회 가능성이다.** phase 별로 main 에 넣으면 재작성이
  중간에 멎었을 때 마켓플레이스가 서빙하는 레포에 죽은 Rust 가 남아 누가 걷어내야
  한다. 브랜치면 버리는 비용이 0이다.
- **동결 예외는 핫픽스 하나** — 쉬핑 중인 TS 데몬에 버그가 나면 main 에 고치고
  `rust-rewrite` 를 그 위로 한 번 리베이스한다.
- 동결 부작용: `target/` 무시가 Rust 커밋에 들어 있어 main 계열 브랜치에서
  `bun run check` 를 돌리면 cargo 산출물을 훑고 실패한다. main 에서 개발하지
  않으므로 실害는 없지만 브랜치를 오갈 때 놀라지 말 것.

## Rust 데몬을 기본 포트에 띄우면 TS 훅이 죽인다 (2026-08-31)

개발 중 Rust 데몬을 **기본 포트(8636)에 그대로 띄우면 안 된다.** `hooks/ensure-daemon.ts`
는 SessionStart 마다 `/api/health` 의 `version` 을 자기 `package.json` 버전과
**정확히 문자열 비교**하고(`running.version === deps.version`), 다르면 stale 로 보고
SIGTERM → 현재 설치본으로 재기동한다. Rust 데몬은 `0.15.0-dev`, TS 설치본은 `0.14.0`
이라 **항상 불일치**다 — 새 세션을 열 때마다 Rust 데몬이 내려가고 TS 데몬이 그 자리를
차지한다. launchd 상주 중이면 더 나쁘다: `replaceManaged()` 가 job 을 TS 설치 경로로
교체해버린다.

이건 버그가 아니라 "버전 인식 재기동"이 설계대로 도는 것이다 — 재작성이 끝나 두
데몬의 버전 체계가 합쳐질 때(Phase 5) 자연히 풀린다. 그때까지 개발용 Rust 데몬은
전용 포트로 띄운다:

```bash
ROCKY_CONFIG=./demo.rocky.json ROCKY_TODO_UI_DIST=$PWD/dist target/debug/rocky-todod
```

`ROCKY_CONFIG` 를 거는 게 핵심이다 — 포트만 env 로 갈라놔도 `expose` 는 전역 설정에서
딸려와 데모가 노출을 물려받는다(AGENTS.md 의 사고 기록).

### 이 경로로 확인한 것 (2026-08-31)

`publicPath` 회귀를 실물로 잡았다. 퍼머링크 `/rocky/12` 는 SPA fallback 으로
index.html 을 돌려주는데, 번들 기본값인 상대 경로(`./chunk-*.js`)면 브라우저가
`/rocky/chunk-*.js` 를 찾고 그 요청도 fallback 에 걸려 **JS 자리에 HTML 이
200 으로** 온다(실측: `content-type: text/html`). 앱이 조용히 안 뜬다.
`publicPath: '/'` 로 루트 절대 경로를 내보내 해결했고, 같은 데몬에서 REST 왕복 ·
SSE(`: connected`) · cross-site 403(REST/`/mcp` 양쪽) · 프록시 헤더가 붙으면
`issueCreateAllowed: false` 까지 함께 확인했다.

## 프리릴리즈 — Phase 4 이후에 붙인다 (사용자 결정, 2026-09-01)

Tauri 앱이 실제로 뜨는 시점(Phase 4)부터 `rust-rewrite` 에서 프리릴리즈를 낸다.
지금 걸면 올릴 바이너리가 없어 파이프라인만 늘어난다.

현재 파이프라인으로는 `rust-rewrite` 에서 아무것도 안 나온다 — 붙일 것 셋:

- **트리거**: `release.yml` 이 `push: branches: [main]` 이고 changesets 도
  `baseBranch: main` 이라 통합 브랜치는 아예 안 탄다.
- **버전**: changesets 의 pre 모드(`changeset pre enter next`)를 쓴다 —
  `0.15.0-next.0` 으로 찍히고 나갈 때 `pre exit` 로 정식 번호가 된다. 이게
  Cargo(`0.15.0-dev`) ↔ package.json(`0.14.0`) 이원화를 푸는 Phase 5 와 같은
  자리라 함께 정한다.
- **산출물**: `scripts/release-github.ts` 는 `v<version>` 릴리스를 만들지만
  `--prerelease` 를 안 붙이고, Tauri 바이너리를 올리는 job 자체가 없다. macOS
  러너에서 빌드하고, 자기 머신 밖으로 배포할 거면 서명/노터라이즈가 필요하다.

## Phase 3 — CLI + 훅 (2026-09-01)

`rocky-todo-cli` 가 lib+bin 이 됐고 41개 서브커맨드 전부와 훅 3종(`hook
ensure-daemon|notify-todo|handoff-stop`)이 넘어왔다. hooks.json 이 bun 스크립트
대신 이 바이너리를 부르게 되는 건 컷오버(Phase 5) 몫 — 그때까지 TS 훅이 계속 돈다.

- **clap 을 쓰지 않았다.** TS 의 손파서 동작(불리언/값/리스트 플래그, 모르는 플래그
  에러)이 곧 사용자 표면이다. clap 은 `--name=value`·단축 플래그·`--` 를 자동으로
  받아들여 계약이 조용히 넓어진다. Phase 2 때 main.rs 스텁 주석에 "clap 34
  서브커맨드"라 적었던 건 이 결정으로 뒤집혔다.
- **parity 게이트** (`bun run check:cli-parity`, CI 스텝): 데모 데몬 하나에 두 CLI
  를 붙여 stdout 을 바이트 비교한다. 41개 케이스(텍스트·JSON·에러 경로). 자기
  테스트만 통과하고 원본과 갈라지는 포팅을 막는 장치 — TS 표면이 사라지면 지운다.
  이걸 위해 serde_json 에 `preserve_order` 를 켰다(Value 키 정렬 → 순서 유지).
- **코어로 옮긴 것**: `config`(CLI 가 데몬 크레이트를 의존하면 tokio·axum 이 딸려
  온다), `github` 의 순수 slug/remote 파싱, `notify`(훅 순수 로직).
- **`encode_uri_component` 자작** — percent-encoding 크레이트들은 보존 집합이
  조금씩 달라(`!'()`) ref 문자열이 TS 시절과 갈릴 수 있다. TS 오라클 출력을
  테스트에 박았다.
- 새 직접 의존은 `libc` 하나(SIGTERM/getuid) — 이미 tokio 가 끌어오던 크레이트라
  빌드에 더해지는 코드가 없다.
- TS 잔여 테스트(notify/client/ensure-daemon)까지 전부 포팅 — Rust 639 통과.

launchd plist 는 ProgramArguments 가 `rocky-todod` 바이너리 하나가 됐고
WorkingDirectory 고정이 빠졌다(bunfig.toml 제약 소멸). **기존 TS 로 install 한
plist 는 컷오버 때 `daemon install` 재실행으로 교체해야 한다** — Phase 5 체크리스트.

## Phase 4 — Tauri 앱 (2026-09-02)

`app/` 이 워크스페이스에 합류했다. 구조는 **"데몬 위의 창"** — 앱은 얇은 셸이고
보드의 실체는 계속 데몬이다.

- **살아 있는 데몬이 있으면 그 URL 로 창을 연다.** 전역 단일 인스턴스(포트 락)를
  존중한다 — 앱이 데몬을 갈아치우지 않는다. 버전 인식 교체는 SessionStart 훅 몫이고
  여기서 겹치면 앱을 열 때마다 상주 데몬이 죽는다. 실측: 헤드리스 데몬을 먼저 띄우고
  앱을 열면 pid 가 유지되고, 앱을 닫아도 데몬이 산다.
- **없을 때만 in-process 마운트** — `rocky-todod` 가 lib 인 이유. 실측: 앱 프로세스가
  health/UI/REST 를 직접 서빙하고 앱 종료와 함께 내려간다(다음 CLI/훅이 headless 를
  다시 띄운다).
- **창은 데몬 URL 을 직접 로드한다** (`WebviewUrl::External`) — 기존 웹 UI + SSE 를
  그대로 얻고 자산 임베드 경로를 안 만든다. tauri 의 `frontendDist` 는 CI 가 bun 빌드
  없이 cargo build 를 통과하도록 레포에 둔 자리 표시자 한 장이다.
- in-process 의 ui_dist 는 env `ROCKY_TODO_UI_DIST` > 앱 리소스 `dist/`(프리릴리즈에서
  채운다) > 없음(API 만). 아이콘도 단색 자리 표시자 — 진짜 아이콘·서명·번들은
  프리릴리즈 몫이다.
- 개발 실행: `ROCKY_CONFIG=... ROCKY_TODO_UI_DIST=$PWD/dist cargo run -p rocky-todo-app`.
  기본 포트로 열면 설치본 데몬을 재사용하므로 안전하다(위 첫 항목).
- **`ROCKY_TODO_UI_DIST` 는 컷오버 전까지 개발 전용이다** — 쉬핑 중인 TS 표면에는
  없는 변수라 `docs/rocky-todo.md` 의 env 표에 지금 넣으면 거짓 문서가 된다.
  컷오버(Phase 5)에서 표면이 바뀔 때 env 표와 함께 반영한다(체크리스트 5번).
- **백엔드 확보 실패는 GUI 앞에서 끝낸다** — setup 안에서 Err 를 내면 tauri 내부를
  거치며 abort 트레이스로 죽는다(실측). main 에서 확보하고, 실패하면 osascript
  다이얼로그 + 정상 종료(Dock 실행의 stderr 는 아무도 못 본다). 무관한 서비스가
  포트를 점유한 경우 health 의 신원 검증이 걸러 "확보 실패"로 떨어진다 — 그 서비스를
  창에 로드하는 사고가 없다. macOS 의 Dock 재열기(RunEvent::Reopen)도 처리한다 —
  안 하면 마지막 창을 닫은 뒤 창 없는 유령 프로세스가 된다.

## Phase 5a — 프리릴리즈 파이프라인 (2026-09-03)

Phase 5 는 둘로 쪼갰다: **5a** 는 `rust-rewrite` 에서 바이너리·앱 번들이 릴리스로 나오게
하는 것, **5b** 는 컷오버(플러그인 훅 → 네이티브 바이너리, TS 표면 제거, 문서). 5b 는 내려받을
바이너리가 있어야 성립하므로 5a 가 먼저다.

- **버전은 package.json 하나가 진실**이고 changesets pre 모드(`.changeset/pre.json`,
  태그 `next`)로 `0.15.0-next.N` 을 찍는다. `sync-plugin-version.ts` 가 plugin.json 에 더해
  `Cargo.toml`(workspace.package) 과 `Cargo.lock`(멤버 4개 항목)까지 텍스트 치환한다 —
  version job 은 ubuntu 라 cargo 가 없고, lock 을 안 고치면 `--locked` 릴리스 빌드가 죽는다.
  이로써 `0.15.0-dev` ↔ `0.14.0` 이원화가 풀렸다: Rust 데몬도 `0.14.0` 을 보고하므로 "TS 훅이
  Rust 데몬을 죽인다" 함정이 기본 포트에서 사라진다(같은 버전 = 갈아치우지 않음).
- **release.yml 이 `rust-rewrite` 도 탄다.** Version PR → 머지 → `release-github.ts` 가
  `-` 가 붙은 버전이면 `--prerelease` 로 릴리스를 만들고 `GITHUB_OUTPUT` 으로 `created`/`tag`
  를 넘긴다 → `assets` job(macos-latest)이 `bun run build:app`(UI 번들 → tauri build) +
  `cargo build --release --locked` 로 `.app.zip`(ditto, 서명 보존) 과 `.tar.gz`(CLI+데몬),
  `SHA256SUMS` 를 첨부한다. 릴리스가 새로 생긴 push 에서만 돈다.
- **서명은 ad-hoc(`APPLE_SIGNING_IDENTITY=-`)**, 노터라이즈 없음 — Apple Developer 계정이
  없다. 내려받은 앱은 `xattr -dr com.apple.quarantine` 로 연다(docs 에 적음). 정식 서명은
  계정이 생기면 env 세 개만 더 얹으면 된다(tauri 가 알아서 노터라이즈한다).
- **웹 UI 는 앱 리소스 `Contents/Resources/dist/` 로 실린다** — 단 `bundle.resources` 는
  기본 `tauri.conf.json` 이 아니라 `app/tauri.release.conf.json`(`tauri build --config`)에만
  있다. tauri-build 가 build.rs 에서 리소스 경로 존재를 검사하므로 기본 설정에 두면
  `dist/` 없는 `cargo clippy/build`(CI 의 rust 잡)가 죽는다(실제로 죽었다). 실측: 번들 바이너리를 `ROCKY_TODO_UI_DIST` 없이 띄우면 `/` 가 실제 index.html, 청크가
  `text/javascript` 로 온다. `build-ui.ts` 는 이제 `dist/` 를 비우고 시작한다 — 청크 이름이
  내용 해시라 옛 청크가 남아 리소스에 딸려 들어갔다.
- 아이콘은 여전히 자리 표시자(앰버 둥근 사각 + 체크)지만 `tauri icon` 으로 icns 까지 만들어
  번들 요건을 채웠다. `source.png`(1024) 를 레포에 두어 진짜 아이콘으로 바꿀 때 같은 명령
  한 번이면 된다. `app/gen/schemas/` 는 tauri 가 빌드마다 재생성하는 파일이라 추적을 끊었다
  (#72 에 8천 줄이 섞여 들어갔었다).
- `@tauri-apps/cli` 는 devDep — `cargo install tauri-cli` 는 러너에서 수 분이 걸리고,
  npm 판은 프리빌트라 즉시 뜬다. tauri CLI 가 `app/Cargo.toml` 의 의존 표기를
  `{ version = "2", features = [] }` 로 정규화하는데, 매 빌드 다시 하므로 그 형태로 둔다.
