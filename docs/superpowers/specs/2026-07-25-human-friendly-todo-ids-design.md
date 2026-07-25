# 사람이 읽고 쓰는 todo 번호 (`#12`)

- 날짜: 2026-07-25
- 상태: 설계 승인 대기
- 대상: `src/store.ts` · `src/server.ts` · `src/cli.ts` · `src/mcp.ts` · `src/ui/`

## 문제

todo/note 식별자가 8자 base36 랜덤 문자열이다 (`921gvwnr`, `lb2ofdsn`, `2i2he2ir`).
`store.ts:159` 의 `newId()` 가 생성하고, `resolveByPrefix()` 가 prefix 매칭을 허용한다.

랜덤 문자열은 사람이 다루는 세 가지 방식 모두에서 실패한다:

1. **읽기** — 목록의 `921gvwnr` / `lb2ofdsn` / `b7m80fgj` 는 서로 동등하게 무의미해서,
   보드를 다시 볼 때마다 눈으로 대조해야 한다.
2. **쓰기** — CLI 입력이 번거롭다. prefix 매칭이 있지만 몇 자까지 안전한지 알 수 없어
   결국 전체를 복사하게 된다.
3. **말하기** — 대화에서 "lb2ofd 진행해줘"는 부자연스럽다.

## 목표 / 비목표

**목표** — 사람이 부를 수 있는 짧은 참조를 준다. 기존 데이터와 참조를 깨지 않는다.

**비목표** — 랜덤 id 제거(히스토리·`parent_id`·API 가 물고 있다), 번호의 전역 유일성,
아카이브된 번호의 회수.

## 설계

### 1. 스키마

`todos` 와 `notes` 에 `number INTEGER` 를 더한다. 랜덤 `id` 는 PK 로 그대로 남는다 —
`history.entity_id`, `todos.parent_id`, 기존 링크가 전부 이 값을 참조하므로 교체하지 않는다.

```sql
ALTER TABLE todos ADD COLUMN number INTEGER;
ALTER TABLE notes ADD COLUMN number INTEGER;
CREATE UNIQUE INDEX idx_todos_number ON todos(board_id, number);
CREATE UNIQUE INDEX idx_notes_number ON notes(board_id, number);
```

`notes.board_id` 는 nullable 이다(글로벌 메모). SQLite 의 유니크 인덱스는 NULL 을 서로
다른 값으로 취급하므로 글로벌 메모끼리는 이 인덱스로 유일성이 보장되지 않는다.
글로벌 메모의 번호는 `board_id IS NULL` 부분 인덱스로 따로 건다:

```sql
CREATE UNIQUE INDEX idx_notes_number_global ON notes(number) WHERE board_id IS NULL;
```

### 2. 마이그레이션 러너 (신규)

현재 `TodoStore` 생성자는 `CREATE TABLE IF NOT EXISTS` 뭉치(`SCHEMA`)를 실행할 뿐,
스키마 변경 수단이 없다. 이번이 첫 변경이므로 러너를 함께 들인다.

- `PRAGMA user_version` 을 버전으로 쓴다. 현재 배포본은 모두 `0`.
- `MIGRATIONS: Array<(db: Database) => void>` — 인덱스가 곧 버전.
- 생성자에서 `SCHEMA` 실행 후, `user_version` 보다 뒤에 있는 마이그레이션만 순서대로
  트랜잭션 안에서 적용하고 `user_version` 을 올린다.
- 마이그레이션 1 = 위 컬럼/인덱스 추가 + 기존 행 소급 번호 부여.

소급 부여는 보드별로 `created_at ASC, id ASC` 순서에 1부터 매긴다 (`id` tie-break 는
같은 밀리초 생성 시의 결정성을 위해 — 커서 prune 에서 이미 겪은 문제와 같은 종류다).

### 3. 발급

새 todo/note 는 같은 보드 안에서 `MAX(number) + 1`, 첫 항목이면 1.
`MAX` 기준이라 아카이브된 항목이 있어도 번호가 회수되지 않는다.

동시 삽입 경합은 삽입을 트랜잭션으로 감싸 막는다. 데몬이 단일 프로세스라 실질 경합은
없지만, 유니크 인덱스가 최종 방어선이다.

### 4. 참조 해석

`resolveByPrefix` 를 `resolveRef(table, ref, currentBoardId)` 로 확장한다. 순서대로:

| 입력 | 해석 |
|---|---|
| `rocky#12` | `rocky` 보드의 12번 |
| `#12` · `12` (현재 보드 있음) | 현재 보드의 12번 |
| `#12` · `12` (현재 보드 없음, `notes` 테이블) | **전역** note 번호 공간의 12번(`board_id IS NULL`) |
| `#12` · `12` (현재 보드 없음, `todos` 테이블) | 에러 — 전역 todo 번호 공간은 없다 |
| `921gvwnr` | id 정확 일치 |
| `921g` | id prefix (유일할 때만, 기존 동작) |

`12` 형태가 우선이므로 순수 숫자로 시작하는 랜덤 id 와 충돌할 수 있다. 랜덤 id 는 8자
고정이라, **길이 8 이상이면서 base36 문자만으로 이뤄진 입력은 id 로 먼저 해석**해
모호성을 없앤다. 그 외 짧은 숫자는 번호로 본다.

note 는 board_id IS NULL 인 전역 행을 가질 수 있고(부분 유니크 인덱스
`idx_notes_number_global` 로 보장되는 자체 번호 시퀀스), 웹 UI 는 그 참조를 보드 접두사
없이 `#3` 으로만 표시한다. 그래서 `notes` 테이블에서 현재 보드가 불명확한 채 `#12` 만 온
경우는 에러가 아니라 **전역 번호 공간에서 조회**한다 — 그래야 UI 가 보여준 `#3` 을 그대로
복붙해 다시 찾을 수 있다. todos 는 항상 어떤 보드에 속해 전역 번호 공간이 없으므로, 현재
보드가 불명확한 채 `#12` 만 온 경우는 여전히 에러로 모호성을 노출한다(`ambiguous id
prefix` 와 같은 방침).

### 5. 표시 — CLI / REST / MCP

- **CLI** — 목록/상세에서 제목 앞에 `#12`. 랜덤 id 는 `show` 상세 하단에만 남긴다.
- **REST/MCP** — 응답에 `number: 12` 와 `ref: "rocky#12"` 를 함께 싣는다. 에이전트가
  대화에서 `#12` 로 부를 수 있게 하는 것이 `ref` 의 목적이다.
- **MCP 입력** — `todo_list` / `todo_write` / `todo_status` / `note_*` 의 `id` 인자가
  위 해석 규칙을 그대로 받는다. 스키마 설명에 `"id, #12, or rocky#12"` 를 명시한다.

### 6. 표시 — 웹 UI

웹 UI 가 사람이 항목을 만들고 보는 주 표면이므로 여기가 이 기능의 본체다. 번호는
"보이기만 하는 장식"이 아니라 **웹에서 세션으로 항목을 넘기는 통로**여야 한다.

#### 6.1 항목 행 (`components/TodoItem.tsx`)

체크박스와 제목 사이에 `#12` 를 넣는다. 메타 칩(우선순위·라벨·마감·링크)이 아니라
제목 라인의 고정 요소다 — 칩 줄에 섞으면 개수에 따라 위치가 흔들리고, 모바일 칩 과밀
문제(백로그 `mxndnikm` 8번)를 키운다.

```tsx
<button type="button" className="todo-ref" onClick={copyRef} title="참조 복사">
  #{todo.number}
</button>
<button type="button" className="todo-title" onClick={...}>{todo.title}</button>
```

#### 6.2 클릭 복사 (핵심 워크플로)

번호를 누르면 `rocky#12` 를 클립보드에 복사하고 짧게 "복사됨" 피드백을 준다.

이것이 이 설계의 실사용 경로다: **브라우저에서 항목을 보고 → 번호를 눌러 복사 →
세션 입력창에 붙여넣어 "rocky#12 진행해줘"**. 번호를 눈으로 읽고 손으로 옮겨 치는
단계가 사라진다. 보드 접두사를 포함한 완전 참조를 복사하므로 어느 보드에서 붙여넣어도
모호하지 않다.

`navigator.clipboard` 는 보안 컨텍스트에서만 동작한다. 루프백(`127.0.0.1`)과 tailscale
HTTPS 는 해당되지만 **LAN 평문 HTTP(`192.168.x.x:8636`)는 아니다** — 이 경우 조용히
실패하지 않도록 `document.execCommand('copy')` 폴백을 두고, 그마저 안 되면 번호를
선택된 상태로 만들어 수동 복사가 가능하게 한다.

#### 6.3 상세 드로어 (`components/DetailDrawer.tsx`)

`drawer-id` 가 지금 랜덤 id 를 그대로 노출한다. 이 자리를 `rocky#12` 로 바꾸고,
랜덤 id 는 그 아래 더 옅게 병기한다(API/디버깅 용도로만 필요하다).

#### 6.4 노트 레일 (`components/NotesRail.tsx`)

`note-card-head` 에 같은 방식으로 번호와 복사 버튼을 둔다.

#### 6.5 번호와 정렬의 관계

목록 정렬은 `position` 기준이고 번호는 생성 순이라 둘은 어긋날 수 있다. 이는 의도된
동작이다(GitHub 이슈도 같다) — 번호는 **순서가 아니라 이름**이다. UI 에서 번호로
정렬하는 기능은 넣지 않는다(YAGNI).

#### 6.6 스타일 (`styles.css`)

`.todo-ref` 는 tabular 숫자에 옅은 색, 제목보다 한 단계 작게. 모바일 폭에서는 터치
타깃 44×44 를 확보한다(백로그 `mxndnikm` 1번과 같은 방침).

### 7. 노트

노트도 같은 문제를 겪으므로 동일하게 번호를 준다. 보드 소속 노트는 보드별, 글로벌
노트는 전역 시퀀스(`board_id IS NULL` 그룹)를 쓴다. CLI 명령이 `show` 와 `note show` 로
갈리므로 번호 공간이 겹쳐도 모호하지 않다.

## 영향 범위

| 파일 | 변경 |
|---|---|
| `src/store.ts` | 스키마 컬럼·인덱스, 마이그레이션 러너, 발급, `resolveRef`, 반환 타입에 `number` |
| `src/server.ts` | 응답 직렬화에 `number`/`ref`, 경로 파라미터가 참조 문법 수용 |
| `src/cli.ts` | `formatTodoLine` 등 출력에 `#N`, 인자 파싱 |
| `src/mcp.ts` | 도구 스키마 설명 갱신, 응답에 `number`/`ref` |
| `src/ui/components/TodoItem.tsx` | 제목 앞 `#N` + 클릭 복사 |
| `src/ui/components/DetailDrawer.tsx` | `drawer-id` 를 `rocky#12` 로, 랜덤 id 병기 |
| `src/ui/components/NotesRail.tsx` | 노트 카드 헤드에 번호 + 복사 |
| `src/ui/lib.ts` · `styles.css` | 클립보드 헬퍼(폴백 포함), `.todo-ref` 스타일 |
| `AGENTS.md` · `FEATURES.md` · `docs/rocky-todo.md` | 참조 문법 문서화 |

## 테스트

- 발급: 연속 증가, 보드별 독립, 아카이브 후 번호 미회수
- 마이그레이션: `user_version` 0 → 1 적용, 기존 행에 `created_at` 순 소급 부여,
  동률 타임스탬프의 결정적 순서, 재실행 멱등
- 해석: 네 가지 입력 형태, 보드 간 참조, 8자 base36 입력이 id 로 우선 해석되는지,
  없는 번호 조회 시 에러
- 하위호환: 기존 랜덤 id 와 prefix 가 계속 동작
- 글로벌 노트 번호가 보드 노트와 독립인지
- 클립보드 헬퍼: `navigator.clipboard` 부재 시 폴백 경로를 타는지 (UI 유닛 테스트)

## 리스크

- **첫 마이그레이션** — 러너 자체에 버그가 있으면 기존 보드 데이터가 손상된다.
  트랜잭션으로 감싸고, 적용 전 `todo.db` 를 `todo.db.bak-v<n>` 으로 복사한다.
- **숫자 우선 해석** — 8자 규칙으로 갈랐지만, 향후 id 길이를 바꾸면 이 가정이 깨진다.
  `newId` 옆에 길이 상수를 두고 해석 로직이 그 상수를 참조하게 한다.
