import { describe, expect, test } from 'bun:test';
import { buildHandoffPrompt } from './handoff';
import type { ClaimedHandoff } from './store';

const base: ClaimedHandoff = {
  handoff: {
    id: 'h1',
    todoId: 't1',
    sessionId: 'sess-1',
    sessionName: 'eelpout-a3',
    note: '',
    actor: 'logan',
    status: 'delivered',
    createdAt: '2026-07-26T12:00:00.000Z',
  },
  todoRef: 'rocky-todo#11',
  todoTitle: 'todo - 에이전트 작업 요청',
  remaining: 0,
};

describe('buildHandoffPrompt', () => {
  test('보낸 사람·참조·제목을 담는다', () => {
    const prompt = buildHandoffPrompt(base);
    expect(prompt).toContain('logan → rocky-todo#11');
    expect(prompt).toContain('todo - 에이전트 작업 요청');
    expect(prompt).toContain('todo_status');
  });

  test('메모가 있으면 실어 보낸다', () => {
    const prompt = buildHandoffPrompt({
      ...base,
      handoff: { ...base.handoff, note: '테스트부터 짜줘' },
    });
    expect(prompt).toContain('메모: 테스트부터 짜줘');
  });

  test('메모가 없으면 메모 줄 자체가 없다', () => {
    expect(buildHandoffPrompt(base)).not.toContain('메모:');
  });

  test('잔여 건수가 있으면 알린다', () => {
    expect(buildHandoffPrompt({ ...base, remaining: 2 })).toContain('2건');
  });

  test('잔여가 0이면 잔여 줄이 없다', () => {
    expect(buildHandoffPrompt(base)).not.toContain('대기 중인 요청이');
  });
});
