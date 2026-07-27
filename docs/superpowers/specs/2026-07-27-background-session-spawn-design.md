# 보드에서 백그라운드 세션 띄우기 — 설계

보드 항목 `rocky-todo#16`. 2026-07-27.

## 문제

`rocky-todo#11`(PR #15)은 보드의 작업 요청을 **이미 실행 중인 세션**에 배달하는 데까지
왔다. 그래서 세션이 하나도 안 떠 있으면 보드의 "에이전트에게 보내기" 는 보낼 곳이 없다.
사용자가 원하는 건 그때다 — 터미널은 근처에 있지만 워크트리를 열고 `claude` 를 띄우는
수고를 보드 버튼 하나로 대신하고 싶다.

전제 시나리오는 **"데스크에 있지만 세션이 안 떠 있을 때"** 다. 자리를 비운 사이 무인으로
돌리는 것이 아니다. 이 전제가 아래 결정 대부분을 정한다 — 특히 권한 모드를 건드리지
않는 이유가 여기서 나온다.

## 실측 (Claude Code 2.1.220, 2026-07-27)

격리된 임시 레포에서 직접 확인한 것들이다. `rocky-todo#16` 의 초기 메모는 `claude --bg` 와
`--session-id` 조합을 전제했는데, 그 전제가 틀렸다.

| 확인 | 결과 |
|---|---|
| `-w, --worktree <name>` | 워크트리를 `<repo>/.claude/worktrees/<name>` 에 만들고 브랜치 `worktree-<name>` 을 판다. git 에서 `locked` |
| 같은 `--worktree <name>` 재실행 | **기존 워크트리를 그대로 재사용한다** (새로 만들지 않는다) |
| `--bg` + `--session-id` | `warning: --bg manages the session id; ignoring --session-id` — **무시된다** |
| `--bg` stdout | `backgrounded · 5acaaaeb · probe-a` — 이 8자는 full sessionId(`5acaaaeb-1275-…`)의 앞 8자다 |
| `agents --json` | 문서화된 필드 외에 `id`(짧은 id)와 `state`(`working` / `done`)를 준다 |
| `agents --json --cwd <path>` | 그 경로 아래 **background 세션만** 준다 — interactive 는 빠진다 |
| 같은 워크트리에 두 번 spawn | 두 세션이 같은 cwd 에서 동시에 돈다 — git 도 Claude Code 도 막지 않는다 |
| 정리 | `claude rm <id>` 가 워크트리와 job state 를 함께 지운다. git 으로 지우려면 lock 때문에 `worktree remove -f -f` |
| `claude logs <id>` | 터미널 raw 출력(ANSI 이스케이프 덩어리) — 기계 파싱 대상이 아니다 |

## 흐름

```
[드로어 "새 세션 띄우기"] ──POST /api/todos/16/spawn {note}──> [데몬]
                                                                │
  ① isLocalRequest 아니면 403 ──────────────────────────────────┤
  ② boards.path 없으면 400 (UI 는 그 자리에서 경로 입력을 띄운다)  │
  ③ 워크트리 경로 = <boards.path>/.claude/worktrees/todo-<번호>   │
     그 cwd 에 살아있는 세션이 있나?                              │
        있음 → spawn 하지 않고 기존 handoff 큐로 배달하고 끝      │
        없음 → ④                                                 │
  ④ Bun.spawn(cwd: boards.path):                                 │
       claude --bg --worktree todo-<번호> -n <board>-<번호> "<주입문>"
  ⑤ stdout 에서 짧은 id 파싱 → handoffs 레코드(delivered, via:'spawn')
                                                                 ▼
                                          새 세션이 첫 턴에서 그대로 착수
                                          (todo_status start → 보드에 앰버 뱃지)
```

두 번째 요청부터는 **그냥 평범한 세션**이다. `Stop` 훅 claim 경로를 그대로 타므로 stale
표시·취소·큐의 순차 소화가 전부 공짜로 따라온다. spawn 은 "첫 세션을 만들고 첫 건을 직접
배달하는" 특수 경로일 뿐 배달 프로토콜을 새로 만들지 않는다.

## 워크트리 — Claude Code 에 맡긴다

**워크트리 이름을 `todo-<번호>` 로 결정론적으로 정하는 것 하나가 이 설계의 전부다.**

같은 todo 를 다시 보내면 같은 이름이 나오고, Claude Code 가 기존 워크트리를 재사용한다.
"todo 가 자기 워크트리를 기억한다" 를 위해 컬럼도 테이블도 필요 없다 — 이름이 곧 기억이다.

그래서 데몬은 git 을 전혀 만지지 않는다. 워크트리 루트 설정도, base ref 설정도, 생성 실패
롤백도 없다. 경로 규약(`.claude/worktrees/`)과 브랜치 이름(`worktree-<name>`)과 정리
(`claude rm`)가 전부 Claude Code 몫이다.

세션 이름은 `-n <board>-<번호>` 로 준다 — `claude agents` 목록과 보드에서 같은 이름으로
읽힌다.

### 동시 실행 가드

실측에서 같은 워크트리에 세션 두 개가 동시에 붙는 것을 확인했다. 두 에이전트가 한
워크트리의 파일을 같이 고치면 그대로 사고다. 그래서 spawn 전에 반드시 확인한다:

> `agents --json` **전체 목록**에서 `cwd` 가 그 워크트리 경로와 정확히 일치하고
> `state !== 'done'` 인 세션이 있으면, spawn 하지 않고 그 세션 앞으로 handoff 를 큐잉한다.

`--cwd` 필터를 쓰지 않는다 — 그건 background 세션만 준다. 사용자가 그 워크트리를 터미널에서
열어 interactive 로 작업 중인 경우를 놓치면 가드의 의미가 없다.

이 가드가 곧 "세션 재사용" 이다. 안전장치와 편의가 같은 규칙이다.

재사용으로 갈릴 때 만드는 handoff 는 **평범한 `pending` 레코드**다 — 목록에서 찾은 그 세션의
full `sessionId` 로 큐잉하고, 그 세션의 다음 `Stop` 훅이 집어간다. `via='spawn'` 레코드는
새 프로세스를 실제로 띄웠을 때만 만든다.

## 권한 모드 — 건드리지 않는다

`--permission-mode` 를 넘기지 않는다. 사용자 settings 의 `permissions.defaultMode` 를 그대로
따른다.

보드에서 모드를 고르게 하려던 안을 버린 이유: 전제 시나리오가 "데스크에 있다" 이므로 세션이
승인에서 멈춰도 `claude agents` 로 붙어서 승인하면 된다. 반대로 보드에 모드 선택을 놓으면
`bypassPermissions` 를 폰에서 무심코 고를 수 있는 자리가 생긴다. 얻는 것보다 잃는 게 크다.

## 로컬 요청 전용

GitHub 이슈 생성과 **같은 등급의 게이트**를 건다 — `src/local-request.ts` 의
`isLocalRequest` 를 재사용해 아니면 403.

보드 쓰기 권한이 "이 머신에서 파일을 고치는 프로세스를 띄우는 권한" 으로 확대되는
지점이라, `todo.expose` 설정과 무관하게 막는다. `tailscale serve` 가 원격 요청을 루프백으로
프록시하므로 peer 주소만으로는 부족하다는 것도 이슈 생성과 같다(프록시 헤더를 함께 본다).

`/api/health` 에 `spawnAllowed` 를 실어 UI 가 버튼 대신 이유를 보여주게 하되, **강제는 서버가
한다** — health 값은 힌트일 뿐이다.

## 데이터 모델 — 마이그레이션 `user_version` 4

```sql
ALTER TABLE boards ADD COLUMN path TEXT;   -- 메인 레포 절대경로. 없으면 spawn 불가
```

`boards.repo`(user_version 2)와 같은 패턴이므로 마이그레이션에 `PRAGMA table_info` 가드가
붙고, 신규 DB 는 `SCHEMA` 로 이 컬럼을 갖고 태어난다.

`handoffs` 는 스키마를 바꾸지 않는다. `delivered_via` 에 `'spawn'` 값이 추가될 뿐이다:

| 컬럼 | spawn 레코드에 들어가는 값 |
|---|---|
| `session_id` | stdout 에서 파싱한 **짧은 id**(8자). full sessionId 의 접두사라 필요하면 prefix 로 풀 수 있고, 무엇보다 사용자가 `claude attach/logs/stop/rm` 에 그대로 넣는 값이다 |
| `session_cwd` | 워크트리 경로 |
| `session_name` | `<board>-<번호>` |
| `status` / `delivered_via` | `delivered` / `spawn` — 생성 시점에 이미 배달된 것이다 |

레코드는 **spawn 이 성공한 뒤에** 만든다. 실패한 spawn 이 배달 기록을 남기면 안 된다.

히스토리는 `entity: 'todo'`, action `handoff-spawn` 으로 남기고, 기존 handoff 계열과 같이
`/api/changes` 피드에서는 제외한다 — 다른 세션의 프롬프트 주입에 노이즈로 실리지 않게.

## 주입문

`src/handoff.ts` 의 `buildHandoffPrompt` 를 그대로 쓴다. spawn 경로는 claim 을 거치지 않으므로
같은 모양의 값을 만들어 넘긴다(`remaining: 0`).

todo 본문은 싣지 않는다 — 세션이 `todo_list` 로 직접 읽으면 댓글·히스토리까지 최신으로 본다.

## 표면

### REST

| | |
|---|---|
| `POST /api/todos/:ref/spawn` | `{note?}` → 201 `{handoff, sessionShortId, worktreePath, reused}`. **로컬 요청 전용(403)** |
| `PATCH /api/boards/:key` | 기존 repo 설정 엔드포인트에 `path` 필드를 더한다 |
| `GET /api/health` | `spawnAllowed` 추가 |

`reused` 는 "살아있는 세션이 있어 spawn 대신 큐잉했다" 를 알린다 — UI 가 다른 문구를 보여준다.

### 웹 UI

드로어 액션 줄에 **"새 세션 띄우기"** ("GitHub 이슈 만들기" 옆). `boards.path` 가 없으면 그
자리에 경로 입력 칸을 띄운다. **실패해도 패널과 입력은 열린 채 남긴다** — repo 입력이
one-shot 이라 브라우저만 쓰는 사용자가 막다른 길에 몰렸던 실수를 반복하지 않는다.

띄운 뒤에는 워크트리 경로와 짧은 id 를 보여준다. 사용자가 `claude attach 5acaaaeb` 를 그대로
복사해 붙을 수 있어야 한다 — 승인 프롬프트에서 멈췄을 때 그게 유일한 진입점이다.

`spawnAllowed` 가 false 거나 `claude` 를 못 쓰면 버튼 대신 이유를 보여준다.

### CLI

```
rocky-todo board path <절대경로>          # 기존 board repo 와 대칭
rocky-todo spawn REF [--message "…"]
```

### MCP — 도구를 추가하지 않는다 (5개 유지)

`rocky-todo#11` 에서 닫아둔 이유가 여기서 더 강해진다. 그건 에이전트가 에이전트에게 일을
미루는 경로였고, 이건 에이전트가 에이전트를 **띄우는** 경로다. 사람이 보드에서 누르는
버튼으로 남긴다.

## 에러 처리

| 상황 | 응답 |
|---|---|
| 비로컬 요청 | 403 |
| `boards.path` 미설정 / 경로 없음 / git 워크트리 아님(`.git` 부재) | 400 + 무엇을 설정해야 하는지 |
| `claude` 없음·실패 | 400 (`SessionsResult.reason` 을 그대로) |
| `claude --bg` 가 0 아닌 코드로 종료 | 400 + stderr. 워크트리는 Claude Code 소유라 데몬이 되돌릴 것이 없다 |
| 이미 pending handoff 있음 | 409 (기존 규칙 그대로 — 같은 일이 두 곳으로 가는 것을 막는다) |
| 아카이브된 todo | 400 |

## 이 설계가 막지 못하는 것

- **승인 프롬프트에서 멈춘 세션을 보드는 모른다.** `agents --json` 의 `state` 는 그때도
  `working` 이다. 사용자가 `claude attach <id>` 로 붙어야 안다 — 그래서 드로어에 짧은 id 를
  띄우는 것이 장식이 아니다.
- **워크트리 정리는 사람 몫이다.** 커밋 안 된 작업물이 있을 수 있고, 이 기능에서 가장 나쁜
  실패는 조용한 유실이다. 자동 삭제를 넣지 않는다.
- **결과 회수는 강제되지 않는다.** 세션이 `todo_write` 로 댓글을 남기는 기존 관례에 기댄다.
  `claude logs` 는 ANSI raw 라 기계적으로 회수할 수 없다.
- **동시 실행 가드는 `agents --json` 이 보는 범위까지만 유효하다.** 그 목록에 안 잡히는
  프로세스(예: 다른 도구로 연 편집기)가 같은 워크트리를 만지는 것은 감지하지 못한다.

## 범위 밖

- 무인 실행을 위한 권한 모드 자동화.
- 세션 → 세션 재위임.
- 배달 결과를 보드로 자동 회수.
- 워크트리 자동 정리 / GC.

## 검증

| 파일 | 검증 |
|---|---|
| `src/spawn.test.ts` (신규) | 명령줄 조립 · `backgrounded · <id> · <name>` 파싱(형식이 어긋난 출력 포함) · 동시 실행 가드 판정 — 전부 `RunCommand` DI 로 순수하게 |
| `src/sessions.test.ts` | `id` / `state` 필드 파싱, 누락 시 기본값, 기존 계약 회귀 |
| `src/store.test.ts` | `via='spawn'` 레코드 · 히스토리 `handoff-spawn` · `/api/changes` 제외 |
| `src/server.test.ts` | 201 · 400 · 403 · 409 계약, `reused` 분기 |
| `src/migrations.test.ts` | `user_version` 4 (`boards.path`) — 기존 DB · 신규 DB 양쪽 |
| `src/cli.test.ts` | `board path` · `spawn` |

게이트는 `bun run check` · `bun run typecheck` · `bun test`. **`claude` CLI 가 없는 머신에서도
전부 통과해야 한다.**

문서는 `FEATURES.md` · `AGENTS.md` · `README.md` · `docs/rocky-todo.md` 동기화 +
`bunx changeset`.
