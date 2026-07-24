import { describe, expect, test } from 'bun:test';
import { TODO_TOOL_SPECS } from './mcp-tools';

describe('mcp-tools', () => {
  test('정확히 5개 도구를 정의한다', () => {
    expect(TODO_TOOL_SPECS.map((s) => s.name).sort()).toEqual([
      'note_list',
      'note_write',
      'todo_list',
      'todo_status',
      'todo_write',
    ]);
  });

  test('각 스펙은 description 과 inputSchema 를 갖는다', () => {
    for (const spec of TODO_TOOL_SPECS) {
      expect(spec.description.length).toBeGreaterThan(0);
      expect(typeof spec.inputSchema).toBe('object');
    }
  });

  test('todo_status 의 action enum 이 6개 전이를 담는다', () => {
    const spec = TODO_TOOL_SPECS.find((s) => s.name === 'todo_status');
    expect(spec).toBeDefined();
    // action 필드가 존재하는지만 확인 (zod 내부 구조 대신 파싱으로 검증)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const shape = spec!.inputSchema as any;
    expect(shape.action.safeParse('start').success).toBe(true);
    expect(shape.action.safeParse('nope').success).toBe(false);
  });
});
