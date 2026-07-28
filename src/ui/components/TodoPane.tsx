import { useState } from 'react';
import type { TodoView } from '../../server';
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
  const childrenOf = new Map<string, TodoView[]>();
  const roots: TodoView[] = [];
  for (const todo of todos) {
    if (todo.parentId && byId.has(todo.parentId)) {
      const siblings = childrenOf.get(todo.parentId) ?? [];
      siblings.push(todo);
      childrenOf.set(todo.parentId, siblings);
    } else {
      roots.push(todo);
    }
  }

  const renderTree = (items: TodoView[], depth: number): React.ReactNode =>
    items.map((todo) => (
      <div key={todo.id}>
        <TodoItem todo={todo} depth={depth} />
        {renderTree(childrenOf.get(todo.id) ?? [], depth + 1)}
      </div>
    ));

  // 그룹핑 — 보드 뷰: 섹션별 / 전체 뷰: 보드별
  const groups: { key: string; title: string; items: TodoView[] }[] = [];
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
    // 빈 섹션은 그리지 않는다 — 섹션은 항목을 담을 때만 의미가 있고, 빈 헤더가 쌓이면
    // 노이즈다. 드로어에서 항목을 옮기면 그때 나타난다.
    for (const section of sections) {
      const items = roots.filter((t) => t.sectionId === section.id);
      if (items.length > 0) {
        groups.push({ key: section.id, title: section.title, items });
      }
    }
  }

  return (
    <main className="todo-pane min-w-0 overflow-y-auto px-[26px] py-5 max-[900px]:shrink-0 max-[900px]:overflow-y-visible max-[900px]:px-3.5 max-[900px]:pt-3.5 max-[900px]:pb-1.5">
      {selected !== 'all' && (
        <form
          // sticky 배경: .todo-pane 은 배경색이 없어 body 의 --bg 위라, 같은 색을 깔아
          // 스크롤된 항목이 입력 뒤로 비쳐 보이지 않게 한다. 간격은 margin 대신 padding —
          // margin 은 collapse 돼 칠해진 배경이 시각적 간격보다 짧게 끝난다.
          className="quick-add sticky top-0 z-[1] bg-(--bg) pb-[18px]"
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
            className="quick-add-input w-full rounded-lg border border-(--line-strong) bg-(--surface) px-3.5 py-[9px] text-(--text) placeholder:text-(--faint) max-[900px]:text-base"
            placeholder="+ 새 작업 (Enter 로 추가)"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
        </form>
      )}

      {groups.length === 0 && (
        <div className="empty-state px-1 py-[18px] text-[13px] text-(--faint)">
          아직 항목이 없다.{' '}
          {selected === 'all'
            ? '보드를 골라 작업을 추가해 보자.'
            : '위 입력창으로 첫 작업을 추가하자.'}
        </div>
      )}

      {groups.map((group) => (
        <section key={group.key} className="todo-group mb-[26px]">
          <div className="group-eyebrow mb-1.5 border-b border-(--line) pb-[5px] font-(family-name:--mono) text-[10px] uppercase tracking-[0.22em] text-(--warm-dim)">
            {group.title}
          </div>
          {renderTree(group.items, 0)}
        </section>
      ))}
    </main>
  );
}
