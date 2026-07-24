import { describe, expect, test } from 'bun:test';
import { disabledGuidance, toolToRest } from './mcp-stdio';

describe('toolToRest', () => {
  test('todo_list (필터) → GET /api/todos', () => {
    expect(toolToRest('todo_list', { board: 'rocky' })).toEqual({
      method: 'GET',
      path: '/api/todos?board=rocky',
    });
  });

  test('todo_list boards → GET /api/boards', () => {
    expect(toolToRest('todo_list', { boards: true })).toEqual({
      method: 'GET',
      path: '/api/boards',
    });
  });

  test('todo_list id → GET /api/todos/:id', () => {
    expect(toolToRest('todo_list', { id: 'abc' })).toEqual({
      method: 'GET',
      path: '/api/todos/abc',
    });
  });

  test('todo_write 생성 → POST /api/todos', () => {
    expect(toolToRest('todo_write', { board: 'r', title: 't' })).toEqual({
      method: 'POST',
      path: '/api/todos',
      body: { board: 'r', title: 't' },
    });
  });

  test('todo_write 수정 → PATCH /api/todos/:id', () => {
    expect(toolToRest('todo_write', { id: 'abc', title: 't2' })).toEqual({
      method: 'PATCH',
      path: '/api/todos/abc',
      body: { title: 't2' },
    });
  });

  test('todo_status → POST /api/todos/:id/status', () => {
    expect(toolToRest('todo_status', { id: 'abc', action: 'start' })).toEqual({
      method: 'POST',
      path: '/api/todos/abc/status',
      body: { action: 'start' },
    });
  });

  test('note_write archive → POST /api/notes/:id/archive', () => {
    expect(toolToRest('note_write', { id: 'n1', mode: 'archive' })).toEqual({
      method: 'POST',
      path: '/api/notes/n1/archive',
      body: undefined,
    });
  });

  test('note_write 생성 → POST /api/notes', () => {
    expect(toolToRest('note_write', { title: '메모' })).toEqual({
      method: 'POST',
      path: '/api/notes',
      body: { title: '메모' },
    });
  });
});

describe('disabledGuidance', () => {
  test('노출 범위 3가지와 todo_enable 지시를 담는다', () => {
    const g = disabledGuidance();
    expect(g.error).toBe('rocky-todo disabled');
    expect(g.guidance).toContain('127.0.0.1');
    expect(g.guidance).toContain('todo.db');
    expect(g.guidance).toContain('todo_enable');
  });
});
