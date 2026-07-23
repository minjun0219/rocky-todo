import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TodoStore } from './store';

let dir: string;
let store: TodoStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rocky-todo-'));
  store = new TodoStore({ dbPath: join(dir, 'todo.db') });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('boards', () => {
  test('ensureBoard creates a board and is idempotent by key', () => {
    const a = store.ensureBoard('rocky', { actor: 'tester' });
    const b = store.ensureBoard('rocky', { actor: 'tester' });
    expect(a.id).toBe(b.id);
    expect(a.key).toBe('rocky');
    expect(a.title).toBe('rocky');
    expect(store.listBoards()).toHaveLength(1);
  });

  test('ensureBoard accepts an explicit title on first creation', () => {
    const board = store.ensureBoard('rocky', { title: '로키 보드', actor: 'tester' });
    expect(board.title).toBe('로키 보드');
  });
});

describe('todos', () => {
  test('createTodo applies defaults (status todo, priority p4) and lists by board', () => {
    const todo = store.createTodo({ board: 'rocky', title: '첫 작업' }, 'tester');
    expect(todo.status).toBe('todo');
    expect(todo.priority).toBe('p4');
    expect(todo.id).toHaveLength(8);

    const listed = store.listTodos({ board: 'rocky' });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.title).toBe('첫 작업');
  });

  test('createTodo with full metadata round-trips', () => {
    const todo = store.createTodo(
      {
        board: 'rocky',
        title: '이슈 처리',
        description: '상세 **설명**',
        priority: 'p1',
        due: '2026-08-01',
        labels: ['bug', 'urgent'],
        links: [{ url: 'https://github.com/minjun0219/rocky/issues/1', title: 'gh#1' }],
      },
      'tester',
    );
    const found = store.getTodo(todo.id);
    expect(found?.description).toBe('상세 **설명**');
    expect(found?.priority).toBe('p1');
    expect(found?.due).toBe('2026-08-01');
    expect(found?.labels).toEqual(['bug', 'urgent']);
    expect(found?.links).toEqual([
      { url: 'https://github.com/minjun0219/rocky/issues/1', title: 'gh#1' },
    ]);
  });

  test('section is upserted by name within a board', () => {
    const a = store.createTodo({ board: 'rocky', title: 'a', section: '설계' }, 'tester');
    const b = store.createTodo({ board: 'rocky', title: 'b', section: '설계' }, 'tester');
    expect(a.sectionId).toBeDefined();
    expect(a.sectionId).toBe(b.sectionId as string);
    const sections = store.listSections(a.boardId);
    expect(sections).toHaveLength(1);
    expect(sections[0]?.title).toBe('설계');
  });

  test('hierarchy: child references parent via parentId', () => {
    const parent = store.createTodo({ board: 'rocky', title: '부모' }, 'tester');
    const child = store.createTodo(
      { board: 'rocky', title: '자식', parentId: parent.id },
      'tester',
    );
    expect(child.parentId).toBe(parent.id);
  });

  test('createTodo rejects unknown parent', () => {
    expect(() =>
      store.createTodo({ board: 'rocky', title: 'x', parentId: 'zzzzzzzz' }, 'tester'),
    ).toThrow(/parent/i);
  });

  test('updateTodo patches fields and bumps updatedAt', () => {
    const todo = store.createTodo({ board: 'rocky', title: '수정 전' }, 'tester');
    const updated = store.updateTodo(todo.id, { title: '수정 후', priority: 'p2' }, 'tester');
    expect(updated.title).toBe('수정 후');
    expect(updated.priority).toBe('p2');
    expect(updated.updatedAt >= todo.updatedAt).toBe(true);
  });

  test('getTodo resolves unique id prefix', () => {
    const todo = store.createTodo({ board: 'rocky', title: 'prefix' }, 'tester');
    expect(store.getTodo(todo.id.slice(0, 4))?.id).toBe(todo.id);
    expect(store.getTodo('nope1234')).toBeUndefined();
  });
});

describe('status transitions', () => {
  test('start marks doing with actor and timestamp; stop reverts', () => {
    const todo = store.createTodo({ board: 'rocky', title: '작업' }, 'tester');
    const doing = store.setTodoStatus(todo.id, 'start', 'claude-code');
    expect(doing.status).toBe('doing');
    expect(doing.doingBy).toBe('claude-code');
    expect(doing.doingSince).toBeDefined();

    const stopped = store.setTodoStatus(todo.id, 'stop', 'claude-code');
    expect(stopped.status).toBe('todo');
    expect(stopped.doingBy).toBeUndefined();
    expect(stopped.doingSince).toBeUndefined();
  });

  test('done sets completedAt and clears doing; reopen reverts', () => {
    const todo = store.createTodo({ board: 'rocky', title: '작업' }, 'tester');
    store.setTodoStatus(todo.id, 'start', 'claude-code');
    const done = store.setTodoStatus(todo.id, 'done', 'claude-code');
    expect(done.status).toBe('done');
    expect(done.completedAt).toBeDefined();
    expect(done.doingBy).toBeUndefined();

    const reopened = store.setTodoStatus(todo.id, 'reopen', 'claude-code');
    expect(reopened.status).toBe('todo');
    expect(reopened.completedAt).toBeUndefined();
  });

  test('archive hides from default listing; includeArchived reveals; unarchive restores', () => {
    const todo = store.createTodo({ board: 'rocky', title: '보관 대상' }, 'tester');
    store.setTodoStatus(todo.id, 'archive', 'tester');
    expect(store.listTodos({ board: 'rocky' })).toHaveLength(0);

    const archived = store.listTodos({ board: 'rocky', includeArchived: true });
    expect(archived).toHaveLength(1);
    expect(archived[0]?.archivedAt).toBeDefined();

    store.setTodoStatus(todo.id, 'unarchive', 'tester');
    expect(store.listTodos({ board: 'rocky' })).toHaveLength(1);
  });
});

describe('listTodos filters', () => {
  test('filters by status and label; all boards without board filter', () => {
    store.createTodo({ board: 'rocky', title: 'a', labels: ['bug'] }, 'tester');
    const b = store.createTodo({ board: 'other', title: 'b' }, 'tester');
    store.setTodoStatus(b.id, 'done', 'tester');

    expect(store.listTodos({})).toHaveLength(2);
    expect(store.listTodos({ status: 'done' })).toHaveLength(1);
    expect(store.listTodos({ label: 'bug' })).toHaveLength(1);
    expect(store.listTodos({ board: 'other', status: 'todo' })).toHaveLength(0);
  });
});

describe('notes', () => {
  test('create + edit + append + archive lifecycle', () => {
    const note = store.createNote(
      { board: 'rocky', title: '스크래치', content: '첫 줄' },
      'tester',
    );
    expect(note.boardId).toBeDefined();

    const edited = store.updateNote(note.id, { content: '전체 교체' }, 'logan');
    expect(edited.content).toBe('전체 교체');

    const appended = store.updateNote(note.id, { content: '추가 줄', mode: 'append' }, 'tester');
    expect(appended.content).toBe('전체 교체\n추가 줄');

    store.archiveNote(note.id, 'tester');
    expect(store.listNotes({ board: 'rocky' })).toHaveLength(0);
    expect(store.listNotes({ board: 'rocky', includeArchived: true })).toHaveLength(1);
  });

  test('global note has no board', () => {
    const note = store.createNote({ title: '글로벌 메모', content: '' }, 'tester');
    expect(note.boardId).toBeUndefined();
    expect(store.listNotes({ global: true })).toHaveLength(1);
  });
});

describe('history', () => {
  test('mutations are recorded with actor, action, and field diff', () => {
    const todo = store.createTodo({ board: 'rocky', title: '이력' }, 'claude-code');
    store.updateTodo(todo.id, { title: '이력 v2' }, 'logan');
    store.setTodoStatus(todo.id, 'done', 'claude-code');

    const history = store.listHistory({ entityId: todo.id });
    const actions = history.map((h) => h.action);
    expect(actions).toEqual(['done', 'update', 'create']);
    expect(history[1]?.actor).toBe('logan');
    expect(history[1]?.changes).toEqual({ title: ['이력', '이력 v2'] });
  });

  test('note edits are recorded too', () => {
    const note = store.createNote({ title: 'n', content: 'a' }, 'tester');
    store.updateNote(note.id, { content: 'b' }, 'logan');
    const history = store.listHistory({ entityId: note.id });
    expect(history.map((h) => h.action)).toEqual(['update', 'create']);
    expect(history[0]?.entity).toBe('note');
  });
});

describe('listChangesSince (변경 피드)', () => {
  test('returns entries after sinceId with resolved titles and board key, oldest first', () => {
    const todo = store.createTodo({ board: 'rocky', title: '피드 작업' }, 'claude-code');
    const base = store.listChangesSince(0);
    expect(base.entries.length).toBeGreaterThan(0);

    store.updateTodo(todo.id, { title: '피드 작업 v2' }, 'logan');
    const note = store.createNote({ board: 'rocky', title: '피드 메모' }, 'logan');

    const feed = store.listChangesSince(base.lastId);
    expect(feed.lastId).toBeGreaterThan(base.lastId);
    expect(feed.entries).toHaveLength(2);
    expect(feed.entries[0]?.action).toBe('update');
    expect(feed.entries[0]?.title).toBe('피드 작업 v2');
    expect(feed.entries[0]?.boardKey).toBe('rocky');
    expect(feed.entries[1]?.entity).toBe('note');
    expect(feed.entries[1]?.title).toBe('피드 메모');
    expect(feed.entries[1]?.entityId).toBe(note.id);
  });

  test('no new changes → empty entries, lastId unchanged', () => {
    store.createTodo({ board: 'rocky', title: 'x' }, 'tester');
    const { lastId } = store.listChangesSince(0);
    const feed = store.listChangesSince(lastId);
    expect(feed.entries).toHaveLength(0);
    expect(feed.lastId).toBe(lastId);
  });
});

describe('change events', () => {
  test('subscribe receives events for every mutation entry path', () => {
    const events: string[] = [];
    const unsubscribe = store.subscribe((e) => {
      events.push(`${e.entity}:${e.action}`);
    });

    const todo = store.createTodo({ board: 'rocky', title: 'evt' }, 'tester');
    store.setTodoStatus(todo.id, 'start', 'tester');
    const note = store.createNote({ title: 'n', content: '' }, 'tester');
    store.updateNote(note.id, { content: 'x' }, 'tester');

    expect(events).toContain('todo:create');
    expect(events).toContain('todo:start');
    expect(events).toContain('note:create');
    expect(events).toContain('note:update');

    unsubscribe();
    store.createTodo({ board: 'rocky', title: 'evt2' }, 'tester');
    expect(events.filter((e) => e === 'todo:create')).toHaveLength(1);
  });
});
