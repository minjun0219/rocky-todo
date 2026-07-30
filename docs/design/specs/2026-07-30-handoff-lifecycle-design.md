# 핸드오프 라이프사이클 + doing 세션 귀속 — 설계

- 날짜: 2026-07-30
- 상태: 구현 완료

> **구현 중 달라진 것** (아래 본문은 정정 반영됨)
>
> 1. "딸려오는 정리 2" 로 잡았던 `handoff-delivered` 자기 반향은 **실제로 없었다** —
>    `TodoStore.listChangesSince` 가 쿼리에서 handoff 계열 액션을 이미 뺀다. 방어 코드를
>    넣었다가 되돌렸다.
> 2. `GET /api/handoffs` 에 **`open` 필터**가 필요했다. 웹 UI 가 `?status=pending` 만
>    받고 있어서 배달된 미착수 건이 화면에 도달할 길이 없었다.
> 3. 세션 식별자 대조는 full UUID 와 **spawn 이 저장하는 짧은 8자 id 를 둘 다** 봐야 했다.

## 배경 — 왜 이걸 하나

rocky-todo 는 사람 ↔ Claude Code 세션 사이의 **비동기 커뮤니케이션 채널**을 지향한다. 세션이
돌고 있을 때의 대화는 세션 안에서 하면 되고, 보드가 맡는 몫은 **세션이 안 돌고 있을 때 남겨
두는 것**이다.

그 관점에서 지금 두 군데가 비어 있다.

1. **핸드오프가 `delivered` 에서 끝난다.** 보드가 세션에 요청을 밀어 넣고 훅이 집어가면
   `delivered` 가 되는데, 그 세션이 실제로 착수했는지·끝냈는지·그냥 무시했는지가 큐에 남지
   않는다. "보냈는데 조용히 사라졌다" 가 이 기능에서 가장 나쁜 실패인데, 지금은 그게 정확히
   일어나도 보드에 아무 흔적이 없다.

2. **`doing` 이 죽은 세션인지 알 수 없다.** `todos.doing_by` 는 `'claude-code'` 같은 뭉뚱그린
   actor 문자열이라 어느 세션 것인지 모른다. 웹 UI 의 stale 표시는 `doing_since` 경과 30분만
   본다 — 그건 "느리다" 이지 "죽었다" 가 아니다. 세션이 다 꺼졌는데 "처리중" 이 영원히 남는다.

두 문제는 **같은 빈칸**을 공유한다: *이 doing 은 어느 세션 것인가.* 그리고 핸드오프는 그 답을
이미 들고 있다 — `handoffs.session_id`. 그래서 한 덩어리로 푼다.

### 왜 에이전트에게 물어볼 수 없나

`/mcp` 는 stateless streamable HTTP 라 도구 호출에 세션 식별자가 없다. 에이전트는 자기
`session_id` 를 모른다 — 그건 훅 stdin 에만 있다. 훅이 주입 컨텍스트로 알려주고 에이전트가
`todo_status` 에 되돌려 넘기게 하는 방법도 있지만, 빼먹으면 조용히 예전 동작으로 돌아가서
신뢰할 수 없다. **에이전트 협조가 0인 경로로만 푼다.**

## 스코프

- (A) 핸드오프 라이프사이클 — `accepted` / `completed` 기록
- (B) doing 세션 귀속 + stale 판정
- (C) 웹 UI 표시 + 미착수 재전송

A 가 B 의 재료다(귀속 정보가 핸드오프에서 온다). C 는 그 위에 얹는다.

**스코프 밖**: push 알림, 읽음 커서 서버 이전, 사람 댓글의 자동 핸드오프화. 앞의 둘은 이
제품의 전제(즉시성이 요구사항이 아니다 / 무인증이라 사용자 개념이 없다)와 맞지 않아 뺐고,
셋째는 세션 안에서 대화로 해결되는 영역이라 뺐다.

## 데이터 — migration `user_version` 5

```sql
ALTER TABLE handoffs ADD COLUMN accepted_at  TEXT;  -- 대상 세션이 실제로 착수한 시각
ALTER TABLE handoffs ADD COLUMN completed_at TEXT;  -- 그 todo 가 done 된 시각
ALTER TABLE todos    ADD COLUMN doing_session_id TEXT;  -- 이 doing 이 어느 세션 것인가
```

세 컬럼을 마이그레이션 **한 건**으로 묶는다. `SCHEMA` 에도 같이 넣으므로 `addBoardRepo` 와
같은 `PRAGMA table_info` 가드가 필수다 (`MIGRATIONS` 주석의 규칙).

### `status` enum 은 건드리지 않는다

`pending | delivered | cancelled` 를 그대로 두고 accepted/completed 는 **타임스탬프로만**
남긴다.

- 기존 `delivered_at` / `delivered_via` 와 같은 결이다.
- `?status=pending` 필터를 쓰는 서버·UI 코드가 안 깨진다.
- 상태를 늘리면 `cancelled` 와의 조합이 애매해진다 (accepted 된 걸 취소할 수 있나?).
  타임스탬프면 "언제 무엇이 일어났나" 가 그대로 남고 해석은 읽는 쪽이 한다.

UI 가 쓸 단계는 서버가 `stale` 처럼 **파생 필드**로 얹어 내려준다.

## 전이 규칙 — `setTodoStatus` 안에서

에이전트 협조 없이 스토어가 알아서 채운다.

| 액션 | 하는 일 |
|---|---|
| `start` | 그 todo 의 *미수락 delivered* 핸드오프 중 **가장 오래된 한 건**에 `accepted_at` 을 찍고, 그 `session_id` 를 `todos.doing_session_id` 로 복사 |
| `done` | 같은 핸드오프에 `completed_at` 을 찍고 `doing_session_id` 를 비운다 |
| `stop` | `doing_session_id` 를 비운다. 핸드오프는 `accepted` 로 남는다 (착수는 사실이었다) |

### 예외 둘

**start 없이 바로 done.** 사소한 건은 에이전트가 start 를 건너뛴다. 이때 `accepted_at` 을
`completed_at` 과 같은 값으로 함께 찍는다. 안 그러면 "끝났는데 미착수" 라는 모순 상태가 남아
UI 가 경고를 띄운다.

**사람이 누른 start.** `AGENT_ACTORS` 에 없는 actor 면 귀속하지 않는다 — 핸드오프는 그대로
두고 `doing_session_id` 도 안 채운다. 핸드오프를 보내놓고 사람이 직접 잡은 경우, 그 요청은
여전히 "세션이 안 집었다" 가 사실이다.

### `accepted` 판정 신호는 `start` / `done` 뿐

댓글은 치지 않는다. 보드의 계약이 start→done 이고, 댓글만 달고 만 건은 **미착수가 사실**이다.
사람이 그 댓글을 읽고 판단하면 된다.

### 히스토리에 따로 기록하지 않는다

`start` / `done` 이 이미 히스토리에 남으므로 중복이다. 핸드오프 행만 갱신하고 SSE change
이벤트만 낸다.

## doing 판정 — 서버가 파생해서 내려준다

`GET /api/todos` 응답의 각 todo 에 `doingState` 를 얹는다.

```
type DoingState = 'live' | 'idle' | 'gone' | 'unknown'
```

판정 트리 (위에서부터, 먼저 맞는 것):

| 조건 | 값 |
|---|---|
| 세션 목록을 못 얻음 (`available: false`) | `unknown` |
| `doingSessionId` 있음 + 세션 목록에 있고 `status: 'busy'` | `live` |
| `doingSessionId` 있음 + 세션 있는데 `status: 'idle'` 또는 background `state: 'done'` | `idle` |
| `doingSessionId` 있음 + 목록에 없음 | `gone` |
| `doingSessionId` 없음 + `doingBy` 가 에이전트 actor + 그 보드 경로에 활성 세션 0개 | `gone` |
| 그 외 | `unknown` |

### `idle` 을 따로 두는 이유

"세션은 살아있는데 턴이 끝났고 `done` 을 안 불렀다" — 실제로 제일 흔한 실패인데 지금은 전혀
안 보인다. 30분 룰로도 안 잡힌다(턴은 5분 만에 끝날 수 있다). 죽음(`gone`)과 방치(`idle`)는
사람이 취할 행동이 다르므로 값을 나눈다.

### 보드 근사 — 마지막 줄의 근거

핸드오프 없이 에이전트가 자발적으로 `start` 한 건은 귀속이 안 된다. 이때는 `matchBoard`
(cwd 경로 세그먼트 매칭)로 그 보드에 활성 세션이 **하나도 없을 때만** `gone` 으로 본다.

- 거칠지만 "다 꺼졌는데 처리중이 남아있다" 는 가장 흔한 실상황을 잡는다.
- 사람 actor 의 doing 은 제외하므로, 사람이 "내가 할게" 하고 눌러둔 항목이 오탐으로 뜨지
  않는다.
- 세션이 하나라도 있으면 `unknown` — **모르는 것과 없는 것은 다르다**는 기존 핸드오프 stale
  판정의 원칙을 그대로 지킨다.
- `boards.path` 는 필요 없다. `matchBoard` 가 cwd 세그먼트를 보므로 원본 레포와 워크트리가
  둘 다 잡힌다.

### 비용

핸드오프 라우트가 이미 쓰는 패턴 그대로다. `listSessions` 는 실측 ~220ms 의 동기 블로킹이라
요청마다 부르면 데몬 전체가 그만큼 멎는다.

- 목록에 `doing` 이 하나도 없으면 세션 조회를 **아예 건너뛴다**.
- 부를 때는 `createCachedListSessions`(TTL 3초)를 탄다.

## 미착수 표시 + 재전송

### 판정에 시간 임계값을 쓰지 않는다

`delivered && !accepted_at` 인 핸드오프는 **그 세션이 `gone` 이거나 `idle` 일 때만** 경고로
띄운다. 세션이 `busy` 면 아직 하는 중일 수 있으니 조용하다. 임의의 "N분" 상수를 만들지 않고도
정확해진다 — claim 직후 몇 초의 공백이 경고로 새지 않는다.

### 재전송은 새 핸드오프를 만든다

원본은 `delivered` 로 **보존**한다. 자동 만료도, 자동 재배달도 없다 — "보냈는데 조용히
사라졌다" 를 만들지 않는다는 기존 원칙과 같은 결이다. 다시 보낼지는 사람이 정한다.

`createHandoff` 의 중복 가드는 `pending` 만 보므로(`pendingHandoffOf`) 원본이 `delivered` 인
상태에서는 그대로 통과한다. 웹 UI 는 기존 `sendHandoff` 를 재사용한다.

드로어 표시:

```
▸ eelpout-a3 에 보냄  12분 전
  ⚠ 배달됨 · 미착수 · 세션 종료됨
  [다시 보내기]  [닫기]
```

## 딸려오는 정리

**`AGENT_ACTORS` 통합.** `src/notify.ts` 와 `src/ui/lib.ts` 에 두 벌 있었다. 스토어에서도
필요해져 세 벌이 되므로 `src/actors.ts` 로 뽑아 셋이 같이 쓴다. 목록이 갈라지면 같은 actor 가
화면에서는 에이전트인데 주입 필터에서는 사람이 되는 식으로 어긋난다. 이번 목표에 필요한
통합이지 무관한 리팩터가 아니다.

> 원래 여기 "`handoff-delivered` 의 actor 가 `sessionName` 이라 `filterHumanChanges` 를
> 통과한다" 는 항목이 있었는데, 확인해 보니 사실이 아니었다 — `listChangesSince` 가 쿼리에서
> handoff 계열 액션(`handoff` / `handoff-delivered` / `handoff-cancel` / `handoff-spawn`)을
> 이미 제외하므로 그 엔트리는 필터까지 오지 않는다.

## `open` 필터 (구현 중 추가)

웹 UI 는 `GET /api/handoffs?status=pending` 만 받고 있었다. 미착수는 정의상 `delivered` 라
그 쿼리로는 **화면에 도달할 길이 없다**. 필터를 빼고 전부 받으면 완료된 과거 이력까지 매
refetch 마다 딸려온다.

`open=true` — *아직 결말이 안 난 건*(대기 중이거나, 배달됐는데 완료되지 않은 것)만 준다.
UI 가 실제로 필요로 하는 집합이 정확히 그것이다. `listHandoffs({ open: true })` 가 SQL
한 줄로 처리한다.

## 세션 식별자 대조 (구현 중 발견)

`createSpawnedHandoff` 가 저장하는 `sessionId` 는 full UUID 가 아니라 `claude attach/logs/
stop/rm` 이 받는 **짧은 8자 id** 다. `AgentSession.sessionId` 로만 대조하면 살아 있는 spawn
세션이 전부 `gone` 으로 보인다. `findSession` 은 `sessionId` 와 `id` 를 둘 다 본다.

(기존 `GET /api/handoffs` 의 stale 판정은 이 문제가 없다 — `pending` 인 건에만 판정하는데
spawn 핸드오프는 생성 시점부터 `delivered` 라 애초에 대상이 아니다.)

## 검증

- `doing.test.ts` (신규) — 순수 판정 매트릭스 22건: `resolveDoingState` 의 귀속/보드 근사/
  판정 불가 갈래, `handoffPhase`, `isUnstarted`.
- `store.test.ts` — 전이 매트릭스: 정상 start→done, start 없이 done, 사람 actor 의 start,
  delivered 다건일 때 가장 오래된 것에 귀속, stop 후 doing_session_id 비움, reopen 이
  완료 기록을 되돌리지 않음, `listHandoffs({ open })`.
- `migrations.test.ts` — 신규 DB(`SCHEMA` 경유)와 기존 DB 양쪽에서 v5 적용.
- `server.test.ts` — `doingState` 판정 매트릭스(주입 `sessions` 로 결정론적), 세션 조회
  스킵 최적화를 호출 횟수로 검증, `available: false` 면 `unknown`, `open=true` 응답,
  `phase`/`unstarted` 파생.
- `ui/lib.test.ts` — `doingWarning` 우선순위(세션 판정이 30분 규칙을 덮어쓴다).
- `TodoItem.test.tsx` / `DetailDrawer.test.tsx` — 배지 렌더, 미착수 알림, 재전송 클릭이
  세션 목록을 불러 패널을 연다.

## 문서 갱신

- `AGENTS.md` — "데몬/설치 모델" 의 핸드오프 문단에 라이프사이클·doing 귀속 추가
- `FEATURES.md` / `docs/rocky-todo.md` — 사용자 표면(웹 UI 표시) 변경
- `bunx changeset` — 사용자 표면 변경이므로 필요
