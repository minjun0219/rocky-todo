import { describe, expect, test } from 'bun:test';
import {
  buildPath,
  findTodoIdByNumber,
  isAddressableBoardKey,
  parseRoute,
  RESERVED_BOARD_KEYS,
  routeForTodo,
} from './route';

const BOARDS = [
  { id: 'b1', key: 'rocky' },
  { id: 'b2', key: 'rocky-todo' },
];

const TODOS = [
  { id: 't1', boardId: 'b1', number: 12 },
  { id: 't2', boardId: 'b2', number: 12 },
  { id: 't3', boardId: 'b1', number: 3 },
];

describe('parseRoute', () => {
  test('root and empty mean the all-boards view', () => {
    expect(parseRoute('/')).toEqual({ board: 'all' });
    expect(parseRoute('')).toEqual({ board: 'all' });
  });

  test('one segment is a board', () => {
    expect(parseRoute('/rocky')).toEqual({ board: 'rocky' });
  });

  test('a trailing slash changes nothing', () => {
    expect(parseRoute('/rocky/')).toEqual({ board: 'rocky' });
    expect(parseRoute('/rocky/12/')).toEqual({ board: 'rocky', todoNumber: 12 });
  });

  test('a numeric second segment is the todo number', () => {
    expect(parseRoute('/rocky/12')).toEqual({ board: 'rocky', todoNumber: 12 });
  });

  test('a non-numeric second segment is ignored', () => {
    expect(parseRoute('/rocky/abc')).toEqual({ board: 'rocky' });
    expect(parseRoute('/rocky/12abc')).toEqual({ board: 'rocky' });
    expect(parseRoute('/rocky/-1')).toEqual({ board: 'rocky' });
    expect(parseRoute('/rocky/0')).toEqual({ board: 'rocky' });
  });

  test('extra segments are ignored', () => {
    expect(parseRoute('/rocky/12/anything/else')).toEqual({ board: 'rocky', todoNumber: 12 });
  });

  test('segments are percent-decoded', () => {
    expect(parseRoute('/my%20board')).toEqual({ board: 'my board' });
  });

  test('a malformed percent escape falls back to the all view rather than throwing', () => {
    expect(parseRoute('/%E0%A4%A')).toEqual({ board: 'all' });
  });
});

describe('buildPath', () => {
  test('the all view is the root path', () => {
    expect(buildPath({ board: 'all' })).toBe('/');
    expect(buildPath({ board: 'all', todoNumber: 12 })).toBe('/');
  });

  test('a board becomes one segment', () => {
    expect(buildPath({ board: 'rocky' })).toBe('/rocky');
  });

  test('a board and number become two segments', () => {
    expect(buildPath({ board: 'rocky', todoNumber: 12 })).toBe('/rocky/12');
  });

  test('board keys are percent-encoded', () => {
    expect(buildPath({ board: 'my board' })).toBe('/my%20board');
  });

  test('reserved keys collapse to the root so no link collides with a REST route', () => {
    for (const key of RESERVED_BOARD_KEYS) {
      expect(buildPath({ board: key })).toBe('/');
      expect(buildPath({ board: key, todoNumber: 12 })).toBe('/');
    }
  });

  test('dot-segment keys collapse to the root rather than emitting /. or /..', () => {
    // encodeURIComponent 는 점을 이스케이프하지 않는다 — `/.`/`/..` 를 그대로 내보내면
    // 브라우저 URL 파서가 `/` 로 정규화해, 주소가 만들어진 순간 다른 화면을 가리킨다.
    for (const key of ['.', '..']) {
      expect(buildPath({ board: key })).toBe('/');
      expect(buildPath({ board: key, todoNumber: 12 })).toBe('/');
    }
  });

  test('a key that merely contains dots is still addressable', () => {
    expect(buildPath({ board: '.github' })).toBe('/.github');
    expect(buildPath({ board: 'a.b' })).toBe('/a.b');
    expect(buildPath({ board: '...' })).toBe('/...');
  });

  test('round-trips with parseRoute', () => {
    for (const route of [
      { board: 'all' as const },
      { board: 'rocky' },
      { board: 'rocky', todoNumber: 12 },
      { board: 'my board', todoNumber: 3 },
    ]) {
      expect(parseRoute(buildPath(route))).toEqual(route);
    }
  });
});

describe('isAddressableBoardKey', () => {
  test('ordinary keys are addressable', () => {
    expect(isAddressableBoardKey('rocky')).toBe(true);
    expect(isAddressableBoardKey('my board')).toBe(true);
    expect(isAddressableBoardKey('.github')).toBe(true);
  });

  test('reserved keys are not — the daemon routes eat those paths', () => {
    for (const key of RESERVED_BOARD_KEYS) {
      expect(isAddressableBoardKey(key)).toBe(false);
    }
  });

  test('dot segments are not — the browser normalizes them away', () => {
    expect(isAddressableBoardKey('.')).toBe(false);
    expect(isAddressableBoardKey('..')).toBe(false);
  });
});

describe('routeForTodo', () => {
  test('resolves the board key from the todo boardId', () => {
    expect(routeForTodo({ boardId: 'b1', number: 12 }, BOARDS)).toEqual({
      board: 'rocky',
      todoNumber: 12,
    });
  });

  test('an unknown boardId falls back to the all view', () => {
    expect(routeForTodo({ boardId: 'nope', number: 12 }, BOARDS)).toEqual({ board: 'all' });
  });
});

describe('findTodoIdByNumber', () => {
  test('scopes the number to the selected board', () => {
    expect(findTodoIdByNumber(TODOS, BOARDS, 'rocky', 12)).toBe('t1');
    expect(findTodoIdByNumber(TODOS, BOARDS, 'rocky-todo', 12)).toBe('t2');
  });

  test('returns undefined for a number that is not on that board', () => {
    expect(findTodoIdByNumber(TODOS, BOARDS, 'rocky', 999)).toBeUndefined();
  });

  test('returns undefined for an unknown board', () => {
    expect(findTodoIdByNumber(TODOS, BOARDS, 'nope', 12)).toBeUndefined();
  });

  test('the all view has no board scope, so a bare number is not resolvable', () => {
    expect(findTodoIdByNumber(TODOS, BOARDS, 'all', 12)).toBeUndefined();
  });
});
