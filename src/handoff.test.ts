import { describe, expect, test } from 'bun:test';
import { buildHandoffPoke, buildHandoffPrompt, buildHandoffPromptFrom } from './handoff';
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

test('buildHandoffPromptFrom — claim 없이도 같은 주입문을 만든다', () => {
  const prompt = buildHandoffPromptFrom({
    actor: 'logan',
    note: '테스트부터',
    todoRef: 'rocky-todo#16',
    todoTitle: '세션 띄우기',
    remaining: 0,
  });
  expect(prompt).toContain('logan → rocky-todo#16 "세션 띄우기"');
  expect(prompt).toContain('메모: 테스트부터');
  expect(prompt).not.toContain('대기 중인 요청이');
});

describe('buildHandoffPoke', () => {
  const poke = buildHandoffPoke({
    sessionName: 'eelpout-a3',
    todoRef: 'rocky-todo-11',
    todoTitle: '세션 띄우기',
  });

  test('SendMessage 의 to 는 세션 이름이다', () => {
    expect(poke.to).toBe('eelpout-a3');
  });

  test('참조와 제목으로 어느 건인지 알아볼 수 있다', () => {
    expect(poke.message).toContain('rocky-todo-11');
    expect(poke.message).toContain('세션 띄우기');
  });

  test('훅 주입이 없어도 착수할 수 있는 폴백을 담는다', () => {
    expect(poke.message).toContain('todo_list { id: "rocky-todo-11" }');
  });

  test('본문(메모·착수 지시)은 싣지 않는다 — 같은 턴의 훅 주입과 겹친다', () => {
    expect(poke.message).not.toContain('todo_status');
    expect(poke.message).not.toContain('메모:');
  });
});
