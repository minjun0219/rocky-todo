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

describe('number 발급', () => {
  test('보드 안에서 1부터 연속으로 매겨진다', () => {
    const a = store.createTodo({ board: 'alpha', title: '첫째' }, 'tester');
    const b = store.createTodo({ board: 'alpha', title: '둘째' }, 'tester');
    expect(a.number).toBe(1);
    expect(b.number).toBe(2);
  });

  test('보드마다 번호 공간이 독립이다', () => {
    store.createTodo({ board: 'alpha', title: '첫째' }, 'tester');
    const other = store.createTodo({ board: 'beta', title: '다른 보드 첫째' }, 'tester');
    expect(other.number).toBe(1);
  });

  test('아카이브해도 번호를 회수하지 않는다', () => {
    const a = store.createTodo({ board: 'alpha', title: '첫째' }, 'tester');
    store.setTodoStatus(a.id, 'archive', 'tester');
    const b = store.createTodo({ board: 'alpha', title: '둘째' }, 'tester');
    expect(b.number).toBe(2);
  });

  test('노트도 보드별로 번호를 받는다', () => {
    const n = store.createNote({ board: 'alpha', title: '메모' }, 'tester');
    expect(n.number).toBe(1);
  });

  test('글로벌 노트는 보드 노트와 독립된 번호 공간을 쓴다', () => {
    store.createNote({ board: 'alpha', title: '보드 메모' }, 'tester');
    const g = store.createNote({ title: '글로벌 메모' }, 'tester');
    expect(g.number).toBe(1);
  });
});

describe('참조 해석', () => {
  test('rocky#12 형태로 보드를 지정해 찾는다', () => {
    const t = store.createTodo({ board: 'alpha', title: '대상' }, 'tester');
    expect(store.getTodo(`alpha#${t.number}`)?.id).toBe(t.id);
  });

  test('#N 과 N 은 현재 보드에서 찾는다', () => {
    const board = store.ensureBoard('alpha', { actor: 'tester' });
    const t = store.createTodo({ board: 'alpha', title: '대상' }, 'tester');
    expect(store.getTodo(`#${t.number}`, board.id)?.id).toBe(t.id);
    expect(store.getTodo(String(t.number), board.id)?.id).toBe(t.id);
  });

  test('8자 base36 입력은 번호가 아니라 id 로 해석한다', () => {
    const t = store.createTodo({ board: 'alpha', title: '대상' }, 'tester');
    expect(store.getTodo(t.id)?.id).toBe(t.id);
  });

  test('짧은 문자열은 기존처럼 id prefix 로 해석한다', () => {
    const t = store.createTodo({ board: 'alpha', title: '대상' }, 'tester');
    expect(store.getTodo(t.id.slice(0, 5))?.id).toBe(t.id);
  });

  test('현재 보드 없이 #N 만 오면 모호성을 에러로 노출한다', () => {
    store.createTodo({ board: 'alpha', title: '대상' }, 'tester');
    expect(() => store.getTodo('#1')).toThrow(/board/i);
  });

  test('없는 번호는 undefined', () => {
    store.createTodo({ board: 'alpha', title: '대상' }, 'tester');
    expect(store.getTodo('alpha#999')).toBeUndefined();
  });

  test('#N 은 자릿수가 ID_LENGTH 이상이어도 번호로 취급해 보드 컨텍스트를 요구한다', () => {
    store.createTodo({ board: 'alpha', title: '대상' }, 'tester');
    // '#1234567' 는 '#' + 7자리 숫자 — 예전 길이 게이트는 '#' 포함 길이(8)로 비교해
    // 번호 분기를 건너뛰고 undefined 를 돌려주는 버그가 있었다. '#' 가 붙으면 무조건 번호다.
    expect(() => store.getTodo('#1234567')).toThrow(/board/i);
  });

  test('#N 은 보드 컨텍스트가 있으면 자릿수와 무관하게 번호로 해석한다', () => {
    const board = store.ensureBoard('alpha', { actor: 'tester' });
    const t = store.createTodo({ board: 'alpha', title: '대상' }, 'tester');
    expect(store.getTodo(`#${t.number}`, board.id)?.id).toBe(t.id);
    // 존재하지 않는 큰 자릿수 번호도 (undefined 가 아니라) 여전히 번호 분기로 라우팅된다 —
    // id-exact/prefix 매칭으로 새지 않고 조회만 실패해야 한다.
    expect(store.getTodo('#1234567', board.id)).toBeUndefined();
  });

  test('정확히 8자리 숫자로만 된 입력은 번호가 아니라 id 로 취급한다', () => {
    // ID_LENGTH(8) 와 같은 자릿수의 순수 숫자는 실제 id(무작위 base36, 전부 숫자일 수 있음)와
    // 구분할 수 없으므로 id 취급이 의도된 동작이다. 대응하는 id 가 없으니 undefined 여야 한다.
    expect(store.getTodo('00000012')).toBeUndefined();
  });
});
