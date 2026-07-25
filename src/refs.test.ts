import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { refNeedsBoardContext } from './refs';
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
