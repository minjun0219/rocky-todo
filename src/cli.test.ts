import { describe, expect, test } from 'bun:test';
import { formatTodoLine, parseFlags } from './cli';
import type { Todo } from './store';

describe('parseFlags', () => {
  test('separates positionals and flags', () => {
    const parsed = parseFlags(['add', '제목 텍스트', '--board', 'rocky', '--priority', 'p1']);
    expect(parsed.positionals).toEqual(['add', '제목 텍스트']);
    expect(parsed.flags.board).toBe('rocky');
    expect(parsed.flags.priority).toBe('p1');
  });

  test('boolean flags need no value', () => {
    const parsed = parseFlags(['ls', '--all', '--archived', '--json', '--global']);
    expect(parsed.flags.all).toBe(true);
    expect(parsed.flags.archived).toBe(true);
    expect(parsed.flags.json).toBe(true);
    expect(parsed.flags.global).toBe(true);
  });

  test('label is comma-split and link accumulates', () => {
    const parsed = parseFlags([
      'add',
      'x',
      '--label',
      'bug,urgent',
      '--link',
      'https://a.example',
      '--link',
      'https://b.example',
    ]);
    expect(parsed.flags.label).toEqual(['bug', 'urgent']);
    expect(parsed.flags.link).toEqual(['https://a.example', 'https://b.example']);
  });

  test('unknown flag throws', () => {
    expect(() => parseFlags(['ls', '--explode'])).toThrow(/unknown flag/);
  });
});

describe('formatTodoLine', () => {
  const base: Todo = {
    id: 'a1b2c3d4',
    boardId: 'b',
    title: '작업 제목',
    description: '',
    status: 'todo',
    priority: 'p4',
    labels: [],
    links: [],
    position: 1,
    createdAt: '2026-07-23T00:00:00.000Z',
    updatedAt: '2026-07-23T00:00:00.000Z',
  };

  test('todo status glyph and id prefix', () => {
    const line = formatTodoLine(base, 0);
    expect(line).toContain('○');
    expect(line).toContain('a1b2c3');
    expect(line).toContain('작업 제목');
  });

  test('doing shows actor, done shows check', () => {
    const doing = formatTodoLine(
      { ...base, status: 'doing', doingBy: 'claude-code', doingSince: new Date().toISOString() },
      0,
    );
    expect(doing).toContain('▶');
    expect(doing).toContain('claude-code');

    const done = formatTodoLine({ ...base, status: 'done' }, 0);
    expect(done).toContain('✓');
  });

  test('metadata chips: priority, labels, due, links, depth indent', () => {
    const line = formatTodoLine(
      {
        ...base,
        priority: 'p1',
        labels: ['bug'],
        due: '2026-08-01',
        links: [{ url: 'https://github.com/o/r/issues/3' }],
      },
      2,
    );
    expect(line).toContain('p1');
    expect(line).toContain('[bug]');
    expect(line).toContain('~2026-08-01');
    expect(line).toContain('↗r#3');
    expect(line.startsWith('    ')).toBe(true);
  });
});
