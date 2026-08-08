import { describe, expect, test } from 'bun:test';
import {
  boardKeyForCwd,
  DEFAULT_STATUSLINE_TEMPLATE,
  renderStatusline,
  type StatuslineData,
  truncateTitle,
} from './statusline';

const empty: StatuslineData = { inbox: 0, stale: 0, doing: 0 };

const withMine: StatuslineData = {
  mine: { ref: 'rocky-todo-12', title: 'statusline API 추가', comments: 0 },
  inbox: 0,
  stale: 0,
  doing: 1,
};

describe('renderStatusline — 그룹', () => {
  test('보여줄 게 없으면 빈 문자열이다 (호출부가 아무것도 출력하지 않게)', () => {
    expect(renderStatusline(DEFAULT_STATUSLINE_TEMPLATE, empty)).toBe('');
  });

  test('0 인 숫자는 자기 그룹을 통째로 지운다', () => {
    expect(renderStatusline('[⏺{doing}][ ✉{inbox}]', { ...empty, doing: 3 })).toBe('⏺3');
  });

  test('앞 그룹이 사라져 남은 공백은 trim 된다', () => {
    expect(renderStatusline('[⏺ {mine.ref}][  ✉{inbox}]', { ...empty, inbox: 2 })).toBe('✉2');
  });

  test('그룹 안 placeholder 가 하나라도 차 있으면 그룹이 남는다', () => {
    expect(renderStatusline('[{mine.ref} {mine.title}]', withMine)).toBe(
      'rocky-todo-12 statusline API 추가',
    );
  });

  test('placeholder 가 없는 그룹은 순수 장식이라 늘 남는다', () => {
    expect(renderStatusline('[보드]', empty)).toBe('보드');
  });

  test('모르는 placeholder 는 그대로 남는다 — 오타가 눈에 보여야 한다', () => {
    expect(renderStatusline('[{mine.titel}]', withMine)).toBe('{mine.titel}');
  });

  test('닫히지 않은 대괄호는 리터럴로 되돌린다 — 조용히 잘려나가지 않게', () => {
    expect(renderStatusline('[⏺{doing}', { ...empty, doing: 2 })).toBe('[⏺2');
  });
});

describe('renderStatusline — ANSI', () => {
  // 색을 별도 DSL 로 만들지 않고 템플릿에 이스케이프를 직접 적게 한 선택의 유일한 위험이
  // 여기다. `ESC[33m` 의 `[` 를 그룹 시작으로 읽으면 색을 넣은 템플릿이 통째로 깨진다.
  const yellow = '\u001b[33m';
  const reset = '\u001b[0m';

  test('ESC 뒤의 `[` 는 그룹이 아니라 리터럴이다', () => {
    expect(renderStatusline(`[${yellow}⏺{doing}${reset}]`, { ...empty, doing: 4 })).toBe(
      `${yellow}⏺4${reset}`,
    );
  });

  test('색을 입힌 그룹도 값이 비면 이스케이프까지 같이 사라진다', () => {
    expect(renderStatusline(`[${yellow}⏺{doing}${reset}][ ✉{inbox}]`, { ...empty, inbox: 1 })).toBe(
      '✉1',
    );
  });
});

describe('renderStatusline — mine', () => {
  test('기본 템플릿은 이 세션의 항목을 제목까지 싣는다', () => {
    expect(renderStatusline(DEFAULT_STATUSLINE_TEMPLATE, withMine)).toBe(
      '⏺ rocky-todo-12 statusline API 추가',
    );
  });

  test('댓글이 달리면 세그먼트가 생긴다 — 사람이 남긴 말이 곧 이 기능의 목적이다', () => {
    const line = renderStatusline(DEFAULT_STATUSLINE_TEMPLATE, {
      ...withMine,
      mine: { ...withMine.mine!, comments: 3 },
    });
    expect(line).toBe('⏺ rocky-todo-12 statusline API 추가 💬3');
  });

  test('mine 이 없으면 mine 관련 그룹은 전부 사라진다', () => {
    expect(renderStatusline(DEFAULT_STATUSLINE_TEMPLATE, { ...empty, stale: 2 })).toBe('⚠2');
  });
});

describe('truncateTitle', () => {
  test('짧은 제목은 그대로 둔다', () => {
    expect(truncateTitle('짧다')).toBe('짧다');
  });

  test('긴 제목은 잘라내고 잘렸음을 표시한다', () => {
    expect(truncateTitle('가'.repeat(40))).toBe(`${'가'.repeat(30)}…`);
  });

  test('코드포인트 단위로 자른다 — 이모지가 반 토막 나지 않게', () => {
    expect(truncateTitle('🙂'.repeat(5), 3)).toBe('🙂🙂🙂…');
  });
});

describe('boardKeyForCwd', () => {
  const boards = [
    { key: 'rocky-todo', path: '/Users/x/dev/rocky-todo' },
    { key: 'rocky' },
    { key: 'ogpeek', path: '/Users/x/dev/ogpeek' },
  ];

  test('cwd 가 없으면 아무 보드도 고르지 않는다', () => {
    expect(boardKeyForCwd(boards, undefined)).toBeUndefined();
  });

  test('boards.path 아래면 그 보드다', () => {
    expect(boardKeyForCwd(boards, '/Users/x/dev/rocky-todo')).toBe('rocky-todo');
  });

  test('path 비교는 경로 경계까지 본다 — `/a/b` 가 `/a/bc` 에 걸리면 안 된다', () => {
    expect(boardKeyForCwd([{ key: 'og', path: '/Users/x/dev/og' }], '/Users/x/dev/ogpeek')).toBe(
      undefined,
    );
  });

  test('path 가 없어도 보드 key 가 경로 세그먼트면 잡는다', () => {
    expect(boardKeyForCwd(boards, '/Users/x/orca/rocky/eelpout')).toBe('rocky');
  });

  test('워크트리 — basename 이 아니라 세그먼트를 봐야 원본 보드가 잡힌다', () => {
    const cwd = '/Users/x/dev/rocky-todo/.claude/worktrees/todo-12';
    expect(boardKeyForCwd(boards, cwd)).toBe('rocky-todo');
  });

  test('세그먼트 후보가 여럿이면 더 구체적인(긴) key 를 고른다', () => {
    const cwd = '/Users/x/rocky/rocky-todo/sub';
    expect(boardKeyForCwd([{ key: 'rocky' }, { key: 'rocky-todo' }], cwd)).toBe('rocky-todo');
  });
});
