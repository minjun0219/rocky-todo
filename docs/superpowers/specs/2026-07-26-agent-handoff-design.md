# 에이전트 작업 요청 핸드오프 — 설계

보드 항목 `rocky-todo#11`. 2026-07-26.

## 문제

보드에서 todo 를 보다가 "이걸 지금 시켜야겠다" 싶으면, 터미널로 옮겨가 세션을 찾고 참조를
타이핑해야 한다. 보드가 이미 그 항목의 제목·설명·댓글을 다 들고 있는데도 사람이 다시 옮긴다.

## 전제: 데몬은 세션에 밀 수 없다

Claude Code 2.1.220 의 훅은 전부 **세션 안에서 일어난 일에 반응**한다. 외부에서 유휴 세션을
깨우는 훅은 없다 — `Notification(idle_prompt)` 이 유휴를 알려주긴 하지만 블록도 컨텍스트
주입도 못 한다. 그래서 배달 경로는 셋뿐이다.

| | 경로 | 언제 도착 | 유휴 세션 |
|---|---|---|---|
| a | `Stop` 훅 block | 그 세션이 턴을 끝내는 순간 자동 착수 | ✗ |
| b | `UserPromptSubmit` 주입 | 사용자가 그 세션에 다음 입력을 넣을 때 | ✗ (사용자가 깨움) |
| c | `claude --bg` 로 새 세션 | 즉시 — 데몬이 프로세스를 띄운다 | 해당 없음 |

**이 스펙은 a + b 만 다룬다.** c 는 되돌리기 어려운 자동 실행이라(권한 모드·작업 디렉터리·
출력 회수를 전부 정해야 한다) `rocky-todo#16` 으로 분리했다.

## 흐름

```
[웹 UI 버튼] ──POST /api/todos/11/handoff {sessionId, note}──> [데몬]
                                                                 │
                                          claude agents --json ──┤ 세션 목록·검증
                                                                 │
                                                          handoffs (pending)
                                                                 │
[세션의 Stop 훅] ──GET /api/handoffs/next?sessionId=…──────────> claim (→ delivered)
       │
       └─> {"decision":"block","reason":"…"} → 세션이 그 자리에서 착수
```

데몬은 아무것도 밀지 않는다. 세션 훅이 자기 앞으로 온 것만 당겨간다.

## 세션 목록 — `src/sessions.ts`

`claude agents --json` 이 활성 세션을 그대로 준다(TTY 불필요):

```json
{"pid":32551,"cwd":"/Users/minjun/orca/workspaces/rocky-todo/eelpout",
 "kind":"interactive","startedAt":1785067158470,
 "sessionId":"5591d3d2-…","name":"eelpout-a3","status":"busy"}
```

덕분에 세션 등록 프로토콜(SessionStart 에서 데몬에 자기를 알리는 식)을 만들 필요가 없다.
`src/tailscale.ts` / `src/github.ts` 와 같은 형태로 **주입 가능한 `RunCommand`** 를 거치므로
`claude` CLI 가 없는 머신에서도 전 테스트가 통과한다.

```ts
export interface AgentSession {
  pid: number; cwd: string; kind: 'interactive' | 'background';
  sessionId: string; name: string; status: 'idle' | 'busy'; startedAt: number;
}
export function listSessions(run?: RunCommand): AgentSession[]
export function matchBoard(sessions: AgentSession[], boardKey: string): AgentSession[]
```

### 매칭 규칙

**cwd 의 경로 세그먼트 중 하나가 boardKey 와 일치하면 후보다.** basename 만 보면 워크트리를
놓친다 — `/Users/minjun/orca/workspaces/rocky-todo/eelpout` 의 basename 은 `eelpout` 이다.
세그먼트로 보면 `~/dev/workspaces/rocky-todo` 와 그 워크트리가 둘 다 후보로 잡히고, 후보가
2개이므로 사용자에게 묻는다 — 의도한 동작이다.

git remote 를 읽어 정확히 판정할 수도 있지만 세션마다 프로세스를 띄워야 하고, 어차피 애매하면
묻는 설계라 얻는 게 없다.

## 데이터 모델 — 마이그레이션 `user_version` 2

```sql
CREATE TABLE IF NOT EXISTS handoffs (
  id            TEXT PRIMARY KEY,
  todo_id       TEXT NOT NULL REFERENCES todos(id),
  session_id    TEXT NOT NULL,
  session_name  TEXT,
  session_cwd   TEXT,
  note          TEXT NOT NULL DEFAULT '',
  actor         TEXT NOT NULL,
  status        TEXT NOT NULL,   -- pending | delivered | cancelled
  created_at    TEXT NOT NULL,
  delivered_at  TEXT,
  delivered_via TEXT             -- stop | prompt
);
CREATE INDEX IF NOT EXISTS idx_handoffs_session
  ON handoffs(session_id, status, created_at);
```

신규 DB 는 `SCHEMA` 로 이 테이블을 갖고 태어나므로 마이그레이션에 `IF NOT EXISTS` 가드가
붙는다 (PR #11 의 `boards.repo` 가 `PRAGMA table_info` 가드를 단 것과 같은 이유).

`session_name` / `session_cwd` 는 표시용 스냅샷이다. 세션이 사라지면 `session_id` 만으로는
보드에서 "어디로 보낸 것"인지 읽을 수 없다.

### TTL 을 두지 않는 이유

대기 중인 요청은 만료시키지 않는다. 대신 큐를 조회할 때 활성 세션 목록과 대조해 대상이 없으면
`stale: true` 로 **표시만** 한다. 자동 만료는 "보냈는데 조용히 사라졌다"를 만들고, 그게 이
기능에서 가장 나쁜 실패다. 사용자가 취소하거나 다른 세션으로 다시 보낸다.

### 히스토리

handoff 는 todo 히스토리에 남긴다 — `entity: 'todo'`, action `handoff` / `handoff-cancel` /
`handoff-delivered`. 댓글과 같은 방식이라 SSE·타임라인을 그대로 탄다.

**단, `/api/changes` 피드에서는 제외한다.** 그러지 않으면 A 세션으로 보낸 요청이 B·C 세션의
`UserPromptSubmit` 주입에까지 "logan 이 handoff 했다"로 실려 노이즈가 된다. 배달에는 전용
경로가 따로 있다.

## 배달 프로토콜

### claim — 한 번에 한 건

```
POST /api/handoffs/claim  {sessionId, via: "stop" | "prompt"}
→ 200 {handoff, remaining: 2}   |   204 (없음)
```

claim 은 상태를 바꾸므로 GET 이 아니라 POST 다 — 부작용 있는 GET 은 재시도·프리페치에
안전하지 않다.

pending 중 가장 오래된 1건을 한 트랜잭션에서 `delivered` 로 바꾸며 반환한다. 데몬이 단일
writer 라 경쟁은 없지만 `Stop` 과 `UserPromptSubmit` 두 훅이 같은 큐를 보므로 claim 자체는
원자적이어야 한다.

**여러 건이 대기해도 한 번에 하나만 준다.** 3건을 한꺼번에 주입하면 에이전트가 섞어서
착수하거나 병렬로 벌린다 — 보드의 `start`→`done` 에티켓과 어긋난다. 하나를 끝내면 `Stop` 이
다시 발동해 다음 것을 집으므로 큐는 저절로 직렬로 소화된다. 주입문에 잔여 건수를 알린다.

### 훅 배선

| 훅 | 파일 | 동작 |
|---|---|---|
| `Stop` (신규) | `hooks/handoff-stop.ts` | claim 성공 시 `{"decision":"block","reason":…}` |
| `UserPromptSubmit` (기존) | `hooks/notify-todo.ts` 에 얹음 | claim 성공 시 `additionalContext` 에 덧붙임 |

`UserPromptSubmit` 은 이미 도는 훅이라 프로세스를 늘리지 않는다. 순수 로직(claim 판단·주입문
생성)은 `src/handoff.ts` 에 두고 두 훅이 공유한다 — `src/notify.ts` 와 같은 구조다.

`Stop` 훅은 **서브에이전트 컨텍스트에서 즉시 빠진다** (입력의 `agent_id` / `agent_type` 확인).
서브에이전트가 보드 요청을 가로채면 사용자가 보낸 대상과 실제 처리 주체가 갈린다.

무한 루프는 구조적으로 없다: claim 된 건은 `delivered` 라 다시 나오지 않고, 큐가 비면
`block` 하지 않는다.

### 주입문

```
# rocky-todo: 보드에서 도착한 작업 요청

logan → rocky-todo#11 "todo - 에이전트 작업 요청"
메모: 테스트부터 짜줘

이 항목을 지금 착수해라. 상세는 todo_list { id: "rocky-todo#11" } 로 읽고,
착수할 때 todo_status { id: "rocky-todo#11", action: "start" } 로 표시한다.
(대기 중인 요청이 2건 더 있다 — 이 건을 마치면 이어서 도착한다.)
```

todo 본문은 복사하지 않는다. 세션이 `todo_list` 로 직접 읽으면 댓글·히스토리까지 최신으로 본다.

## 표면

### REST

| | |
|---|---|
| `GET /api/sessions?board=rocky-todo` | 활성 세션 + 매칭 후보 표시. `claude` 를 못 쓰면 `{available:false, reason}` |
| `POST /api/todos/:ref/handoff` | `{sessionId?, note?}` → 201. `sessionId` 생략 시 자동 매칭 — 후보가 정확히 1개면 보내고, 0개거나 2개 이상이면 409 + 후보 목록 |
| `GET /api/handoffs?board=&status=` | 큐 조회 (대상 세션이 없으면 `stale: true`) |
| `POST /api/handoffs/claim` | 훅 전용 claim |
| `POST /api/handoffs/:id/cancel` | 취소 |

같은 todo 에 이미 `pending` 이 있으면 409 — 두 세션에 같은 일이 가는 것을 막는다.

### 웹 UI

드로어의 액션 줄에 **"에이전트에게 보내기"**. (PR #11 이 먼저 머지되면 "GitHub 이슈 만들기"
옆자리다 — 이 스펙은 그 PR 에 의존하지 않는다.) 누르면 세션 선택 패널이 열린다 —
후보가 하나면 그 이름만 보여주고 바로 보내기, 여러 개면 목록(`name` · `cwd` · idle/busy).
메모는 한 줄 입력이고 비워도 된다.

보낸 뒤에는 드로어에 `대기 중 · eelpout-a3 에게` + 취소 버튼, 목록에는 작은 뱃지. `doing`
앰버 뱃지와 색을 구분한다 — "보냈다"와 "처리 중"은 다른 상태다.

**실패해도 패널과 입력은 열린 채 남는다.** PR #11 에서 repo 입력이 one-shot 이라 브라우저만
쓰는 사용자가 막다른 길에 몰렸던 실수를 반복하지 않는다.

`claude` 를 못 쓰는 환경이면 버튼은 비활성 + 이유를 보여준다.

### CLI

```
rocky-todo sessions                                  # 활성 세션 목록
rocky-todo handoff REF [--session NAME] [--note "…"] # 보내기
rocky-todo handoff REF --cancel                      # 취소
```

### MCP — 도구를 추가하지 않는다 (5개 유지)

이건 **사람이 에이전트에게 일을 넘기는** 기능이다. `todo_handoff` 를 열면 에이전트가 다른
에이전트에게 일을 미루는 경로가 생기는데 사용자가 그것을 승인한 적이 없다. PR #11 에서
`todo_write` 가 조용히 외부 공개 도구가 됐던 것과 같은 종류의 확장이라 처음부터 닫는다.

## 에러 처리

- `claude` 없음/실패 → 세션 목록이 빈 값 + `available:false`. 이 기능만 비활성, 보드는 정상.
- 훅이 데몬에 못 붙음 → **fail-open**, 조용히 통과. pending 은 남아 다음 `Stop` 에 재시도.
- `Stop` 훅 timeout **3초**. 기본값(600초)이면 데몬이 이상할 때 턴 종료 자체가 멈춘다.
- 아카이브된 todo 로의 handoff → 400.

## 이 설계가 막지 못하는 것

- **claim 후 세션이 죽으면 그 건은 유실된다.** `delivered` 인데 아무도 착수하지 않은 상태로
  남는다. 자동 복구는 넣지 않는다 — 보드가 handoff 상태와 todo 상태를 나란히 보여주므로
  "배달됨인데 여전히 todo" 가 눈에 띈다. 그때 다시 보내면 된다.
- **배달된 작업이 권한 승인을 요구하면 세션이 거기서 멈춘다.** 사용자가 근처에 있다는 전제다.
  자리를 비운 경우는 `rocky-todo#16` 의 몫이다.
- **에이전트가 요청을 거절할 수 있다.** 큐에서는 이미 소비된 뒤다. 정상 동작으로 본다 — 거절
  이유가 대화에 남고, 필요하면 보드에서 다시 보낸다.

## 범위 밖

- 백그라운드 세션 spawn (`rocky-todo#16`).
- 세션 → 세션 재위임.
- 배달 결과를 보드로 자동 회수 (에이전트가 댓글로 남기는 기존 경로를 쓴다).

## 검증

| 파일 | 검증 |
|---|---|
| `src/sessions.test.ts` | `RunCommand` DI — 정상 JSON / 빈 목록 / 깨진 출력 / CLI 없음 / 워크트리 경로 매칭 |
| `src/store.test.ts` | 생성 · claim 원자성 · 취소 · 중복 pending 거부 · 히스토리 기록 |
| `src/handoff.test.ts` | 주입문 생성 (메모 유무, 잔여 0건/N건) |
| `src/server.test.ts` | 201 · 204 · 400 · 404 · 409 계약 |
| `src/migrations.test.ts` | `user_version` 2 — 기존 DB · 신규 DB 양쪽 |
| `hooks/handoff-stop.test.ts` | block 판단 · 서브에이전트 skip · fail-open |

게이트는 `bun run check` · `bun run typecheck` · `bun test`. `claude` CLI 가 없어도 전부
통과해야 한다.

문서는 `FEATURES.md` · `AGENTS.md` · `README.md` · `docs/rocky-todo.md` 동기화 +
`bunx changeset`.
