import { useState } from 'react';
import type { Todo } from '../../store';
import { useUiStore } from '../store';
import { TodoItem } from './TodoItem';

/**
 * 가운데 메인 — 선택된 보드의 섹션별 todo 트리 (전체 뷰에서는 보드별 그룹).
 * parentId 계층은 그룹 안에서 들여쓰기로 렌더된다.
 */
export function TodoPane() {
  const todos = useUiStore((s) => s.todos);
  const boards = useUiStore((s) => s.boards);
  const sections = useUiStore((s) => s.sections);
  const selected = useUiStore((s) => s.selected);
  const addTodo = useUiStore((s) => s.addTodo);
  const [draft, setDraft] = useState('');

  const byId = new Map(todos.map((t) => [t.id, t]));
  const childrenOf = new Map<string, Todo[]>();
  const roots: Todo[] = [];
  for (const todo of todos) {
    if (todo.parentId && byId.has(todo.parentId)) {
      const siblings = childrenOf.get(todo.parentId) ?? [];
      siblings.push(todo);
      childrenOf.set(todo.parentId, siblings);
    } else {
      roots.push(todo);
    }
  }

  const renderTree = (items: Todo[], depth: number): React.ReactNode =>
    items.map((todo) => (
      <div key={todo.id}>
        <TodoItem todo={todo} depth={depth} />
        {renderTree(childrenOf.get(todo.id) ?? [], depth + 1)}
      </div>
    ));

  // 그룹핑 — 보드 뷰: 섹션별 / 전체 뷰: 보드별
  const groups: { key: string; title: string; items: Todo[] }[] = [];
  if (selected === 'all') {
    const boardTitle = new Map(boards.map((b) => [b.id, b.title]));
    for (const board of boards) {
      const items = roots.filter((t) => t.boardId === board.id);
      if (items.length > 0) {
        groups.push({ key: board.id, title: boardTitle.get(board.id) ?? board.key, items });
      }
    }
  } else {
    const noSection = roots.filter((t) => !t.sectionId);
    if (noSection.length > 0) {
      groups.push({ key: '__none', title: '일반', items: noSection });
    }
    for (const section of sections) {
      const items = roots.filter((t) => t.sectionId === section.id);
      if (items.length > 0) {
        groups.push({ key: section.id, title: section.title, items });
      }
    }
  }

  return (
    <main className="todo-pane">
      {selected !== 'all' && (
        <form
          className="quick-add"
          onSubmit={(e) => {
            e.preventDefault();
            const title = draft.trim();
            if (title === '') {
              return;
            }
            setDraft('');
            void addTodo({ board: selected, title });
          }}
        >
          <input
            className="quick-add-input"
            placeholder="+ 새 작업 (Enter 로 추가)"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
        </form>
      )}

      {groups.length === 0 && (
        <div className="empty-state">
          아직 항목이 없다.{' '}
          {selected === 'all'
            ? '보드를 골라 작업을 추가해 보자.'
            : '위 입력창으로 첫 작업을 추가하자.'}
        </div>
      )}

      {groups.map((group) => (
        <section key={group.key} className="todo-group">
          <div className="group-eyebrow">{group.title}</div>
          {renderTree(group.items, 0)}
        </section>
      ))}
    </main>
  );
}
