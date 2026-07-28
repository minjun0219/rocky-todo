import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TodoStore } from './store';
import { buildPath } from './ui/route';

let dir: string;
let store: TodoStore;

/**
 * id prefix 테스트용 — 알파벳이 하나 이상 들어간 prefix 를 고른다.
 * (`src/server.test.ts` · `src/mcp.test.ts` 의 같은 헬퍼와 같은 이유.)
 *
 * id 는 base36 이라 앞 4자가 전부 숫자로 나올 수 있고, 그런 prefix 는 **설계대로**
 * "번호"로 해석된다(`resolveRef` 의 맨숫자 분기) — prefix 로는 안 풀려 이 테스트가
 * 확률적으로 깨졌다(CI 에서 실제로 실패). 알파벳이 나오는 지점까지 늘려 그 분기를
 * 확실히 피한다 — 전부 숫자면 id 전체(정확 일치).
 */
function idPrefix(id: string): string {
  const at = id.search(/[a-z]/);
  return at === -1 ? id : id.slice(0, Math.max(4, at + 1));
}

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

  // finding: board key 가 공백/`#` 를 포함하면 서버가 스스로 만든 스코프 ref
  // (`refOf` → `<key>#<number>`) 를 `resolveRef` 의 스코프 정규식(`^([^#\s]+)#(\d+)$`)
  // 이 못 읽어 조용히 undefined 로 끝난다. 조용한 wrong-row 대신 생성 시점에 막는다.
  test('ensureBoard rejects a key containing whitespace', () => {
    expect(() => store.ensureBoard('my repo', { actor: 'tester' })).toThrow(/whitespace/);
  });

  test("ensureBoard rejects a key containing '#'", () => {
    expect(() => store.ensureBoard('a#b', { actor: 'tester' })).toThrow(/#/);
  });

  // `note` 는 전역 메모 참조(`note-3`)의 예약 접두사다 — 같은 이름의 보드가 생기면
  // `note-3` 이 두 행(전역 메모 3번 / 그 보드의 3번)을 가리키는 모호한 참조가 된다.
  test('ensureBoard rejects the reserved key "note"', () => {
    expect(() => store.ensureBoard('note', { actor: 'tester' })).toThrow(/reserved/i);
  });

  // 예약어는 정확히 일치할 때만이다 — `notes`/`note-taking` 은 멀쩡한 보드 이름이고
  // `notes-1` 은 greedy 파싱이 보드 `notes` 로 정확히 읽는다.
  test('ensureBoard allows keys that merely start with "note"', () => {
    expect(() => store.ensureBoard('notes', { actor: 'tester' })).not.toThrow();
    expect(() => store.ensureBoard('note-taking', { actor: 'tester' })).not.toThrow();
  });

  test('ensureBoard rejects an empty key', () => {
    expect(() => store.ensureBoard('', { actor: 'tester' })).toThrow(/empty/);
  });

  // finding: 이전 버전은 `ensureBoard` 가 `api`/`mcp` 를 거부했는데, 이 키는 `boardKeyFrom`
  // (`src/actor.ts`)이 레포 이름에서 그대로 유추할 수 있어(레포 이름이 `api` 인 경우) 그런
  // 레포에서는 `rocky-todo add`·MCP `todo_write`/`note_write` 가 첫 사용부터 에러였다.
  // 지금은 거부하지 않는다 — 이 키의 보드도 정상적으로 만들어지고 동작한다. 다만
  // `buildPath`(`src/ui/route.ts`)는 URL 이 데몬 라우트와 겹치는 걸 피하려 이 키를 만나면
  // `/` 를 낸다 — "만들어지되 링크되지 않는다"가 새 계약이다.
  test('ensureBoard accepts a key that collides with a daemon route (api/mcp)', () => {
    const api = store.ensureBoard('api', { actor: 'tester' });
    const mcp = store.ensureBoard('mcp', { actor: 'tester' });
    expect(api.key).toBe('api');
    expect(mcp.key).toBe('mcp');
  });

  test('buildPath still collapses that board to the root, since it cannot be linked to', () => {
    expect(buildPath({ board: 'api' })).toBe('/');
  });

  test('ensureBoard still accepts normal keys', () => {
    for (const key of ['rocky', 'MyProject', '_private', 'a-b']) {
      const board = store.ensureBoard(key, { actor: 'tester' });
      expect(board.key).toBe(key);
    }
  });

  // finding 2 회귀 테스트: validation 이 생기기 전 구버전 데몬이 `my repo` 같은 malformed
  // key 로 보드를 이미 만들어놨을 수 있다(공용 API 로는 더 이상 재현 불가 — public API 는
  // 이제 이런 key 의 CREATE 를 거부하므로, raw SQL 로 직접 심어 옛 상태를 흉내낸다).
  // 업그레이드 후에도 그 보드는 `ensureBoard`(lookup)로 계속 찾아지고, 거기에 todo 를
  // 추가하는 것도 계속 되어야 한다 — 검증은 CREATE 에만 걸려야지 기존 row 의 LOOKUP 을
  // 막으면 안 된다.
  test('ensureBoard returns a pre-existing malformed-key board unchanged (lookup, not create)', () => {
    const dbPath = join(dir, 'todo.db');
    const raw = new Database(dbPath);
    raw
      .query('INSERT INTO boards (id, key, title, created_at) VALUES (?, ?, ?, ?)')
      .run('legacy-board-id', 'my repo', 'my repo', new Date().toISOString());
    raw.close();

    const board = store.ensureBoard('my repo', { actor: 'tester' });
    expect(board.id).toBe('legacy-board-id');
    expect(board.key).toBe('my repo');

    const todo = store.createTodo({ board: 'my repo', title: '레거시 보드 작업' }, 'tester');
    expect(todo.boardId).toBe('legacy-board-id');
  });

  test('setBoardRepo stores the slug and it survives a reload', () => {
    const board = store.ensureBoard('rocky', { actor: 'tester' });
    expect(board.repo).toBeUndefined();

    const updated = store.setBoardRepo('rocky', 'minjun0219/rocky', 'tester');
    expect(updated.repo).toBe('minjun0219/rocky');
    expect(store.boardById(board.id)?.repo).toBe('minjun0219/rocky');
    expect(store.listBoards().find((b) => b.key === 'rocky')?.repo).toBe('minjun0219/rocky');
  });

  test('setBoardRepo does not create a board', () => {
    expect(() => store.setBoardRepo('nosuchboard', 'o/n', 'tester')).toThrow(/not found/);
    expect(store.listBoards()).toHaveLength(0);
  });

  // 저장된 값은 그대로 `gh -R` 인자가 된다 — 공백이 섞여 들어가면 이후 모든 이슈 생성이
  // 조용히 실패한다. 호출부가 이미 다듬지만 마지막 관문에서도 막는다.
  test('setBoardRepo trims the slug — history and reload see the clean value', () => {
    const board = store.ensureBoard('rocky', { actor: 'tester' });

    const updated = store.setBoardRepo('rocky', '  o/n\n', 'tester');
    expect(updated.repo).toBe('o/n');
    expect(store.boardById(board.id)?.repo).toBe('o/n');

    const entry = store.listHistory({ entityId: board.id }).find((h) => h.action === 'update');
    expect(entry?.changes?.repo?.[1]).toBe('o/n');
  });

  // `createIssueForTodo` 는 `options.repo` 가 오면 매번 setBoardRepo 를 부른다 —
  // `issue REF --repo o/n` 반복이나 웹 UI 재시도가 같은 슬러그를 계속 넘기는 경로다.
  test('setBoardRepo is a no-op when the slug does not change', () => {
    const board = store.ensureBoard('rocky', { actor: 'tester' });
    store.setBoardRepo('rocky', 'o/n', 'tester');
    const before = store.listHistory({ entityId: board.id }).length;

    const again = store.setBoardRepo('rocky', 'o/n', 'tester');
    // trim 만으로 같아지는 값도 같은 값이다
    store.setBoardRepo('rocky', '  o/n  ', 'tester');

    expect(again.repo).toBe('o/n');
    expect(store.listHistory({ entityId: board.id })).toHaveLength(before);
  });

  test('setBoardRepo still records a real change', () => {
    const board = store.ensureBoard('rocky', { actor: 'tester' });
    store.setBoardRepo('rocky', 'o/n', 'tester');
    const before = store.listHistory({ entityId: board.id }).length;

    store.setBoardRepo('rocky', 'o/other', 'tester');

    expect(store.boardById(board.id)?.repo).toBe('o/other');
    expect(store.listHistory({ entityId: board.id }).length).toBe(before + 1);
  });

  test('boardById returns undefined for an unknown id', () => {
    expect(store.boardById('nosuchid')).toBeUndefined();
  });

  test('setBoardPath stores the path and survives a reload', () => {
    store.ensureBoard('rocky', { actor: 'logan' });
    const updated = store.setBoardPath('rocky', '/Users/x/dev/rocky-todo', 'logan');
    expect(updated.path).toBe('/Users/x/dev/rocky-todo');
    expect(store.getBoard('rocky')?.path).toBe('/Users/x/dev/rocky-todo');
  });

  test('setBoardPath trims whitespace and does not record history if value does not change', () => {
    const board = store.ensureBoard('rocky', { actor: 'logan' });
    store.setBoardPath('rocky', '  /Users/x/dev/rocky-todo  ', 'logan');
    const before = store.listHistory({ entity: 'board', entityId: board.id }).length;
    store.setBoardPath('rocky', '/Users/x/dev/rocky-todo', 'logan');
    expect(store.listHistory({ entity: 'board', entityId: board.id })).toHaveLength(before);
  });

  test('setBoardPath throws if board does not exist', () => {
    expect(() => store.setBoardPath('nope', '/tmp/x', 'logan')).toThrow(/board not found/);
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

  // 섹션에 넣는 길만 있고 빼는 길이 없으면, 웹 UI 에서 한번 지정한 섹션을 되돌릴 수 없다.
  // parentId 가 null 로 해제되는 것과 같은 대칭이 필요하다.
  test('section: null 로 섹션에서 뺄 수 있다', () => {
    const todo = store.createTodo({ board: 'rocky', title: 'a', section: '설계' }, 'tester');
    expect(todo.sectionId).toBeDefined();

    const bare = store.updateTodo(todo.id, { section: null }, 'tester');
    expect(bare.sectionId).toBeUndefined();

    // 섹션 자체는 남는다 — 삭제는 이 제품에 없다.
    expect(store.listSections(todo.boardId)).toHaveLength(1);
  });

  // updateTodo 만 공백을 걸러내면 createTodo 로는 여전히 빈 이름 섹션이 생긴다.
  test('createTodo 도 공백뿐인 section 이름으로 섹션을 만들지 않는다', () => {
    const todo = store.createTodo({ board: 'rocky', title: 'a', section: '  ' }, 'tester');
    expect(todo.sectionId).toBeUndefined();
    expect(store.listSections(todo.boardId)).toHaveLength(0);
  });

  test('createTodo 는 section 이름의 앞뒤 공백을 다듬어 같은 섹션으로 모은다', () => {
    const a = store.createTodo({ board: 'rocky', title: 'a', section: '설계' }, 'tester');
    const b = store.createTodo({ board: 'rocky', title: 'b', section: '  설계  ' }, 'tester');
    expect(b.sectionId).toBe(a.sectionId as string);
    expect(store.listSections(a.boardId)).toHaveLength(1);
  });

  test('section 을 빈 문자열로 주면 빈 이름 섹션을 만들지 않고 해제로 본다', () => {
    const todo = store.createTodo({ board: 'rocky', title: 'a', section: '설계' }, 'tester');
    const bare = store.updateTodo(todo.id, { section: '  ' }, 'tester');
    expect(bare.sectionId).toBeUndefined();
    expect(store.listSections(todo.boardId).map((s) => s.title)).toEqual(['설계']);
  });

  // 섹션을 아카이브했는데 항목의 section_id 가 남아 있으면, 웹 UI 는 그 항목을 어느
  // 그룹에도 넣지 못해 화면에서 증발시킨다 (섹션 그룹은 사라지고 '일반' 그룹은
  // sectionId 가 없는 것만 모은다). 섹션이 사라지면 항목은 미분류로 돌아와야 한다.
  test('섹션을 아카이브하면 그 안의 항목은 미분류로 돌아온다', () => {
    const a = store.createTodo({ board: 'rocky', title: 'a', section: '설계' }, 'tester');
    const b = store.createTodo({ board: 'rocky', title: 'b', section: '설계' }, 'tester');
    const other = store.createTodo({ board: 'rocky', title: 'c', section: '검증' }, 'tester');
    const sectionId = a.sectionId as string;

    store.archiveSection(sectionId, 'tester');

    expect(store.getTodo(a.id)?.sectionId).toBeUndefined();
    expect(store.getTodo(b.id)?.sectionId).toBeUndefined();
    // 다른 섹션은 건드리지 않는다
    expect(store.getTodo(other.id)?.sectionId).toBe(other.sectionId as string);
    expect(store.listSections(a.boardId).map((s) => s.title)).toEqual(['검증']);
  });

  // store 의 원칙은 "모든 mutation 은 history 를 남긴다" 다. 섹션 아카이브가 todo 의
  // section_id 를 바꾸는 것도 그 todo 에 일어난 변경이므로, 상세 타임라인에서 왜 섹션이
  // 풀렸는지 설명될 수 있어야 한다.
  test('섹션 아카이브는 영향받은 각 todo 에도 히스토리를 남긴다', () => {
    const a = store.createTodo({ board: 'rocky', title: 'a', section: '설계' }, 'tester');
    const b = store.createTodo({ board: 'rocky', title: 'b', section: '설계' }, 'tester');
    const sectionId = a.sectionId as string;

    store.archiveSection(sectionId, 'logan');

    for (const todo of [a, b]) {
      const entries = store.listHistory({ entityId: todo.id });
      const unset = entries.find((e) => e.changes && 'section' in e.changes);
      expect(unset).toBeDefined();
      expect(unset?.actor).toBe('logan');
      expect(unset?.changes?.section).toEqual([sectionId, null]);
    }

    // 섹션 자체의 archive 이력도 그대로 남는다
    expect(store.listHistory({ entityId: sectionId }).some((e) => e.action === 'archive')).toBe(
      true,
    );
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

  test('createTodo accepts a bare-number parentId, resolved against its own board', () => {
    const parent = store.createTodo({ board: 'rocky', title: '부모' }, 'tester');
    const child = store.createTodo(
      { board: 'rocky', title: '자식', parentId: String(parent.number) },
      'tester',
    );
    expect(child.parentId).toBe(parent.id);
  });

  test('createTodo does not leak a bare-number parentId across boards', () => {
    // otherBoard#1 존재. rocky 보드에서 같은 번호(1)로 부모를 지정해도 rocky#1 만 봐야 한다 —
    // withBoard 가 board 를 안 실어 보내는 실수를 하면 여기서 otherBoard#1 로 잘못 연결된다.
    const otherParent = store.createTodo({ board: 'other', title: '다른 보드 부모' }, 'tester');
    const rockyParent = store.createTodo({ board: 'rocky', title: 'rocky 부모' }, 'tester');
    expect(otherParent.number).toBe(rockyParent.number); // 둘 다 각 보드의 1번

    const child = store.createTodo(
      { board: 'rocky', title: '자식', parentId: String(rockyParent.number) },
      'tester',
    );
    expect(child.parentId).toBe(rockyParent.id);
    expect(child.parentId).not.toBe(otherParent.id);
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
    expect(store.getTodo(idPrefix(todo.id))?.id).toBe(todo.id);
    expect(store.getTodo('nope1234')).toBeUndefined();
  });

  // finding 7: createTodo 의 재부모 지정 경로(위 '보드 밖으로 안 샌다' 테스트)는 이미
  // 커버돼 있었지만, updateTodo 로 기존 todo 를 재부모 지정하는 경로에는 대응하는
  // 테스트가 없었다.
  test('updateTodo accepts a bare-number parentId, resolved against its own board', () => {
    const parent = store.createTodo({ board: 'rocky', title: '부모' }, 'tester');
    const child = store.createTodo({ board: 'rocky', title: '자식' }, 'tester');
    const updated = store.updateTodo(child.id, { parentId: String(parent.number) }, 'tester');
    expect(updated.parentId).toBe(parent.id);
  });

  test('updateTodo 의 bare-number parentId 는 보드 밖으로 새지 않는다', () => {
    // other#1 존재. rocky 보드의 todo 를 같은 번호(1)로 재부모 지정해도 rocky#1 만
    // 봐야 한다 — mustGetTodo(patch.parentId, current.boardId) 가 current 의 board 를
    // 안 실어 보내면 other#1 로 잘못 연결된다.
    const otherParent = store.createTodo({ board: 'other', title: '다른 보드 부모' }, 'tester');
    const rockyParent = store.createTodo({ board: 'rocky', title: 'rocky 부모' }, 'tester');
    expect(otherParent.number).toBe(rockyParent.number); // 둘 다 각 보드의 1번
    const child = store.createTodo({ board: 'rocky', title: '자식' }, 'tester');

    const updated = store.updateTodo(child.id, { parentId: String(rockyParent.number) }, 'tester');
    expect(updated.parentId).toBe(rockyParent.id);
    expect(updated.parentId).not.toBe(otherParent.id);
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

  test('excludeActions filters rows out at the query, not after — omitting it returns everything', () => {
    const todo = store.createTodo({ board: 'rocky', title: '작업' }, 'claude-code');
    store.setTodoStatus(todo.id, 'start', 'claude-code');
    store.addComment(todo.id, '진행 중', 'claude-code');
    store.setTodoStatus(todo.id, 'done', 'claude-code');

    const filtered = store.listHistory({ entityId: todo.id, excludeActions: ['comment'] });
    expect(filtered.map((h) => h.action)).toEqual(['done', 'start', 'create']);

    const unfiltered = store.listHistory({ entityId: todo.id });
    expect(unfiltered.map((h) => h.action)).toEqual(['done', 'comment', 'start', 'create']);
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

  test('글로벌 노트는 보드 컨텍스트 없이 #N 으로 전역 번호 공간에서 찾는다', () => {
    const g = store.createNote({ title: '글로벌 메모', content: '' }, 'tester');
    expect(store.getNote(`#${g.number}`)?.id).toBe(g.id);
    expect(store.getNote(String(g.number))?.id).toBe(g.id);
  });

  test('보드 노트와 글로벌 노트가 번호를 공유해도 서로 다른 행으로 해석된다', () => {
    const board = store.ensureBoard('alpha', { actor: 'tester' });
    const boardNote = store.createNote({ board: 'alpha', title: '보드 메모' }, 'tester');
    const globalNote = store.createNote({ title: '글로벌 메모' }, 'tester');
    expect(boardNote.number).toBe(globalNote.number);

    expect(store.getNote(`#${globalNote.number}`)?.id).toBe(globalNote.id);
    expect(store.getNote(`#${boardNote.number}`, board.id)?.id).toBe(boardNote.id);
  });

  test('todos 는 글로벌 번호 공간이 없어 보드 컨텍스트 없는 #N 은 여전히 에러다', () => {
    store.createTodo({ board: 'alpha', title: '대상' }, 'tester');
    expect(() => store.getTodo('#1')).toThrow(/board/i);
  });

  // finding 5: id LIKE '?%' 에 입력이 이스케이프 없이 그대로 들어가던 문제.
  test('빈 ref/공백 ref 는 모든 행에 매치되지 않고 에러로 거부된다', () => {
    store.createTodo({ board: 'alpha', title: '유일한 항목' }, 'tester');
    expect(() => store.getTodo('')).toThrow();
    expect(() => store.getTodo('   ')).toThrow();
  });

  test('id prefix 에 SQL LIKE 와일드카드(%, _)가 섞이면 엉뚱한 행에 매치되지 않고 에러다', () => {
    const t = store.createTodo({ board: 'alpha', title: '대상' }, 'tester');
    // '_' 는 LIKE 에서 "아무 문자 1개" 와일드카드다 — 고치기 전에는 `_` + id[1:] 이
    // id[0] 이 무엇이든 그 id 에 매치될 수 있었다(finding 5 재현: `_yaz90tj` → `xyaz90tj`).
    const wildcardPrefix = `_${t.id.slice(1)}`;
    expect(() => store.getTodo(wildcardPrefix)).toThrow(/invalid id prefix/);
    expect(() => store.getTodo('%')).toThrow(/invalid id prefix/);
  });

  // finding A/6: 스코프 정규식은 board key 부분을 넓게 받아야 하지만(`sanitizeKey` 가
  // 만들 수 있는 모든 키), board 조회 자체는 SQLite 기본대로 대소문자를 구분해야 한다.
  // 이전 테스트(`getTodo('ROCKY#1') === undefined`)는 고치기 전 코드(스코프 정규식이
  // 대문자를 애초에 매칭하지 않던 상태)에서도 우연히 통과해 아무것도 pin 하지 못했다 —
  // 여기서는 `ROCKY` 가 정규식엔 매칭되고도(board 부분이 넓어졌으니) 대소문자 다른
  // 보드로 조용히 풀리지 않는지를 실제로 검증한다.
  test('대소문자가 다른 board#N 참조는 다른 보드로 조용히 풀리지 않고 undefined 다', () => {
    store.ensureBoard('rocky', { actor: 'tester' });
    store.createTodo({ board: 'rocky', title: '대상' }, 'tester');
    expect(store.getTodo('ROCKY#1')).toBeUndefined();
  });

  // finding A: sanitizeKey(src/actor.ts) 는 `[a-zA-Z0-9_-]` 를 보존하므로 대문자로
  // 시작하거나(`MyProject`) `_`/`-` 로 시작하는(`_private`) board key 도 나올 수 있다.
  // 서버가 `ref: "MyProject#1"` 처럼 직렬화해 웹 UI 가 그대로 클립보드에 복사하는 값이라,
  // resolveRef 가 이 형태를 못 읽으면 제품이 스스로 만든 참조를 스스로 못 먹는 꼴이 된다.
  test('대문자로 시작하는 board key 의 board#N 참조가 resolve 된다', () => {
    store.ensureBoard('MyProject', { actor: 'tester' });
    const t = store.createTodo({ board: 'MyProject', title: '대상' }, 'tester');
    expect(store.getTodo('MyProject#1')?.id).toBe(t.id);
  });

  test('밑줄로 시작하는 board key 의 board#N 참조가 resolve 된다 — id-prefix 와일드카드 가드를 타지 않는다', () => {
    store.ensureBoard('_private', { actor: 'tester' });
    const t = store.createTodo({ board: '_private', title: '대상' }, 'tester');
    // 고치기 전엔 `_private#1` 이 scoped 분기에 안 걸리고 id-prefix 분기까지 흘러가,
    // '_' 가 SQL LIKE 와일드카드로 해석돼 `invalid id prefix` 에러를 던졌다(제품이 만든
    // 참조를 제품이 못 먹는 정도가 아니라 크래시까지 났다).
    expect(() => store.getTodo('_private#1')).not.toThrow();
    expect(store.getTodo('_private#1')?.id).toBe(t.id);
  });

  test('rocky-12 형태(신규 표기)로 보드를 지정해 찾는다', () => {
    const t = store.createTodo({ board: 'rocky', title: '신규 표기' }, 'tester');
    expect(store.getTodo(`rocky-${t.number}`)?.id).toBe(t.id);
  });

  // board key 에 `-` 가 흔하다(`rocky-todo`). greedy 파싱이 **가장 오른쪽** `-` 에서
  // 갈라야 `rocky-todo-1` 이 보드 `rocky-todo` 의 1번으로 읽힌다 — 왼쪽에서 자르면
  // 존재하지 않는 보드 `rocky` 를 찾다 undefined 가 된다.
  test('board key 에 `-` 가 있어도 가장 오른쪽 `-` 에서 갈린다', () => {
    const t = store.createTodo({ board: 'rocky-todo', title: '하이픈 보드' }, 'tester');
    expect(store.getTodo(`rocky-todo-${t.number}`)?.id).toBe(t.id);
  });

  test('없는 보드를 가리키는 신규 표기는 undefined 다', () => {
    store.createTodo({ board: 'rocky', title: '있음' }, 'tester');
    expect(store.getTodo('no-such-board-1')).toBeUndefined();
  });

  // `note-N` 은 언제나 전역 메모 번호 공간이다 — 보드 컨텍스트를 줘도 무시한다.
  test('note-N 은 전역 메모를 가리키고 board 컨텍스트를 무시한다', () => {
    const board = store.ensureBoard('rocky', { actor: 'tester' });
    const globalNote = store.createNote({ title: '전역 메모' }, 'tester');
    expect(store.getNote(`note-${globalNote.number}`)?.id).toBe(globalNote.id);
    expect(store.getNote(`note-${globalNote.number}`, board.id)?.id).toBe(globalNote.id);
  });

  test('note-N 은 todos 에서는 풀리지 않는다 (전역 todo 번호 공간은 없다)', () => {
    store.createTodo({ board: 'rocky', title: '있음' }, 'tester');
    expect(store.getTodo('note-1')).toBeUndefined();
  });

  // 구 표기는 입력으로 계속 받는다 — 대화·댓글·히스토리에 이미 박혀 있다.
  test('구 표기 rocky#12 는 계속 풀린다', () => {
    const t = store.createTodo({ board: 'rocky', title: '구 표기' }, 'tester');
    expect(store.getTodo(`rocky#${t.number}`)?.id).toBe(t.id);
  });
});

describe('comments', () => {
  test('addComment stores a comment and records history on the parent todo', () => {
    const todo = store.createTodo({ board: 'rocky', title: '작업' }, 'logan');
    const comment = store.addComment(todo.id, '  진행 중입니다  ', 'claude-code');

    expect(comment.todoId).toBe(todo.id);
    expect(comment.actor).toBe('claude-code');
    expect(comment.body).toBe('진행 중입니다');
    expect(comment.archivedAt).toBeUndefined();

    const history = store.listHistory({ entityId: todo.id });
    const entry = history.find((h) => h.action === 'comment');
    expect(entry).toBeDefined();
    expect(entry?.entity).toBe('todo');
    expect(entry?.actor).toBe('claude-code');
    expect(entry?.changes?.comment).toEqual([null, '진행 중입니다']);
  });

  test('addComment accepts a board-scoped ref', () => {
    const todo = store.createTodo({ board: 'rocky', title: '작업' }, 'logan');
    const comment = store.addComment(`rocky#${todo.number}`, '참조로 달기', 'logan');
    expect(comment.todoId).toBe(todo.id);
  });

  test('addComment rejects a blank body', () => {
    const todo = store.createTodo({ board: 'rocky', title: '작업' }, 'logan');
    expect(() => store.addComment(todo.id, '   \n  ', 'logan')).toThrow(/body is required/);
  });

  test('listComments returns oldest first and hides archived by default', () => {
    const todo = store.createTodo({ board: 'rocky', title: '작업' }, 'logan');
    const first = store.addComment(todo.id, '첫째', 'logan');
    const second = store.addComment(todo.id, '둘째', 'claude-code');

    expect(store.listComments(todo.id).map((c) => c.body)).toEqual(['첫째', '둘째']);

    store.setCommentArchived(first.id, true, 'logan');
    expect(store.listComments(todo.id).map((c) => c.id)).toEqual([second.id]);
    expect(store.listComments(todo.id, true).map((c) => c.id)).toEqual([first.id, second.id]);
  });

  // finding: 정렬 타이브레이크가 랜덤 id 였을 때 같은 밀리초의 두 댓글 순서가 비결정적이었다.
  // id 의 사전순을 삽입 순서와 **반대로** 심어, rowid 타이브레이크가 아니면 반드시 실패하게 한다.
  test('same-millisecond comments come back in insertion order, not id order', () => {
    const todo = store.createTodo({ board: 'rocky', title: '작업' }, 'logan');
    const at = '2026-07-26T01:00:00.000Z';
    const raw = new Database(join(dir, 'todo.db'));
    const insert = raw.query(
      'INSERT INTO comments (id, todo_id, actor, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    insert.run('zzzzzzzz', todo.id, 'logan', '먼저 쓴 댓글', at, at);
    insert.run('aaaaaaaa', todo.id, 'logan', '나중에 쓴 댓글', at, at);
    raw.close();

    expect(store.listComments(todo.id).map((c) => c.body)).toEqual([
      '먼저 쓴 댓글',
      '나중에 쓴 댓글',
    ]);
  });

  test('updateComment rewrites the body and records comment-edit', () => {
    const todo = store.createTodo({ board: 'rocky', title: '작업' }, 'logan');
    const comment = store.addComment(todo.id, '오타 있음', 'logan');
    const updated = store.updateComment(comment.id, '오타 고침', 'logan');

    expect(updated.body).toBe('오타 고침');
    const entry = store.listHistory({ entityId: todo.id }).find((h) => h.action === 'comment-edit');
    expect(entry?.changes?.comment).toEqual(['오타 있음', '오타 고침']);
  });

  test('setCommentArchived toggles archivedAt and records history', () => {
    const todo = store.createTodo({ board: 'rocky', title: '작업' }, 'logan');
    const comment = store.addComment(todo.id, '잘못 달았다', 'logan');

    const archived = store.setCommentArchived(comment.id, true, 'logan');
    expect(archived.archivedAt).toBeDefined();

    const restored = store.setCommentArchived(comment.id, false, 'logan');
    expect(restored.archivedAt).toBeUndefined();

    const actions = store.listHistory({ entityId: todo.id }).map((h) => h.action);
    expect(actions).toContain('comment-archive');
    expect(actions).toContain('comment-unarchive');
  });

  test('unknown comment id throws not found', () => {
    expect(() => store.updateComment('nosuchid', '본문', 'logan')).toThrow(/comment not found/);
  });

  test('commentStatsOf counts only unarchived comments', () => {
    const todo = store.createTodo({ board: 'rocky', title: '작업' }, 'logan');
    expect(store.commentStatsOf(todo.id)).toEqual({ count: 0, lastAt: undefined });

    const first = store.addComment(todo.id, '첫째', 'logan');
    const second = store.addComment(todo.id, '둘째', 'logan');
    const stats = store.commentStatsOf(todo.id);
    expect(stats.count).toBe(2);
    expect(stats.lastAt).toBe(second.createdAt);

    store.setCommentArchived(second.id, true, 'logan');
    const after = store.commentStatsOf(todo.id);
    expect(after.count).toBe(1);
    expect(after.lastAt).toBe(first.createdAt);
  });
});

describe('handoffs', () => {
  test('생성하면 pending 이고 todo 히스토리에 남는다', () => {
    const todo = store.createTodo({ board: 'rocky-todo', title: '핸드오프 대상' }, 'logan');

    const handoff = store.createHandoff({
      ref: todo.id,
      sessionId: 'sess-1',
      sessionName: 'eelpout-a3',
      sessionCwd: '/w/rocky-todo/eelpout',
      note: '테스트부터',
      actor: 'logan',
    });

    expect(handoff.status).toBe('pending');
    expect(handoff.todoId).toBe(todo.id);
    expect(handoff.note).toBe('테스트부터');
    const history = store.listHistory({ entityId: todo.id });
    expect(history.some((h) => h.action === 'handoff')).toBe(true);
  });

  test('같은 todo 에 pending 이 이미 있으면 pendingHandoffOf 가 그것을 준다', () => {
    const todo = store.createTodo({ board: 'rocky-todo', title: 'x' }, 'logan');
    const first = store.createHandoff({ ref: todo.id, sessionId: 'sess-1', actor: 'logan' });
    expect(store.pendingHandoffOf(todo.id)?.id).toBe(first.id);
  });

  test('아카이브된 todo 로는 만들 수 없다', () => {
    const todo = store.createTodo({ board: 'rocky-todo', title: 'x' }, 'logan');
    store.setTodoStatus(todo.id, 'archive', 'logan');
    expect(() => store.createHandoff({ ref: todo.id, sessionId: 's', actor: 'logan' })).toThrow(
      /archived/i,
    );
  });

  test('claim 은 가장 오래된 한 건만 가져가고 잔여 수를 알려준다', () => {
    const a = store.createTodo({ board: 'rocky-todo', title: '첫째' }, 'logan');
    const b = store.createTodo({ board: 'rocky-todo', title: '둘째' }, 'logan');
    store.createHandoff({ ref: a.id, sessionId: 'sess-1', actor: 'logan' });
    store.createHandoff({ ref: b.id, sessionId: 'sess-1', actor: 'logan' });

    const claimed = store.claimHandoff('sess-1', 'stop');
    expect(claimed?.todoTitle).toBe('첫째');
    expect(claimed?.todoRef).toBe('rocky-todo-1');
    expect(claimed?.remaining).toBe(1);
    expect(claimed?.handoff.status).toBe('delivered');
    expect(claimed?.handoff.deliveredVia).toBe('stop');

    const second = store.claimHandoff('sess-1', 'prompt');
    expect(second?.todoTitle).toBe('둘째');
    expect(second?.remaining).toBe(0);

    expect(store.claimHandoff('sess-1', 'stop')).toBeNull();
  });

  test('claim 은 다른 세션 앞의 요청을 가져가지 않는다', () => {
    const todo = store.createTodo({ board: 'rocky-todo', title: 'x' }, 'logan');
    store.createHandoff({ ref: todo.id, sessionId: 'sess-1', actor: 'logan' });
    expect(store.claimHandoff('sess-2', 'stop')).toBeNull();
  });

  test('취소하면 cancelled 가 되고 다시 claim 되지 않는다', () => {
    const todo = store.createTodo({ board: 'rocky-todo', title: 'x' }, 'logan');
    const handoff = store.createHandoff({ ref: todo.id, sessionId: 'sess-1', actor: 'logan' });
    const cancelled = store.cancelHandoff(handoff.id, 'logan');
    expect(cancelled.status).toBe('cancelled');
    expect(store.claimHandoff('sess-1', 'stop')).toBeNull();
    expect(store.pendingHandoffOf(todo.id)).toBeUndefined();
  });

  test('이미 배달된 건은 취소할 수 없다', () => {
    const todo = store.createTodo({ board: 'rocky-todo', title: 'x' }, 'logan');
    const handoff = store.createHandoff({ ref: todo.id, sessionId: 'sess-1', actor: 'logan' });
    store.claimHandoff('sess-1', 'stop');
    expect(() => store.cancelHandoff(handoff.id, 'logan')).toThrow(/pending/i);
  });

  test('listHandoffs 는 보드로 거를 수 있다', () => {
    const mine = store.createTodo({ board: 'rocky-todo', title: 'x' }, 'logan');
    const other = store.createTodo({ board: 'forses', title: 'y' }, 'logan');
    store.createHandoff({ ref: mine.id, sessionId: 's1', actor: 'logan' });
    store.createHandoff({ ref: other.id, sessionId: 's2', actor: 'logan' });

    const boardId = store.boardIdOf('rocky-todo');
    const listed = store.listHandoffs({ boardId, status: 'pending' });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.todoId).toBe(mine.id);
  });

  test('handoff 액션은 /api/changes 피드에서 빠진다 — 다른 세션에 노이즈를 뿌리지 않는다', () => {
    const todo = store.createTodo({ board: 'rocky-todo', title: 'x' }, 'logan');
    const before = store.listChangesSince(0).lastId;
    store.createHandoff({ ref: todo.id, sessionId: 'sess-1', actor: 'logan' });

    const feed = store.listChangesSince(before);
    expect(feed.entries.some((e) => e.action.startsWith('handoff'))).toBe(false);
    // 커서는 그래도 전진해야 한다 — 아니면 같은 항목을 영원히 다시 읽는다.
    expect(feed.lastId).toBeGreaterThan(before);
  });

  describe('createSpawnedHandoff', () => {
    test('생성 즉시 delivered / via=spawn 이다', () => {
      const todo = store.createTodo({ board: 'rocky-todo', title: '세션 띄우기' }, 'logan');
      const handoff = store.createSpawnedHandoff({
        ref: todo.id,
        sessionId: '5acaaaeb',
        sessionName: 'rocky-todo-16',
        sessionCwd: '/repo/.claude/worktrees/todo-16',
        note: '테스트부터',
        actor: 'logan',
      });
      expect(handoff.status).toBe('delivered');
      expect(handoff.deliveredVia).toBe('spawn');
      expect(handoff.deliveredAt).toBeTruthy();
      expect(handoff.sessionCwd).toBe('/repo/.claude/worktrees/todo-16');
    });

    test('pending 이 아니므로 claim 대상이 아니다', () => {
      const todo = store.createTodo({ board: 'rocky-todo', title: 'x' }, 'logan');
      store.createSpawnedHandoff({
        ref: todo.id,
        sessionId: '5acaaaeb',
        sessionName: 'n',
        sessionCwd: '/w',
        actor: 'logan',
      });
      expect(store.pendingHandoffOf(todo.id)).toBeUndefined();
      expect(store.claimHandoff('5acaaaeb', 'stop')).toBeNull();
    });

    test('히스토리에 handoff-spawn 을 남긴다', () => {
      const todo = store.createTodo({ board: 'rocky-todo', title: 'x' }, 'logan');
      store.createSpawnedHandoff({
        ref: todo.id,
        sessionId: '5acaaaeb',
        sessionName: 'n',
        sessionCwd: '/w',
        actor: 'logan',
      });
      const actions = store.listHistory({ entityId: todo.id }).map((h) => h.action);
      expect(actions).toContain('handoff-spawn');
    });

    test('/api/changes 피드에서는 빠진다 — 다른 세션의 프롬프트 주입에 실리면 노이즈다', () => {
      const todo = store.createTodo({ board: 'rocky-todo', title: 'x' }, 'logan');
      const before = store.listChangesSince(0).lastId;
      store.createSpawnedHandoff({
        ref: todo.id,
        sessionId: '5acaaaeb',
        sessionName: 'n',
        sessionCwd: '/w',
        actor: 'logan',
      });

      const feed = store.listChangesSince(before);
      expect(feed.entries.some((e) => e.action.startsWith('handoff'))).toBe(false);
      // 커서는 그래도 전진해야 한다 — 아니면 같은 항목을 영원히 다시 읽는다.
      expect(feed.lastId).toBeGreaterThan(before);
    });

    test('아카이브된 todo 에는 만들지 않는다', () => {
      const todo = store.createTodo({ board: 'rocky-todo', title: 'x' }, 'logan');
      store.setTodoStatus(todo.id, 'archive', 'logan');
      expect(() =>
        store.createSpawnedHandoff({
          ref: todo.id,
          sessionId: '5acaaaeb',
          sessionName: 'n',
          sessionCwd: '/w',
          actor: 'logan',
        }),
      ).toThrow(/archived/);
    });
  });
});
