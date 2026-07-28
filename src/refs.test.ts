import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isRefSafeBoardKey, refNeedsBoardContext, withRef } from './refs';
import { ID_LENGTH, TodoStore } from './store';

/**
 * `refNeedsBoardContext` 는 `resolveRef` 의 맨숫자 분기 조건을 복붙한 predicate 다
 * (공유하는 건 `ID_LENGTH` 뿐). 둘이 어긋나면 오타난 board 인자가 조용히 다른 번호
 * 공간을 가리키는 wrong-row 사고로 이어진다 — 이 파일은 그 계약을 핀으로 고정한다.
 */

describe('refNeedsBoardContext — case-by-case', () => {
  test('맨숫자(# 없이) → board context 필요', () => {
    expect(refNeedsBoardContext('5')).toBe(true);
  });

  test('# 붙은 맨숫자 → board context 필요', () => {
    expect(refNeedsBoardContext('#5')).toBe(true);
  });

  describe('ID_LENGTH 경계', () => {
    const shorter = '1'.repeat(ID_LENGTH - 1);
    const exact = '1'.repeat(ID_LENGTH);
    const longer = '1'.repeat(ID_LENGTH + 1);

    test(`길이 ${ID_LENGTH - 1}(< ID_LENGTH) 순수 숫자, # 없음 → 필요`, () => {
      expect(refNeedsBoardContext(shorter)).toBe(true);
    });

    test(`길이 ${ID_LENGTH - 1}(< ID_LENGTH) 순수 숫자, # 있음 → 필요`, () => {
      expect(refNeedsBoardContext(`#${shorter}`)).toBe(true);
    });

    test(`길이 ${ID_LENGTH}(= ID_LENGTH) 순수 숫자, # 없음 → 불필요 (id 로 취급)`, () => {
      expect(refNeedsBoardContext(exact)).toBe(false);
    });

    test(`길이 ${ID_LENGTH}(= ID_LENGTH) 순수 숫자, # 있음 → 필요 (# 는 길이 무관하게 번호)`, () => {
      expect(refNeedsBoardContext(`#${exact}`)).toBe(true);
    });

    test(`길이 ${ID_LENGTH + 1}(> ID_LENGTH) 순수 숫자, # 없음 → 불필요`, () => {
      expect(refNeedsBoardContext(longer)).toBe(false);
    });

    test(`길이 ${ID_LENGTH + 1}(> ID_LENGTH) 순수 숫자, # 있음 → 필요`, () => {
      expect(refNeedsBoardContext(`#${longer}`)).toBe(true);
    });
  });

  test('스코프 ref (rocky#12) → 불필요', () => {
    expect(refNeedsBoardContext('rocky#12')).toBe(false);
  });

  test('raw id (숫자만은 아닌 base36) → 불필요', () => {
    expect(refNeedsBoardContext('9x2mfa07')).toBe(false);
  });

  test('id prefix (숫자만은 아닌 짧은 접두사) → 불필요', () => {
    expect(refNeedsBoardContext('9x2')).toBe(false);
  });

  test('맨숫자 앞뒤 공백은 trim 되어 여전히 필요', () => {
    expect(refNeedsBoardContext('   5   ')).toBe(true);
    expect(refNeedsBoardContext('  #5  ')).toBe(true);
  });

  describe('맨숫자로 취급되면 안 되는 모양들', () => {
    const notBareNumbers = ['#', '##1', '#1#', 'abc#', '1e5', '+1', '', '   '];
    for (const ref of notBareNumbers) {
      test(`${JSON.stringify(ref)} → 불필요`, () => {
        expect(refNeedsBoardContext(ref)).toBe(false);
      });
    }
  });
});

describe('refNeedsBoardContext — resolveRef 와의 일치(불변식)', () => {
  let dir: string;
  let store: TodoStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rocky-todo-refs-'));
    store = new TodoStore({ dbPath: join(dir, 'todo.db') });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * `refNeedsBoardContext(ref) === true` 는 정확히 board context 없이 `getTodo(ref)`
   * 를 호출했을 때 `resolveRef` 가 "board context required" 에러를 던지는 경우와
   * 일치해야 한다 — 그게 실제로 지켜야 하는 불변식이다 (throw 여부가 아니라 *그*
   * 에러인지까지 본다: `empty ref`/`invalid id prefix` 등 다른 이유로 던지는 경우는
   * board context 가 필요해서가 아니다).
   */
  function neededBoardContextInPractice(ref: string): boolean {
    try {
      store.getTodo(ref);
      return false;
    } catch (error) {
      return /board context required/.test((error as Error).message);
    }
  }

  const shorter = '1'.repeat(ID_LENGTH - 1);
  const exact = '1'.repeat(ID_LENGTH);
  const longer = '1'.repeat(ID_LENGTH + 1);

  const cases = [
    '5',
    '#5',
    shorter,
    `#${shorter}`,
    exact,
    `#${exact}`,
    longer,
    `#${longer}`,
    'rocky#12',
    '9x2mfa07',
    '9x2',
    '   5   ',
    '  #5  ',
    '#',
    '##1',
    '#1#',
    'abc#',
    '1e5',
    '+1',
    '',
    '   ',
  ];

  for (const ref of cases) {
    test(`${JSON.stringify(ref)}: predicate === 실제 resolveRef 동작`, () => {
      expect(refNeedsBoardContext(ref)).toBe(neededBoardContextInPractice(ref));
    });
  }
});

describe('isRefSafeBoardKey', () => {
  test('공백/`#` 없는 일반 key 는 안전', () => {
    for (const key of ['rocky', 'MyProject', '_private', 'a-b', '9x2mfa07']) {
      expect(isRefSafeBoardKey(key)).toBe(true);
    }
  });

  test('공백이 섞인 key 는 불안전', () => {
    expect(isRefSafeBoardKey('my repo')).toBe(false);
  });

  test('`#` 가 섞인 key 는 불안전', () => {
    expect(isRefSafeBoardKey('a#b')).toBe(false);
  });

  test('빈 key 는 불안전', () => {
    expect(isRefSafeBoardKey('')).toBe(false);
  });

  test('예약어 `note` 는 불안전 (전역 메모 참조와 충돌)', () => {
    expect(isRefSafeBoardKey('note')).toBe(false);
  });

  test('`note` 로 시작할 뿐인 key 는 안전', () => {
    expect(isRefSafeBoardKey('notes')).toBe(true);
    expect(isRefSafeBoardKey('note-taking')).toBe(true);
  });
});

describe('refOf / withRef — 레거시 malformed board key 폴백 + 예약어 `note` board key (finding 1)', () => {
  let dir: string;
  let store: TodoStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rocky-todo-refs-legacy-'));
    store = new TodoStore({ dbPath: join(dir, 'todo.db') });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * `ensureBoard` 의 key 검증은 CREATE 에만 걸린다(`src/store.ts`) — 검증 도입 전
   * 구버전 데몬이 만들어둔 malformed key 보드가 존재할 수 있고, public API 로는 더 이상
   * 재현 불가하므로 raw SQL 로 직접 심어 옛 상태를 흉내낸다(`src/store.test.ts` 의
   * "ensureBoard returns a pre-existing malformed-key board unchanged" 테스트와 동일 기법).
   */
  function seedLegacyBoard(id: string, key: string): void {
    const dbPath = join(dir, 'todo.db');
    const raw = new Database(dbPath);
    raw
      .query('INSERT INTO boards (id, key, title, created_at) VALUES (?, ?, ?, ?)')
      .run(id, key, key, new Date().toISOString());
    raw.close();
  }

  test('공백이 섞인 legacy board key: ref 는 raw id 로 폴백하고 getTodo(ref) 가 왕복된다', () => {
    seedLegacyBoard('legacy-space-board', 'my repo');
    const todo = store.createTodo({ board: 'my repo', title: '레거시 보드 작업' }, 'tester');

    const view = withRef(store, todo);
    expect(view.ref).toBe(todo.id);

    const resolved = store.getTodo(view.ref);
    expect(resolved?.id).toBe(todo.id);
  });

  test('`#` 가 섞인 legacy board key: ref 는 raw id 로 폴백하고 getTodo(ref) 가 왕복된다', () => {
    seedLegacyBoard('legacy-hash-board', 'a#b');
    const todo = store.createTodo({ board: 'a#b', title: '레거시 보드 작업' }, 'tester');

    const view = withRef(store, todo);
    expect(view.ref).toBe(todo.id);

    const resolved = store.getTodo(view.ref);
    expect(resolved?.id).toBe(todo.id);
  });

  /**
   * 빈 key 는 "보드를 못 찾음"과 같은 값(옛 `boardKeyOf` 의 `''`)으로 뭉개지기 쉬운데,
   * 그러면 throw 로 막혀 raw id 폴백에 닿지 못하고 그 보드의 응답 직렬화 전체가 4xx 가
   * 된다. 빈 key 도 malformed key 의 한 종류라 폴백 대상이어야 한다.
   */
  test('빈 legacy board key: throw 하지 않고 raw id 로 폴백한다', () => {
    seedLegacyBoard('legacy-empty-board', '');
    const raw = new Database(join(dir, 'todo.db'));
    const todo = store.createTodo({ board: 'placeholder', title: '빈 key 보드 작업' }, 'tester');
    // createTodo 는 빈 key 보드를 만들 수 없으므로, 만든 항목을 그 보드로 옮겨 심는다.
    raw.query('UPDATE todos SET board_id = ? WHERE id = ?').run('legacy-empty-board', todo.id);
    raw.close();

    const moved = store.getTodo(todo.id);
    if (!moved) {
      throw new Error('fixture broken');
    }
    const view = withRef(store, moved);
    expect(view.ref).toBe(todo.id);
    expect(store.getTodo(view.ref)?.id).toBe(todo.id);
  });

  test('보드 자체가 없으면(FK 손상) 위조 ref 대신 명시적으로 실패한다', () => {
    const todo = store.createTodo({ board: 'rocky', title: 'FK 확인' }, 'tester');
    const raw = new Database(join(dir, 'todo.db'));
    raw.query('UPDATE todos SET board_id = ? WHERE id = ?').run('no-such-board', todo.id);
    raw.close();

    const orphan = store.getTodo(todo.id);
    if (!orphan) {
      throw new Error('fixture broken');
    }
    expect(() => withRef(store, orphan)).toThrow(/board not found/);
  });

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

  /**
   * `note` 는 legacy 가 아니다 — `ensureBoard` 는 `note` 라는 key 의 board 생성을 막지
   * 않는다(레포 이름이 `note` 인 사용자를 브릭시키지 않으려는 의도적 설계, `api`/`mcp`
   * 와 같은 원칙). 그래서 위의 malformed-key 테스트들과 달리 `seedLegacyBoard` 로 옛
   * 상태를 흉내낼 필요가 없다 — public API(`createTodo`)만으로 지금 바로 재현된다.
   *
   * `note-3` 이 항상 전역 메모를 가리킨다는 보장은 이제 전적으로
   * `isRefSafeBoardKey('note') === false`(`src/refs.ts`) 하나에 달려 있다 — `refOf` 가
   * 이 predicate 를 보고 `note` 보드의 항목에는 `note-N` 대신 raw id 를 낸다. "board key
   * 가 `note` 인 사례는 흔치 않으니 정리해도 되지 않나" 하고 이 분기를 지우면, 그 순간
   * `note` 보드의 todo 와 진짜 전역 메모가 같은 ref 를 공유하게 된다 — 지우면 안 된다.
   */
  test('`note` board key: ref 는 raw id 로 폴백하고 getTodo(ref) 가 왕복된다 (전역 note-N 과 충돌 방지)', () => {
    const todo = store.createTodo({ board: 'note', title: 'note 보드 작업' }, 'tester');

    const view = withRef(store, todo);
    expect(view.ref).toBe(todo.id);
    expect(store.getTodo(view.ref)?.id).toBe(todo.id);
  });
});

describe('withRef comment stats', () => {
  let dir: string;
  let store: TodoStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rocky-todo-refs-comments-'));
    store = new TodoStore({ dbPath: join(dir, 'todo.db') });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('todo view carries comment count and last comment time', () => {
    const todo = store.createTodo({ board: 'rocky', title: '작업' }, 'logan');
    expect(withRef(store, todo).commentCount).toBe(0);
    expect(withRef(store, todo).lastCommentAt).toBeUndefined();

    const comment = store.addComment(todo.id, '한 마디', 'logan');
    const view = withRef(store, todo);
    expect(view.commentCount).toBe(1);
    expect(view.lastCommentAt).toBe(comment.createdAt);
  });

  test('note view is unaffected', () => {
    const note = store.createNote({ board: 'rocky', title: '메모' }, 'logan');
    const view = withRef(store, note);
    expect(view.ref).toBe(`rocky-${note.number}`);
    expect('commentCount' in view).toBe(false);
  });
});
