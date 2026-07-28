# task id 표기를 `board#N` 에서 `board-N` 으로

**날짜**: 2026-07-28
**상태**: 설계 승인됨

## 문제

보드 항목의 사람이 읽는 참조가 `rocky#12` 다. `#12` 는 GitHub 이슈 번호의 표기와 정확히
겹쳐서, 대화나 댓글에 섞여 나올 때 "이게 보드 항목인가 이슈인가"를 사람도 에이전트도
매번 되짚어야 한다. 보드는 GitHub 이슈 생성 기능을 이미 갖고 있어(`todo_write.createIssue`)
두 번호가 한 항목에 같이 붙는 경우가 실제로 생긴다.

부수 문제 두 가지:

- 웹 UI 의 번호 버튼은 참조 문자열(`rocky#12`)만 복사한다. 그걸 세션에 붙여넣으면
  에이전트가 무엇을 하라는 건지 모른다 — 사용자가 매번 말을 덧붙여야 한다.
- 에이전트가 커밋 메시지·PR 본문에 task id 를 적어 넣는다. 보드 번호는 사용자 로컬
  데몬의 것이라 레포를 보는 다른 사람에게는 해석 불가능하고, 보드가 재생성되면
  번호가 달라져 영구 기록으로서 값이 없다.

## 결정

### 참조 문법

| 대상 | 새 표기 | 기존 표기 |
| --- | --- | --- |
| 보드 항목 | `rocky-12` | `rocky#12` |
| 글로벌 메모 | `note-3` | `#3` |
| 보드 컨텍스트 안의 번호 | `12` | `#12` / `12` |
| raw id / id prefix | `921gvwnr` | 동일 |

`rocky#12` 와 `#12` 는 **입력으로만** 계속 받는다. 제품이 만들어내는 문자열 — REST/MCP
응답의 `ref`, 웹 UI, CLI 출력, 훅 주입문 — 은 전부 `-` 형태다.

구분자로 `-` 를 고른 이유: Jira 스타일(`PROJ-12`)이라 "이건 task id 다"로 즉시 읽히고,
`#`(GitHub) · `:`(슬래시 커맨드 이름에 이미 쓰임) 어느 쪽과도 겹치지 않는다. board key 에
`-` 가 흔하다는 점은 파싱 규칙(아래)으로 결정론적으로 해소한다.

### 파싱 — `resolveRef` (`src/store.ts`)

분기를 하나 추가한다. **순서가 계약이다**:

1. **레거시 스코프** `^([^#\s]+)#(\d+)$` — 기존 그대로. 입력 호환 전용.
2. **신규 스코프** `^(\S+)-(\d+)$` — 새로 추가. `\S+` 가 greedy 라 **가장 오른쪽** `-`
   에서 갈린다: `rocky-todo-12` → 보드 `rocky-todo` / 12번. board 부분이 `note` 면
   글로벌 메모 번호 공간으로 간다 (`notes` 테이블 전용 — `todos` 조회에서 `note-3` 은
   `undefined`).
3. **맨숫자** `^(#)?(\d+)$` — 기존 그대로.
4. **id 정확 일치 → id prefix** — 기존 그대로.

2번이 4번을 잡아먹지 않는다: id 는 base36 8자(`ID_ALPHABET`)라 `-` 를 담을 수 없다.

공백을 배제하는 이유는 기존 `[^#\s]+` 와 같다 — board key 에 공백이 든 레거시 보드는
스코프 참조로 가리킬 수 없고 raw id 로 폴백한다(기존 정책 유지).

### 직렬화 — `refOf` (`src/refs.ts`)

- `boardId` 없음 → `note-${number}`
- board key 가 ref-safe → `${key}-${number}`
- 아니면 raw id 폴백 (기존 정책 유지 — 제품이 스스로 못 읽는 참조를 내보내지 않는다)

`isRefSafeBoardKey` 의 조건을 갱신한다: 빈 문자열 ✗, 공백 포함 ✗, `#` 포함 ✗,
**`note` ✗**(예약어). `-` 는 허용한다 — greedy 파싱이 처리한다.

`ensureBoard` 는 **새** 보드의 key 로 `note` 를 거부한다(기존 빈/공백/`#` 검증에 추가).
검증 도입 전에 만들어진 `note` 보드가 이미 있으면 기존 정책대로 살려두고, 그 보드의
항목만 `refOf` 가 raw id 로 폴백한다. `note-3` 은 언제나 글로벌 메모를 뜻하며, 그런
레거시 보드의 항목은 raw id 로만 가리킨다.

### `refNeedsBoardContext` — 변경 없음

board 컨텍스트를 실제로 소비하는 것은 맨숫자 분기뿐이고 그 정규식은 그대로다. 신규
스코프 참조는 자기 안에 board 를 담으므로 컨텍스트가 필요 없다.

### 복사 동작

`src/ui/lib.ts` 에 순수 함수를 하나 추가한다:

```ts
export function boardCommand(ref: string): string // → `/rocky-todo:board rocky-12`
```

복사 호출부 네 곳(`TodoItem` / `NotesRail` / `DetailDrawer` 의 todo·note 경로)이
`copyRefWithFeedback(x.ref, …)` 대신 `copyRefWithFeedback(boardCommand(x.ref), …)` 를 쓴다.

버튼에 **보이는 글자와 `aria-label` 은 `rocky-12` 그대로** 둔다 — 화면은 참조를 보여주고
클립보드만 커맨드로 확장한다. 클립보드 접근 실패 시 `prompt` 폴백에 담기는 문자열도
커맨드다(수동 복사도 같은 값이어야 한다).

### 스킬 — `skills/board/SKILL.md`

- 참조 예시를 전부 새 표기로 갱신한다 (`rocky#12` → `rocky-12`, `#3` → `note-3`).
- **새 절**: 인자로 참조 하나가 들어오면(`/rocky-todo:board rocky-12`) 그 항목을 조회하고
  기존 start → 댓글 → done 에티켓을 그대로 탄다. `note-N` 이면 note 를 조회한다.
  보드 접두사가 붙은 참조는 todo 로 먼저 조회한다.
- 가드레일에 아래 커밋/PR 지침을 추가한다.

### 커밋/PR 지침

`skills/board/SKILL.md` 가드레일과 `AGENTS.md` 의 Output / communication 절 양쪽에 넣는다:

> task id(`rocky-12`)는 레포에 남는 어떤 텍스트에도 넣지 않는다 — 커밋 메시지, PR
> 제목·본문, 브랜치명, 코드 주석, changeset. 보드 번호는 사용자 로컬 데몬의 것이라
> 레포를 보는 다른 사람에게는 해석 불가능하고, 보드가 재생성되면 번호가 달라진다.
> 무엇을 왜 바꿨는지로 쓴다.

### 문서 동기화

`FEATURES.md`(사람) · `AGENTS.md`(에이전트) · `README.md`(진입) · `docs/rocky-todo.md`(운영)
의 `#` 참조 표기를 갱신한다. `docs/superpowers/` 아래의 과거 스펙·플랜 문서는 그 시점의
기록이므로 손대지 않는다.

## 테스트

- `src/refs.test.ts` — `refOf` 가 `-` 형태를 낸다 / `boardId` 없으면 `note-N` /
  board key 가 `note` 면 raw id 폴백 / `isRefSafeBoardKey` 의 새 조건.
- `src/store.test.ts` — `resolveRef` 의 신규 분기: `rocky-12`, `rocky-todo-12`(오른쪽
  split), `note-3` 이 notes 에서만 풀리고 todos 에서는 `undefined`, 레거시 `rocky#12` ·
  `#12` 가 계속 동작, `ensureBoard('note')` 거부, `refOf` → `resolveRef` 왕복 계약.
- `src/ui/lib.test.ts` — `boardCommand`.
- `src/ui/components/*.test.tsx` — 복사 버튼이 클립보드에 커맨드를 넣고 보이는 글자는
  참조 그대로인지.
- 기존 `#` 기대값 테스트는 삭제하지 않고 "구 표기 입력" 케이스로 남긴다.

## 범위 밖

- **DB 마이그레이션 없음** — 번호 체계(보드별 `MAX(number)+1`, 글로벌 메모 번호 공간)는
  그대로다. 바뀌는 것은 그 번호를 사람에게 보여주는 문자열뿐이다.
- **URL 퍼머링크 유지** — 웹 UI 주소는 계속 `/rocky/12` 다.
- **MCP 도구 5개 유지** — 도구 계약의 인자 이름·개수는 바뀌지 않는다. `id` 가 받는
  문자열의 모양만 넓어진다.
- **글로벌 메모가 아닌 board-scoped note** 는 여전히 같은 보드의 todo 와 같은 참조
  문자열을 가질 수 있다(`rocky-3` 이 todo 일 수도 note 일 수도 있다). 기존과 동일한
  성질이며 이번 변경으로 나빠지지도 나아지지도 않는다 — 별건이다.

## 릴리스

사용자 표면 변경이므로 `bunx changeset` 으로 버전 의도를 선언한다.
