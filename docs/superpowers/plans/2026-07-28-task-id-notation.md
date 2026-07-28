# task id 표기 `board-N` 전환 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 보드 항목의 사람이 읽는 참조를 `rocky#12` 에서 `rocky-12` 로 바꾸고(글로벌 메모는 `note-3`), 웹 UI 복사 버튼이 `/rocky-todo:board <ref>` 슬래시 커맨드를 클립보드에 넣게 하며, 레포에 남는 텍스트에 task id 를 적지 않는다는 지침을 문서화한다.

**Architecture:** 파싱(입력)을 먼저 넓히고, 그다음 직렬화(출력)를 뒤집는다. 이 순서여야 각 태스크가 자기 힘으로 초록이 된다 — 출력을 먼저 바꾸면 REST/MCP/CLI 의 왕복 테스트가 파싱이 따라오기 전까지 전부 빨개진다. 파싱은 `TodoStore.resolveRef` 의 분기 하나 추가, 직렬화는 `refOf` 한 곳, 복사는 `src/ui/lib.ts` 의 새 순수 함수 하나. DB 스키마와 번호 발급은 건드리지 않는다.

**Tech Stack:** TypeScript + Bun (`bun:sqlite`, `bun:test`), React 웹 UI, Biome.

## Global Constraints

- **설계 스펙**: `docs/superpowers/specs/2026-07-28-task-id-notation-design.md`. 충돌하면 스펙이 이긴다.
- **게이트**: 모든 태스크의 마지막은 `bun run check` · `bun run typecheck` · `bun run test` 통과다. `bun test` 를 맨손으로 부르지 않는다 — 단일 파일 실행은 아래 각 스텝의 명령을 그대로 쓴다.
- **Import 규칙**: 전부 상대경로, 확장자 없음(`./refs`). `__dirname` 금지 — `import.meta.dir`.
- **신규 런타임 dependency 금지.** 이 플랜은 dependency 를 추가하지 않는다.
- **삭제 없음** — 기존 `#` 표기 테스트는 지우지 않고 "구 표기 입력" 케이스로 남긴다.
- **JSDoc**: exported 함수/클래스에 한국어 주석. 코드 식별자·경로·명령·URL 은 영어 원형.
- **커밋 메시지**: Conventional Commits, `type(scope): 한국어 요약`. **task id 를 커밋 메시지에 넣지 않는다** (이 플랜이 도입하는 규칙을 이 플랜부터 지킨다).
- **표기 규칙 (전 표면 공통)**:
  - 보드 항목 참조 = `<board-key>-<number>` (예: `rocky-12`)
  - 글로벌 메모 참조 = `note-<number>` (예: `note-3`)
  - 리스트/행처럼 같은 보드가 반복되는 자리 = 맨 번호(`12`), `#` 없이
  - 상세 화면·title·aria-label = 완전 참조(`rocky-12`)
  - 클립보드 = `/rocky-todo:board rocky-12`

## File Structure

| 파일 | 책임 | 변경 |
| --- | --- | --- |
| `src/refs.ts` | 참조 직렬화(`refOf`/`withRef`), board key 안전성 판별, 글로벌 메모 접두사 상수 | 수정 |
| `src/store.ts` | `resolveRef` 파싱 분기, `ensureBoard` key 검증 | 수정 |
| `src/ui/lib.ts` | `boardCommand` — 참조를 슬래시 커맨드로 감싸는 순수 함수 | 수정 |
| `src/ui/components/TodoItem.tsx` · `NotesRail.tsx` · `DetailDrawer.tsx` | 복사 페이로드 + 버튼 표시 문자열 | 수정 |
| `src/mcp.ts` · `src/cli.ts` | 도구 description · CLI help/출력의 표기 | 수정 |
| `skills/board/SKILL.md` · `AGENTS.md` | 에이전트 지침 | 수정 |
| `FEATURES.md` · `README.md` · `docs/rocky-todo.md` | 사용자 문서 | 수정 |

`GLOBAL_NOTE_PREFIX` 는 `src/refs.ts` 에 둔다 — `store.ts` 가 이미 `import { refOf } from './refs'` 를 하고 `refs.ts` 는 store 에서 **타입만** 가져오므로 런타임 순환이 생기지 않는다.

---

### Task 1: `resolveRef` 에 `-` 스코프 분기를 추가한다 (입력 수용)

순수 추가다. 기존 `#` 분기와 맨숫자 분기는 손대지 않으므로 이 태스크 뒤에도 기존 테스트가 전부 그대로 통과해야 한다.

**Files:**
- Modify: `src/refs.ts` (상수 추가)
- Modify: `src/store.ts:1620` 부근 (`resolveRef` 의 레거시 스코프 분기 직후)
- Test: `src/store.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces: `GLOBAL_NOTE_PREFIX: string` (`'note'`) — `src/refs.ts` 에서 export. Task 2·3 이 쓴다.
  `TodoStore.getTodo(ref, currentBoardId?)` / `getNote(ref, currentBoardId?)` 의 시그니처는 변하지 않는다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src/store.test.ts` 의 `describe('ref 해석', ...)`(현재 590행 부근, `'rocky#12 형태로 보드를 지정해 찾는다'` 테스트가 있는 블록) 안에 아래를 추가한다:

```ts
  test('rocky-12 형태(신규 표기)로 보드를 지정해 찾는다', () => {
    const t = store.createTodo({ board: 'rocky', title: '신규 표기' }, 'tester');
    expect(store.getTodo(`rocky-${t.number}`)?.id).toBe(t.id);
  });

  // board key 에 `-` 가 흔하다(`rocky-todo`). greedy 파싱이 **가장 오른쪽** `-` 에서
  // 갈라야 `rocky-todo-1` 이 보드 `rocky-todo` 의 1번으로 읽힌다 — 왼쪽에서 자르면
  // 존재하지 않는 보드 `rocky` 를 찾다 undefined 가 된다.
  test('board key 에 `-` 가 있어도 가장 오른쪽 `-` 에서 갈린다', () => {
    const t = store.createTodo({ board: 'rocky-todo', title: '하이픈 보드' }, 'tester');
    expect(store.getTodo(`rocky-todo-${t.number}`)?.id).toBe(t.id);
  });

  test('없는 보드를 가리키는 신규 표기는 undefined 다', () => {
    store.createTodo({ board: 'rocky', title: '있음' }, 'tester');
    expect(store.getTodo('no-such-board-1')).toBeUndefined();
  });

  // `note-N` 은 언제나 전역 메모 번호 공간이다 — 보드 컨텍스트를 줘도 무시한다.
  test('note-N 은 전역 메모를 가리키고 board 컨텍스트를 무시한다', () => {
    const board = store.ensureBoard('rocky', { actor: 'tester' });
    const globalNote = store.createNote({ title: '전역 메모' }, 'tester');
    expect(store.getNote(`note-${globalNote.number}`)?.id).toBe(globalNote.id);
    expect(store.getNote(`note-${globalNote.number}`, board.id)?.id).toBe(globalNote.id);
  });

  test('note-N 은 todos 에서는 풀리지 않는다 (전역 todo 번호 공간은 없다)', () => {
    store.createTodo({ board: 'rocky', title: '있음' }, 'tester');
    expect(store.getTodo('note-1')).toBeUndefined();
  });

  // 구 표기는 입력으로 계속 받는다 — 대화·댓글·히스토리에 이미 박혀 있다.
  test('구 표기 rocky#12 는 계속 풀린다', () => {
    const t = store.createTodo({ board: 'rocky', title: '구 표기' }, 'tester');
    expect(store.getTodo(`rocky#${t.number}`)?.id).toBe(t.id);
  });
```

- [ ] **Step 2: 실패를 확인한다**

Run: `bun test src/store.test.ts -t "신규 표기"`
Expected: FAIL — `store.getTodo('rocky-1')` 이 신규 분기 없이 id-prefix 분기까지 흘러가 `undefined` 를 돌려준다.

- [ ] **Step 3: `GLOBAL_NOTE_PREFIX` 를 추가한다**

`src/refs.ts` 의 `import` 아래, `isRefSafeBoardKey` 위에 넣는다:

```ts
/**
 * 보드에 속하지 않는 글로벌 메모의 참조 접두사 — `note-3`.
 *
 * 구분자가 `-` 가 되면서 접두사 없는 참조를 `-3` 으로 쓸 수 없게 됐다(음수로 읽힌다).
 * 그래서 전역 번호 공간에 이름을 붙였다. 이 접두사는 **예약어**다: `note` 라는 이름의
 * 보드를 새로 만들 수 없고(`TodoStore.ensureBoard`), `note-N` 은 board 컨텍스트와
 * 무관하게 언제나 전역 메모를 가리킨다(`TodoStore.resolveRef`).
 *
 * `store.ts` 가 이 값을 import 해도 순환이 되지 않는다 — 이 모듈은 store 에서
 * **타입만** 가져오기 때문이다(파일 상단 주석 참고).
 */
export const GLOBAL_NOTE_PREFIX = 'note';
```

- [ ] **Step 4: `resolveRef` 에 신규 분기를 넣는다**

`src/store.ts` 상단의 import 를 바꾼다:

```ts
import { GLOBAL_NOTE_PREFIX, refOf } from './refs';
```

그리고 `resolveRef` 안, 레거시 스코프 분기(`const scoped = /^([^#\s]+)#(\d+)$/...` 블록)가 끝난 **직후**, `const bare = ...` 줄 **앞에** 아래를 삽입한다:

```ts
    // 신규 스코프 표기 `<board>-<number>` (`rocky-12`). `\S+` 가 greedy 라 **가장
    // 오른쪽** `-` 에서 갈린다 — board key 에 `-` 가 흔해서(`rocky-todo`) 왼쪽에서
    // 자르면 존재하지 않는 보드를 찾게 된다. 공백을 배제하는 이유는 위 레거시 분기의
    // `[^#\s]+` 와 같다: 공백 든 레거시 보드는 스코프 참조로 가리킬 수 없고 raw id 로
    // 폴백한다(`refOf` 의 `isRefSafeBoardKey` 게이트).
    //
    // id 분기를 잡아먹지 않는다 — id 는 base36 8자(`ID_ALPHABET`)라 `-` 를 못 담는다.
    const dashed = /^(\S+)-(\d+)$/.exec(trimmed);
    if (dashed?.[1] && dashed[2]) {
      const number = Number(dashed[2]);
      if (dashed[1] === GLOBAL_NOTE_PREFIX) {
        // 예약 접두사가 board 조회보다 먼저다 — `note` 라는 이름의 레거시 보드가
        // 있어도 `note-3` 은 전역 메모를 가리킨다(결정론). 그 보드의 항목은 raw id 로만
        // 가리킬 수 있고, `refOf` 도 그 보드에는 raw id 를 내보낸다.
        if (table !== 'notes') {
          // 전역 todo 번호 공간은 존재하지 않는다 — todos 는 언제나 보드에 속한다.
          return undefined;
        }
        return (
          this.db
            .query<Row, [number]>(`SELECT * FROM ${table} WHERE board_id IS NULL AND number = ?`)
            .get(number) ?? undefined
        );
      }
      const board = this.db
        .query<{ id: string }, [string]>('SELECT id FROM boards WHERE key = ?')
        .get(dashed[1]);
      if (board) {
        return (
          this.db
            .query<Row, [string, number]>(`SELECT * FROM ${table} WHERE board_id = ? AND number = ?`)
            .get(board.id, number) ?? undefined
        );
      }
      // 보드를 못 찾으면 여기서 끝내지 않고 아래 id/id-prefix 분기로 흘려보낸다 —
      // `-` 를 담은 문자열이 유효한 id 일 수는 없지만, 이 분기가 조기 return 하면
      // 나중에 참조 문법이 늘 때 조용한 사각지대가 된다. 흘려보내면 최악이 undefined 다.
    }
```

- [ ] **Step 5: 테스트 통과를 확인한다**

Run: `bun test src/store.test.ts`
Expected: PASS — 신규 6개 테스트 포함, 기존 테스트 전부 그대로 초록.

- [ ] **Step 6: 참조 해석 계약 테스트가 여전히 맞는지 확인한다**

Run: `bun test src/refs.test.ts`
Expected: PASS. `refNeedsBoardContext` 는 맨숫자 분기만 판별하고 신규 스코프 참조는 board 컨텍스트를 안 쓰므로 이 태스크에서 바뀌지 않는다. 여기가 빨개지면 Step 4 의 분기를 맨숫자 분기 **앞**이 아니라 뒤에 넣었거나 정규식이 맨숫자를 삼킨 것이다.

- [ ] **Step 7: 전체 게이트**

Run: `bun run check && bun run typecheck && bun run test`
Expected: 셋 다 PASS.

- [ ] **Step 8: 커밋**

```bash
git add src/refs.ts src/store.ts src/store.test.ts
git commit -m "feat(refs): board-N 표기를 참조 해석에 추가한다"
```

---

### Task 2: `ensureBoard` 가 새 보드 key `note` 를 거부한다

**Files:**
- Modify: `src/store.ts` (`ensureBoard` 의 key 검증 블록, 현재 `key.includes('#')` 검사 직후)
- Test: `src/store.test.ts`

**Interfaces:**
- Consumes: `GLOBAL_NOTE_PREFIX` (Task 1)
- Produces: 없음 (동작 변경만)

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src/store.test.ts` 의 `test("ensureBoard rejects a key containing '#'", ...)`(58행 부근) 바로 아래에 추가한다:

```ts
  // `note` 는 전역 메모 참조(`note-3`)의 예약 접두사다 — 같은 이름의 보드가 생기면
  // `note-3` 이 두 행(전역 메모 3번 / 그 보드의 3번)을 가리키는 모호한 참조가 된다.
  test('ensureBoard rejects the reserved key "note"', () => {
    expect(() => store.ensureBoard('note', { actor: 'tester' })).toThrow(/reserved/i);
  });

  // 예약어는 정확히 일치할 때만이다 — `notes`/`note-taking` 은 멀쩡한 보드 이름이고
  // `notes-1` 은 greedy 파싱이 보드 `notes` 로 정확히 읽는다.
  test('ensureBoard allows keys that merely start with "note"', () => {
    expect(() => store.ensureBoard('notes', { actor: 'tester' })).not.toThrow();
    expect(() => store.ensureBoard('note-taking', { actor: 'tester' })).not.toThrow();
  });
```

- [ ] **Step 2: 실패를 확인한다**

Run: `bun test src/store.test.ts -t "reserved"`
Expected: FAIL — `ensureBoard('note', ...)` 가 던지지 않고 보드를 만든다.

- [ ] **Step 3: 검증을 추가한다**

`src/store.ts` 의 `ensureBoard` 안, `if (key.includes('#')) { ... }` 블록 **직후**에 넣는다:

```ts
    if (key === GLOBAL_NOTE_PREFIX) {
      throw new Error(
        `board key ${JSON.stringify(key)} is reserved for global note refs (note-N)`,
      );
    }
```

- [ ] **Step 4: 테스트 통과를 확인한다**

Run: `bun test src/store.test.ts`
Expected: PASS. 검증이 CREATE 에만 걸리는 기존 구조는 그대로다 — 이미 존재하는 `note` 보드는 첫 `SELECT` 에서 반환되므로 이 검증에 닿지 않는다.

- [ ] **Step 5: 전체 게이트**

Run: `bun run check && bun run typecheck && bun run test`
Expected: 셋 다 PASS.

- [ ] **Step 6: 커밋**

```bash
git add src/store.ts src/store.test.ts
git commit -m "feat(store): 보드 키 note 를 전역 메모 참조 예약어로 막는다"
```

---

### Task 3: `refOf` 를 새 표기로 전환한다 (출력)

여기서 제품이 내보내는 참조 문자열이 전부 바뀐다. REST · MCP · CLI · 훅 · 웹 UI 가 한 함수를 통해 참조를 만들므로 변경 지점은 하나지만, 기대값을 박아둔 테스트가 여러 파일에 흩어져 있어 함께 고친다. **쪼갤 수 없다** — 출력이 바뀌는 순간 전부 같이 바뀐다.

**Files:**
- Modify: `src/refs.ts` (`isRefSafeBoardKey`, `refOf`, 파일 상단 JSDoc, `TodoView.ref`/`NoteView` 주석)
- Test: `src/refs.test.ts` · `src/store.test.ts` · `src/server.test.ts` · `src/mcp.test.ts` · `src/cli.test.ts` · `src/ui/test-support.tsx`

**Interfaces:**
- Consumes: `GLOBAL_NOTE_PREFIX` (Task 1)
- Produces: `refOf(store, boardId, number, id): string` — 시그니처 불변, 반환 문자열만 `<key>-<number>` / `note-<number>` / raw id 로 바뀐다. `isRefSafeBoardKey(key): boolean` — 시그니처 불변, `'note'` 를 추가로 거부한다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src/refs.test.ts` 의 `describe('isRefSafeBoardKey', ...)` 블록에 추가한다:

```ts
  test('예약어 `note` 는 불안전 (전역 메모 참조와 충돌)', () => {
    expect(isRefSafeBoardKey('note')).toBe(false);
  });

  test('`note` 로 시작할 뿐인 key 는 안전', () => {
    expect(isRefSafeBoardKey('notes')).toBe(true);
    expect(isRefSafeBoardKey('note-taking')).toBe(true);
  });
```

같은 파일 `describe('refOf / withRef — 레거시 malformed board key 폴백 (finding 1)', ...)` 안의 기존 두 테스트를 새 기대값으로 고친다:

```ts
  test('정상 board 는 영향 없음 — ref === "rocky-1" 이고 왕복된다', () => {
    const todo = store.createTodo({ board: 'rocky', title: '평범한 작업' }, 'tester');

    const view = withRef(store, todo);
    expect(view.ref).toBe('rocky-1');

    const resolved = store.getTodo(view.ref);
    expect(resolved?.id).toBe(todo.id);
  });

  test('글로벌 note 는 `note-N` 을 받는다', () => {
    const note = store.createNote({ title: '글로벌 메모' }, 'tester');

    const view = withRef(store, note);
    expect(view.ref).toBe(`note-${note.number}`);

    const resolved = store.getNote(view.ref);
    expect(resolved?.id).toBe(note.id);
  });
```

그리고 같은 블록에 레거시 `note` 보드 케이스를 추가한다:

```ts
  /**
   * `ensureBoard` 의 예약어 검증은 CREATE 에만 걸린다 — 검증 도입 전에 만들어진 `note`
   * 보드가 있을 수 있다. 그 보드의 항목에 `note-1` 을 내보내면 전역 메모 1번과 구분되지
   * 않는 위조 참조가 되므로 raw id 로 폴백해야 한다.
   */
  test('legacy `note` board key: ref 는 raw id 로 폴백하고 getTodo(ref) 가 왕복된다', () => {
    seedLegacyBoard('legacy-note-board', 'note');
    const todo = store.createTodo({ board: 'note', title: '레거시 note 보드 작업' }, 'tester');

    const view = withRef(store, todo);
    expect(view.ref).toBe(todo.id);
    expect(store.getTodo(view.ref)?.id).toBe(todo.id);
  });
```

`describe('withRef comment stats', ...)` 의 note 기대값도 고친다:

```ts
    expect(view.ref).toBe(`rocky-${note.number}`);
```

- [ ] **Step 2: 실패를 확인한다**

Run: `bun test src/refs.test.ts`
Expected: FAIL — `expected "rocky-1", received "rocky#1"` 류.

- [ ] **Step 3: `isRefSafeBoardKey` 와 `refOf` 를 고친다**

`src/refs.ts` 의 두 함수를 아래로 교체한다 (JSDoc 포함):

```ts
/**
 * board key 가 `resolveRef` 의 신규 스코프 정규식(`^(\S+)-(\d+)$`)이 되읽을 수 있는
 * `<key>-<number>` 를 만들 수 있는 모양인지 판별한다. `refNeedsBoardContext` 와 같은
 * 방식으로 `resolveRef` 의 조건을 손으로 옮긴 predicate 다(공유는 안 하고 계약 테스트로
 * 고정).
 *
 * 거르는 것은 셋이다:
 * - 빈 문자열 · 공백 포함 — 정규식의 `\S+` 가 못 받는다.
 * - `#` 포함 — 레거시 `#` 분기가 먼저 매칭돼 다른 뜻이 된다.
 * - `note` — 전역 메모 참조({@link GLOBAL_NOTE_PREFIX})의 예약 접두사라, 이 키로
 *   `note-1` 을 내보내면 전역 메모 1번과 구분되지 않는 참조가 된다.
 *
 * `ensureBoard` 는 board key 검증을 **새 보드 생성**에만 적용한다(`src/store.ts`) — 검증
 * 도입 전 구버전 데몬이 `my repo` 나 `note` 같은 키로 만들어둔 보드는 조회로 계속
 * 살아남는다. 그런 레거시 보드의 항목에 `refOf` 가 스스로 못 읽는(혹은 다른 행을 가리키는)
 * ref 를 내보내면 웹 UI 가 그대로 보여주고 복사해도 붙여넣기가 어긋난다 — 이 predicate 로
 * 그 경우를 감지해 `refOf` 가 raw id 로 폴백하게 한다.
 */
export function isRefSafeBoardKey(key: string): boolean {
  return key !== '' && !/[#\s]/.test(key) && key !== GLOBAL_NOTE_PREFIX;
}

/**
 * boardId + number 로 사람이 읽는 참조 문자열을 만든다 — `rocky-12`, 보드에 속하지 않는
 * 글로벌 메모는 `note-3`.
 *
 * 구분자로 `-` 를 쓰는 이유: 예전 표기 `rocky#12` 의 `#` 가 GitHub 이슈 번호와 겹쳐,
 * 보드가 이슈를 만들어 붙일 수 있는(`todo_write.createIssue`) 지금 한 항목에 두 종류의
 * `#N` 이 같이 나타나면 사람도 에이전트도 매번 되짚어야 했다.
 *
 * board key 가 {@link isRefSafeBoardKey} 를 만족하지 않으면(레거시 malformed key, 또는
 * 예약어 `note`) 못 읽거나 다른 행을 가리키는 문자열을 내보내는 대신 `id` 로 폴백한다 —
 * raw id 는 항상 `resolveRef` 의 id/id-prefix 분기로 되읽히므로 클릭 복사→붙여넣기
 * 왕복이 깨지지 않는다. 덜 예쁠 뿐이다.
 * @throws boardId 는 있는데 그 보드가 store 에 없으면(FK 가 깨진 상태) — 조용히
 *   `note-12` 같은 위조 참조를 만들면 다른(진짜 글로벌) 엔티티를 가리키는 것과
 *   구분이 안 돼 사고를 부르므로 명시적으로 실패시킨다.
 */
export function refOf(
  store: TodoStore,
  boardId: string | undefined,
  number: number,
  id: string,
): string {
  if (!boardId) {
    return `${GLOBAL_NOTE_PREFIX}-${number}`;
  }
  const key = store.boardKeyOf(boardId);
  if (key === undefined) {
    throw new Error(`cannot build ref: board not found for boardId ${boardId}`);
  }
  if (!isRefSafeBoardKey(key)) {
    return id;
  }
  return `${key}-${number}`;
}
```

`src/refs.ts` 상단의 `TodoView.ref` / `NoteView` 주석도 새 예시로 고친다:

```ts
/** 응답 전용 todo — 저장 모델에 사람이 쓰는 참조(ref)와 댓글 집계를 얹은 형태. */
export interface TodoView extends Todo {
  /** `rocky-12` — 보드 접두사를 포함한 완전 참조. */
  ref: string;
```

```ts
/** 응답 전용 note. 글로벌 메모는 보드 대신 예약 접두사가 붙어 `note-3` 이 된다. */
export interface NoteView extends Note {
```

파일 상단 모듈 JSDoc 의 `(`rocky#12`)` 도 `(`rocky-12`)` 로 고친다.

- [ ] **Step 4: `refs.test.ts` 통과를 확인한다**

Run: `bun test src/refs.test.ts`
Expected: PASS.

- [ ] **Step 5: 나머지 테스트의 기대값을 고친다**

먼저 어디가 깨지는지 본다:

Run: `bun run test:unit`
Expected: FAIL — 아래 파일들.

각 파일에서 **`ref` 값 기대값만** 고친다. `id` 인자로 넘기는 `rocky#1`·`#1` 은 구 표기 입력 케이스라 **그대로 둔다**(Task 1 이 계속 받는다).

`src/store.test.ts`:
```ts
// 862행 부근
    expect(claimed?.todoRef).toBe('rocky-todo-1');
```

`src/server.test.ts` — 337 · 349 · 358 · 368 · 394 행의 `'rocky#1'` 을 `'rocky-1'` 로, 373 행의 `'#1'` 을 `'note-1'` 로.
```ts
    expect(todo.ref).toBe('rocky-1');
    expect(body.todo.ref).toBe('rocky-1');
    expect(list[0]?.ref).toBe('rocky-1');
    expect(boardNote.ref).toBe('rocky-1');
    expect(globalNote.ref).toBe('note-1');
    expect(body.todo.ref).toBe('rocky-1');
```

`src/mcp.test.ts` — 466 · 488 · 504 · 512 · 522 · 535 행의 `'rocky#1'` 을 `'rocky-1'` 로, 489 행을 `'other-1'` 로, 530 행을 `'note-1'` 로. 515 행의 테스트 제목도 고친다:
```ts
  test('보드 소속 메모는 rocky-1, 글로벌 메모는 note-1 로 ref 가 구분된다', async () => {
```

`src/cli.test.ts` — 325 · 405 행의 픽스처 `ref: 'rocky#1'` 을 `'rocky-1'` 로, 351 행을 `'rocky-12'` 로. `todoRefPath`/`noteRefPath` 를 검증하는 테스트(114-119 · 552 · 562 · 575 · 722 행)는 **구 표기 인코딩 계약**이라 그대로 둔다. 645 · 657 · 671 행의 `formatSpawnResult('rocky#12', ...)` 는 `'rocky-12'` 로 바꾸고 651 · 662 행의 `toContain` 도 같이 바꾼다.

`src/ui/test-support.tsx`:
```ts
    ref: 'rocky-todo-1',
```

- [ ] **Step 6: 전체 테스트 통과를 확인한다**

Run: `bun run test`
Expected: PASS (unit + dom 양쪽).

- [ ] **Step 7: 전체 게이트**

Run: `bun run check && bun run typecheck && bun run test`
Expected: 셋 다 PASS.

- [ ] **Step 8: 커밋**

```bash
git add src/refs.ts src/refs.test.ts src/store.test.ts src/server.test.ts src/mcp.test.ts src/cli.test.ts src/ui/test-support.tsx
git commit -m "feat(refs): 참조 직렬화를 board-N / note-N 으로 바꾼다"
```

---

### Task 4: 웹 UI — 슬래시 커맨드 복사 + 표시에서 `#` 제거

**Files:**
- Modify: `src/ui/lib.ts` (`boardCommand` 추가)
- Modify: `src/ui/components/TodoItem.tsx:37,60` · `src/ui/components/NotesRail.tsx:62,73` · `src/ui/components/DetailDrawer.tsx:119,618`
- Test: `src/ui/lib.test.ts` · `src/ui/components/TodoItem.test.tsx`

**Interfaces:**
- Consumes: `copyRefWithFeedback(ref, onCopied, env?)` (기존), `TodoView.ref` = `rocky-12` (Task 3)
- Produces: `boardCommand(ref: string): string` — `src/ui/lib.ts` 에서 export.

- [ ] **Step 1: `boardCommand` 의 실패하는 테스트를 쓴다**

`src/ui/lib.test.ts` 맨 끝에 추가하고, 파일 상단 import 에 `boardCommand` 를 넣는다:

```ts
describe('boardCommand', () => {
  test('참조를 보드 스킬 슬래시 커맨드로 감싼다', () => {
    expect(boardCommand('rocky-12')).toBe('/rocky-todo:board rocky-12');
  });

  test('글로벌 메모 참조도 같은 모양이다', () => {
    expect(boardCommand('note-3')).toBe('/rocky-todo:board note-3');
  });

  // 레거시 malformed board key 의 항목은 ref 가 raw id 로 폴백한다(`refOf`) — 그것도
  // 그대로 감싼다. 스킬은 raw id 도 참조 문법으로 받는다.
  test('raw id 폴백 ref 도 그대로 감싼다', () => {
    expect(boardCommand('921gvwnr')).toBe('/rocky-todo:board 921gvwnr');
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `bun test src/ui/lib.test.ts -t "boardCommand"`
Expected: FAIL — `boardCommand` 를 export 하지 않아 import 에서 깨진다.

- [ ] **Step 3: `boardCommand` 를 구현한다**

`src/ui/lib.ts` 의 `COPY_FEEDBACK_MS` 선언 **위**에 넣는다:

```ts
/** 보드 스킬의 슬래시 커맨드 이름 — 플러그인 `rocky-todo` 의 `skills/board`. */
const BOARD_SKILL_COMMAND = '/rocky-todo:board';

/**
 * 참조를 클립보드에 넣을 슬래시 커맨드로 감싼다 — `rocky-12` → `/rocky-todo:board rocky-12`.
 *
 * 참조만 복사하면 세션에 붙여넣었을 때 에이전트가 "이 문자열로 뭘 하라는 건지" 를 모른다.
 * 커맨드까지 함께 복사하면 붙여넣기 한 번이 곧 "이 항목을 맡아라" 가 된다. 화면에 보이는
 * 글자는 참조 그대로 두고 클립보드 값만 넓히는 것이 요점이다 — 버튼에 커맨드 전문을
 * 그리면 행이 읽히지 않는다.
 */
export function boardCommand(ref: string): string {
  return `${BOARD_SKILL_COMMAND} ${ref}`;
}
```

- [ ] **Step 4: 테스트 통과를 확인한다**

Run: `bun test src/ui/lib.test.ts`
Expected: PASS.

- [ ] **Step 5: 컴포넌트의 실패하는 렌더 테스트를 쓴다**

`src/ui/components/TodoItem.test.tsx` 맨 끝에 추가한다. 이 파일은 이미 `describe`/`expect`/`test`(`bun:test`), `screen`(`@testing-library/react`), `userEvent`, `todoFixture`, 그리고 로컬 헬퍼 `mountItem(todo, seenComments?)` 을 갖고 있다 — 새 import 는 필요 없다. `mountItem` 을 쓰는 이유: `TodoItem` 이 스토어의 `handoffs` 를 `.find` 로 읽어서 그 필드가 배열로 깔려 있어야 한다.

```tsx
describe('TodoItem 참조 복사 버튼', () => {
  test('클립보드에는 슬래시 커맨드가 들어가고 버튼에는 번호만 보인다', async () => {
    const written: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (t: string) => void written.push(t) },
    });

    mountItem(todoFixture({ number: 12, ref: 'rocky-12' }));

    const button = screen.getByRole('button', { name: 'rocky-12 복사' });
    expect(button.textContent).toBe('12');

    await userEvent.click(button);
    expect(written).toEqual(['/rocky-todo:board rocky-12']);
  });
});
```

- [ ] **Step 6: 실패를 확인한다**

Run: `bun test --preload ./src/ui/happydom.ts src/ui/components/TodoItem.test.tsx`
Expected: FAIL — 버튼 텍스트가 `#12` 이고 클립보드에는 `rocky-12` 만 들어간다.

- [ ] **Step 7: 네 복사 호출부와 두 표시 지점을 고친다**

`src/ui/components/TodoItem.tsx` — import 에 `boardCommand` 추가, 37행과 60행:
```ts
  const handleCopyRef = () => copyRefWithFeedback(boardCommand(todo.ref), setCopied);
```
```tsx
        {copied ? '✓' : todo.number}
```

`src/ui/components/NotesRail.tsx` — import 에 `boardCommand` 추가, 60-62행의 주석과 호출:
```ts
  // 글로벌 메모는 note.ref 가 `note-3` 으로 오고 보드 메모는 `rocky-3` 으로 온다 —
  // 어느 쪽이든 boardCommand 가 그대로 감싸므로 별도 분기가 없다.
  const handleCopyRef = () => copyRefWithFeedback(boardCommand(note.ref), setCopied);
```
그리고 73행:
```tsx
          {copied ? '✓' : note.number}
```

`src/ui/components/DetailDrawer.tsx` — import 에 `boardCommand` 추가, 119행과 618행:
```ts
  const handleCopyRef = () => copyRefWithFeedback(boardCommand(todo.ref), setCopied);
```
```ts
  // 글로벌 메모는 note.ref 가 `note-3` 으로 오고 보드 메모는 `rocky-3` 으로 온다 —
  // 어느 쪽이든 boardCommand 가 그대로 감싸므로 별도 분기가 없다.
  const handleCopyRef = () => copyRefWithFeedback(boardCommand(note.ref), setCopied);
```

DetailDrawer 의 195 · 629 행(`{copied ? '✓' : todo.ref}` / `{copied ? '✓' : note.ref}`)은 **그대로 둔다** — 상세는 완전 참조를 보여주는 자리다.

- [ ] **Step 8: 렌더 테스트 통과를 확인한다**

Run: `bun test --preload ./src/ui/happydom.ts src/ui/components/TodoItem.test.tsx`
Expected: PASS.

- [ ] **Step 9: 전체 게이트**

Run: `bun run check && bun run typecheck && bun run test`
Expected: 셋 다 PASS.

- [ ] **Step 10: 커밋**

```bash
git add src/ui/lib.ts src/ui/lib.test.ts src/ui/components/
git commit -m "feat(ui): 참조 복사에 보드 스킬 슬래시 커맨드를 함께 넣는다"
```

---

### Task 5: MCP 도구 description 과 CLI 표기를 갱신한다

에이전트가 실제로 읽는 문자열이다. 여기가 옛 표기로 남으면 도구가 `#12` 를 쓰라고 지시하면서 응답은 `rocky-12` 를 돌려주는 모순이 된다.

**Files:**
- Modify: `src/mcp.ts:85,91,96,134,140,146,245,247,248,268,274,281,310,316,322` 및 49-55행 주석
- Modify: `src/cli.ts:95,99,343-350` 및 354-390행 주석
- Test: `src/mcp.test.ts:88` · `src/cli.test.ts:342,366,367`

**Interfaces:**
- Consumes: 없음 (문자열만)
- Produces: 없음

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src/mcp.test.ts` 의 82-90행 회귀 테스트는 **그대로 둔다** — `not.toMatch` 인 부정 단언이라 새 설명에서도 계속 참이다. 같은 `describe('surface', ...)` 블록 끝에 아래를 추가한다:

```ts
  // 전역 메모는 이제 `note-3` 으로 자기를 설명한다 — 도구 설명이 그 표기를 알려줘야
  // 에이전트가 board 인자 유무로 다른 행을 잡는 옛 함정을 애초에 피할 수 있다.
  test('note 도구 설명은 전역 메모 표기 note-N 을 알려준다', async () => {
    const { tools } = await client.listTools();
    for (const name of ['note_list', 'note_write'] as const) {
      const tool = tools.find((t) => t.name === name);
      expect(tool?.description).toMatch(/note-N/);
    }
  });
```

`src/cli.test.ts` 의 `formatTodoLine` 테스트 두 개를 고친다. 339행 테스트(`'todo status glyph and number prefix'`)의 342행:

```ts
    expect(line).toContain('○ 1 ');
```

344행 테스트는 제목과 픽스처 `ref`, 그리고 366-367행 단언을 함께 고친다:

```ts
  test('번호를 접두사 없이 앞에 붙인다', () => {
```
```ts
        ref: 'rocky-12',
```
```ts
    expect(line).toContain('12');
    expect(line.indexOf('12')).toBeLessThan(line.indexOf('보드·섹션 생성'));
```

- [ ] **Step 2: 실패를 확인한다**

Run: `bun test src/mcp.test.ts src/cli.test.ts`
Expected: FAIL — description 정규식 불일치, `formatTodoLine` 이 아직 `#12` 를 낸다.

- [ ] **Step 3: `formatTodoLine` 에서 `#` 를 뺀다**

`src/cli.ts:95` 의 JSDoc 과 99행을 고친다. `padEnd(3)` 은 유지하고 `#` 만 뺀다 — 번호 열이 한 칸 좁아지는 것 외에 정렬은 그대로다:

```ts
/** `○ 12  제목 p1 [label] ~due ↗link (doingBy 12분)` 한 줄. depth 는 2칸 들여쓰기. */
```
```ts
    String(todo.number).padEnd(3),
```

- [ ] **Step 4: CLI help 를 고친다**

`src/cli.ts:343-350` 의 REF 설명 블록을 아래로 교체한다:

```
REF 는 12 (현재 보드) 또는 rocky-12 (보드 지정) 또는 raw id 를 받는다.
보드 키는 생략 시 cwd 의 git repo 이름으로 유추한다. actor 는 --actor >
ROCKY_TODO_ACTOR > 호스트 자동 감지. 삭제는 없다 — 아카이브만 존재한다.
note show/edit/append/archive 의 맨 번호(12)는 기본적으로 todos 와 동일하게 현재 보드
컨텍스트로 풀린다 — 전역 메모를 번호로 가리키려면 note-3 처럼 접두사를 붙이거나
--global 을 붙인다. 둘 다 없으면 같은 번호의 보드 메모가 대신 잡힐 수 있다(모호성 회피).
옛 표기(rocky#12 / #12)도 계속 받는다 — 다만 bash 에서 #12 는 주석 시작 문자라
따옴표가 필요하다: rocky-todo show '#12'
```

354-390행의 `withBoard` · `todoRefPath` · `noteRefPath` JSDoc 에서 예시로 쓰인 `rocky#12`/`#3` 은 `rocky-12`/`note-3` 으로 고치되, **`#` 를 URL 인코딩해야 하는 이유를 설명하는 문장은 그대로 둔다** — 구 표기 입력이 여전히 들어오므로 그 인코딩은 계속 필요하다.

- [ ] **Step 5: MCP description 을 고친다**

`src/mcp.ts` 의 도구 설명·필드 설명에서 참조 문법 예시를 바꾼다. 기계적 치환이 아니라 아래 규칙을 적용한다:

- `#12` (맨숫자) → `12`
- `rocky#12` (스코프) → `rocky-12`
- `"#N"`/`#N` (전역 메모) → `note-N`
- `맨숫자 #12` → `맨숫자 12`

예로 85행은 이렇게 된다:

```ts
        '공유 todo 보드 조회. board 로 보드 하나, 생략 시 전체. id 를 주면 해당 todo 상세 + 히스토리, boards:true 면 보드 목록. 필터: status / label / includeArchived. id 는 참조 문법(12, rocky-12, id, id prefix)을 받는다 — 맨숫자 12 로 조회하려면 board 를 함께 줘야 한다. 옛 표기(#12, rocky#12)도 계속 받는다.',
```

전역 메모를 경고하는 네 자리는 새 표기가 그 함정을 없앤다는 점을 반영하되 **경고 자체를 지우지 않는다** — 맨숫자 `3` 은 여전히 board 인자 유무로 다른 행을 가리킨다. 최종 문자열은 아래 그대로다.

268행 (`note_list` description):
```ts
        '스크래치패드/메모 조회. board 로 보드 소속, global:true 로 보드 미소속 메모 목록. id 를 주면 상세 + 히스토리. id 는 참조 문법(note-3, rocky-12, 12, id, id prefix)을 받는다. 전역(보드 미소속) 메모는 note-N 으로 지정하는 것이 가장 안전하다 — 이 접두사는 예약어라 board 인자와 무관하게 늘 전역 메모를 가리킨다. 반면 맨숫자 12 는 board 인자 유무로 완전히 다른 행이 된다: board 를 생략하면 전역 번호 공간, 주면 그 보드의 번호 공간이다. 옛 표기(#12, rocky#12)도 계속 받는다.',
```

274행 (`note_list` 의 `board` 필드):
```ts
            "board key — scopes id to that board's number space. A global note ref (note-3) ignores this argument; prefer note-N over a bare number when you mean a global note",
```

281행 (`note_list` 의 `id` 필드):
```ts
            "note ref — global note (note-3), board-scoped (rocky-12), bare number (12: GLOBAL note space when board is omitted, that board's space when board is given), or raw id",
```

310행 (`note_write` description):
```ts
        '스크래치패드/메모 작성. id 없으면 생성(title 필수), 있으면 수정. mode: set=content 교체(기본) / append=뒤에 이어붙임 / archive=보관 / unarchive=복원. 삭제는 없다. id 는 참조 문법(note-3, rocky-12, 12, id, id prefix)을 받는다. 전역(보드 미소속) 메모를 수정/보관하려면 note-N 으로 지정한다 — 예약 접두사라 board 인자와 무관하게 늘 전역 메모다. 맨숫자 12 는 board 인자 유무로 완전히 다른 행을 가리킨다: board 를 생략하면 전역 메모, 주면 그 보드의 같은 번호 메모가 대신 수정/보관된다(에러 없이 조용히). 옛 표기(#12, rocky#12)도 계속 받는다.',
```

316행 (`note_write` 의 `id` 필드):
```ts
            "omit to create; note ref — global note (note-3), board-scoped (rocky-12), bare number (12: GLOBAL note space when board is omitted, that board's space when board is given), or raw id — to update",
```

322행 (`note_write` 의 `board` 필드):
```ts
            'omit for a global note when creating; when updating, a note-N id already targets the global note space and ignores this — but a bare number needs this OMITTED to mean the global note, otherwise it resolves that board\'s own N (a different row)',
```

49-55행의 모듈 주석도 예시를 새 표기로 고친다.

- [ ] **Step 6: 테스트 통과를 확인한다**

Run: `bun test src/mcp.test.ts src/cli.test.ts`
Expected: PASS.

- [ ] **Step 7: 전체 게이트**

Run: `bun run check && bun run typecheck && bun run test`
Expected: 셋 다 PASS.

- [ ] **Step 8: 커밋**

```bash
git add src/mcp.ts src/cli.ts src/mcp.test.ts src/cli.test.ts
git commit -m "docs(mcp,cli): 참조 문법 안내를 새 표기로 갱신한다"
```

---

### Task 6: 보드 스킬과 AGENTS.md 지침

**Files:**
- Modify: `skills/board/SKILL.md` (표기 갱신 + 인자 절 신설 + 가드레일)
- Modify: `AGENTS.md` (번호 참조 절 + Output / communication 절)

**Interfaces:**
- Consumes: Task 4 가 복사하는 문자열 `/rocky-todo:board rocky-12`
- Produces: 없음

- [ ] **Step 1: SKILL.md 의 표기를 갱신한다**

`skills/board/SKILL.md` 의 "자주 쓰는 호출" 절(71-90행 부근)에서:
- `rocky#12` → `rocky-12`
- `#12`/`12` (현재 보드) → `12`
- 전역 메모 `#3` → `note-3`

"메모의 전역 번호 공간" 절(93-106행)은 **경고를 유지하되** `note-N` 표기가 그 함정을 없앤다는 것을 먼저 말한다:

```markdown
## 메모의 전역 번호 공간 (틀리면 엉뚱한 메모를 건드린다)

보드에 속하지 않는 전역 메모는 자체 번호 공간을 쓴다. 웹 UI 는 이걸 `note-3` 으로
보여준다 — `rocky-3`(rocky 보드의 3번 메모)과 **다른 행**이다.

`note-3` 을 그대로 `id` 에 넣으면 안전하다 — 이 접두사는 예약어라 `board` 인자와
무관하게 언제나 전역 메모를 가리킨다.

함정은 **맨숫자**다. `note_list`/`note_write` 에 `id: "3"` 와 함께 `board` 를 주면
그 보드의 3번 메모로 풀린다. 사용자가 접두사 없는 숫자만 줬고 전역 메모를 뜻하는 것
같으면 `board` 를 넣지 말고, 확신이 없으면 먼저 `note_list { id: "note-3" }` 로
조회해 제목이 사용자가 말한 것과 맞는지 확인한다.
```

- [ ] **Step 2: 인자로 참조가 들어오는 경우를 문서화한다**

`skills/board/SKILL.md` 의 "보드 결정" 절 뒤에 새 절을 넣는다:

```markdown
## 참조 하나만 인자로 들어온 경우

웹 UI 의 번호 버튼은 `/rocky-todo:board rocky-12` 를 클립보드에 넣는다. 그래서 이
스킬은 참조 하나만 달고 호출될 수 있다 — 그건 "이 항목을 맡아라" 라는 뜻이다.

1. `todo_list { id: "<참조>" }` 로 항목·히스토리·댓글을 읽는다. `note-N` 이면
   `note_list { id: "<참조>" }` 를 쓴다. 보드 접두사가 붙은 참조(`rocky-12`)는 todo
   로 먼저 조회하고, 없으면 note 로 시도한다.
2. 무엇을 해야 하는지 읽히면 아래 에티켓대로 `todo_status { action: "start" }` 로
   착수를 표시하고 시작한다.
3. 읽어도 무엇을 원하는지 모호하면 착수 표시를 하기 전에 사용자에게 묻는다 —
   start 는 "지금 내가 잡고 있다" 는 신호라 되돌리는 비용이 있다.
```

- [ ] **Step 3: SKILL.md 가드레일에 커밋/PR 지침을 넣는다**

`skills/board/SKILL.md` 의 "가드레일" 절에 항목을 추가한다:

```markdown
- **task id 를 레포에 남기지 않는다.** 커밋 메시지, PR 제목·본문, 브랜치명, 코드 주석,
  changeset 어디에도 `rocky-12` 같은 참조를 적지 않는다. 보드 번호는 사용자 로컬
  데몬의 것이라 레포를 보는 다른 사람에게는 해석 불가능하고, 보드가 재생성되면 번호가
  달라진다. 무엇을 왜 바꿨는지로 쓴다. 작업과 항목의 연결은 보드 쪽에 남긴다 — 댓글에
  PR URL 을 붙이거나 `links` 에 건다.
```

- [ ] **Step 4: AGENTS.md 를 갱신한다**

`AGENTS.md` 의 "번호 참조(ref)" 불릿을 새 문법으로 고쳐 쓴다:

```markdown
- **번호 참조(ref)**: todo/note 는 랜덤 id(`921gvwnr`, PK 로 유지) 외에 보드별 순번을 갖는다.
  id 를 받는 자리는 어디서든 `rocky-12`(보드 접두사) → `12`(현재 보드 컨텍스트 안의
  번호) → id 정확 일치 → id 유일 prefix 순으로 시도해 해석한다(`resolveRef` in
  `src/store.ts`). 구분자가 `-` 인 이유는 `#` 가 GitHub 이슈 번호와 겹쳐서다 — 보드는
  이슈를 만들어 붙일 수 있어 한 항목에 두 종류의 `#N` 이 나타날 수 있었다. 파싱은
  **가장 오른쪽** `-` 에서 갈린다(`rocky-todo-1` = 보드 `rocky-todo` 의 1번). 옛 표기
  `rocky#12`/`#12` 는 **입력으로만** 계속 받는다 — 제품이 내보내는 문자열은 전부 `-`
  형태다. notes 만 board 없이도 존재할 수 있어(글로벌 메모) 전역 번호 공간을 따로 갖고
  예약 접두사를 붙여 `note-3` 으로 렌더된다 — `note` 는 새 보드 key 로 쓸 수 없고,
  `note-N` 은 board 인자와 무관하게 늘 전역 메모다. todos 는 항상 보드에 속하므로 보드
  컨텍스트 없는 맨숫자는 에러다. 번호는 보드 안에서 `MAX(number)+1` 로 발급되어
  아카이브해도 회수(재사용)되지 않는다. **댓글은 이 번호 체계 밖이다** — 보드별
  순번 없이 댓글 id 로만 지정한다(`PATCH /api/comments/:id` 등). mutation 은 부모 todo 의
  히스토리(`entity: 'todo'`, action `comment`/`comment-edit`/`comment-archive`/
  `comment-unarchive`)로 기록되어 SSE·훅 주입 경로를 그대로 탄다.
  웹 UI 의 번호 버튼은 참조가 아니라 `/rocky-todo:board rocky-12` 슬래시 커맨드를
  복사한다(`boardCommand` in `src/ui/lib.ts`) — 붙여넣기 한 번이 곧 착수 요청이 된다.
```

`AGENTS.md` 의 "Output / communication" 절에 항목을 추가한다:

```markdown
- **task id 는 레포에 남기지 않는다** — 커밋 메시지, PR 제목·본문, 브랜치명, 코드 주석,
  changeset 어디에도 보드 참조(`rocky-12`)를 적지 않는다. 보드 번호는 사용자 로컬
  데몬의 것이라 레포를 보는 다른 사람에게는 해석 불가능하고, 보드가 재생성되면 번호가
  달라진다. 작업과 항목의 연결은 보드 쪽(댓글·`links`)에 남긴다.
```

- [ ] **Step 5: 게이트**

Run: `bun run check && bun run typecheck && bun run test`
Expected: 셋 다 PASS (문서만 바뀌었으므로 회귀가 없어야 한다).

- [ ] **Step 6: 커밋**

```bash
git add skills/board/SKILL.md AGENTS.md
git commit -m "docs(skill): 새 참조 표기와 레포 기재 금지 지침을 넣는다"
```

---

### Task 7: 사용자 문서 동기화와 changeset

**Files:**
- Modify: `FEATURES.md` · `README.md` · `docs/rocky-todo.md`
- Create: `.changeset/<자동 생성 이름>.md`

**Interfaces:**
- Consumes: 앞선 태스크들의 최종 표기
- Produces: 없음

- [ ] **Step 1: 남은 옛 표기를 찾는다**

Run: `rg -n 'rocky#|board#|#12|#3(?![0-9])' FEATURES.md README.md docs/rocky-todo.md`
Expected: 몇 줄이 나온다. `docs/superpowers/` 아래는 **건드리지 않는다** — 그 시점의 기록이다.

- [ ] **Step 2: 세 문서를 고친다**

찾은 줄의 참조 예시를 `rocky-12` / `note-3` / 맨숫자 `12` 로 바꾼다. `FEATURES.md` 에는 웹 UI 절에 아래 한 줄을 더한다:

```markdown
- 번호 버튼을 누르면 `/rocky-todo:board rocky-12` 가 클립보드에 들어간다 — 세션에
  그대로 붙여넣으면 그 항목을 맡아 착수한다.
```

- [ ] **Step 3: 남은 옛 표기가 없는지 확인한다**

Run: `rg -n 'rocky#' FEATURES.md README.md docs/rocky-todo.md AGENTS.md skills/`
Expected: 결과 없음, 또는 "옛 표기도 입력으로 받는다" 를 설명하는 문장만.

- [ ] **Step 4: changeset 을 만든다**

Run: `bunx changeset`
- bump: **minor** (사용자가 보는 참조 문자열이 바뀐다. 구 표기 입력은 계속 받으므로 breaking 은 아니다)
- 요약:
```
보드 항목의 참조 표기를 `rocky#12` 에서 `rocky-12` 로 바꿨다. GitHub 이슈 번호와
겹치던 `#` 를 없앤다. 보드에 속하지 않는 전역 메모는 `note-3` 으로 표기하며 `note` 는
보드 이름으로 쓸 수 없는 예약어가 됐다. 옛 표기(`rocky#12` / `#12`)는 입력으로 계속
받는다. 웹 UI 의 번호 버튼은 이제 `/rocky-todo:board rocky-12` 를 복사한다.
```

- [ ] **Step 5: 최종 게이트**

Run: `bun run check && bun run typecheck && bun run test`
Expected: 셋 다 PASS.

- [ ] **Step 6: 커밋**

```bash
git add FEATURES.md README.md docs/rocky-todo.md .changeset/
git commit -m "docs: 사용자 문서를 새 참조 표기로 동기화한다"
```

---

## 검수 체크리스트 (전 태스크 완료 후)

- [ ] `bun run check` · `bun run typecheck` · `bun run test` 통과
- [ ] `rg -n "'rocky#|\"rocky#|\`rocky#" src/ hooks/` — 남은 건 전부 "구 표기 입력" 테스트이거나 인코딩 계약 테스트여야 한다
- [ ] 데몬을 띄워 웹 UI 에서 번호 버튼을 눌러 클립보드에 `/rocky-todo:board <ref>` 가 들어가는지 육안 확인
- [ ] 이 플랜의 커밋 메시지 어디에도 보드 참조가 없다
