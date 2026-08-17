import { useEffect, useRef, useState } from 'react';
import type { TodoView } from '../../server';
import { resolveDropBefore } from '../lib';
import { useUiStore } from '../store';
import { BoardHeader } from './BoardHeader';
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
  const moveTodo = useUiStore((s) => s.moveTodo);
  const [draft, setDraft] = useState('');
  /** 드래그 중인 todo 와 시작 포인터 — 핸들 pointerdown 에서 세팅, 같은 포인터의
   * pointerup 에서만 해제한다 (멀티터치의 다른 손가락이 드래그를 끊지 않게). */
  const [drag, setDrag] = useState<{ todoId: string; pointerId: number } | null>(null);
  /** 포인터가 올라간 행과 절반 위치 — 삽입선 표시용. */
  const [over, setOver] = useState<{ id: string; after: boolean } | null>(null);
  const overRef = useRef(over);
  overRef.current = over;

  const handleDown = (e: React.PointerEvent, todo: TodoView) => {
    e.preventDefault(); // 핸들에서의 텍스트 선택·스크롤 개시를 막는다 (touch-none 과 한 쌍)
    setDrag({ todoId: todo.id, pointerId: e.pointerId });
  };

  useEffect(() => {
    if (!drag) {
      return;
    }
    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== drag.pointerId) {
        return;
      }
      const row = document
        .elementFromPoint(e.clientX, e.clientY)
        ?.closest<HTMLElement>('[data-todo-id]');
      if (!row?.dataset.todoId) {
        setOver(null);
        return;
      }
      const rect = row.getBoundingClientRect();
      setOver({ id: row.dataset.todoId, after: e.clientY > rect.top + rect.height / 2 });
    };
    const finish = (commit: boolean) => {
      const dropped = overRef.current;
      setDrag(null);
      setOver(null);
      if (!commit || !dropped) {
        return;
      }
      const siblings = todos.map((t) => ({
        id: t.id,
        boardId: t.boardId,
        sectionId: t.sectionId,
        parentId: t.parentId,
      }));
      const target = resolveDropBefore(siblings, drag.todoId, dropped.id, dropped.after);
      if (target) {
        void moveTodo(drag.todoId, target.before);
      }
    };
    const onUp = (e: PointerEvent) => {
      if (e.pointerId === drag.pointerId) {
        finish(true);
      }
    };
    const onCancel = (e: PointerEvent) => {
      if (e.pointerId === drag.pointerId) {
        finish(false);
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
    };
  }, [drag, moveTodo, todos]);

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
      <div
        key={todo.id}
        // 삽입선 — 드래그 중 포인터가 올라간 행의 위(before) 또는 아래(after)에 표시
        className={
          over?.id === todo.id && drag
            ? over.after
              ? 'border-b-2 border-warm'
              : 'border-t-2 border-warm'
            : ''
        }
      >
        <TodoItem todo={todo} depth={depth} onHandleDown={handleDown} />
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

  // 보드 정체(이름·slug·설명·GitHub)는 그 보드를 보고 있을 때만 의미가 있다. 전체 뷰는
  // 여러 보드를 한 화면에 모으므로 헤더를 그리지 않는다.
  const currentBoard = selected === 'all' ? undefined : boards.find((b) => b.key === selected);

  return (
    <main className="todo-pane min-w-0 overflow-y-auto px-[26px] py-5">
      {/*
        `key` 로 보드가 바뀌면 헤더를 새로 만든다. 없으면 React 가 같은 인스턴스를 재사용해
        열려 있던 편집 폼과 그 입력값(직전 보드의 것)이 그대로 남고, 그 상태로 저장하면
        **지금 보고 있는 보드**가 직전 보드의 값으로 덮어써진다(rename 포함).
      */}
      {currentBoard && <BoardHeader key={currentBoard.key} board={currentBoard} />}
      {selected !== 'all' && (
        <form
          className="sticky top-0 z-[1] mb-3 border-b border-line bg-bg pb-3"
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
            className="quick-add-input mb-0 w-full rounded-lg border border-line bg-surface px-3.5 py-[9px] text-text placeholder:text-faint"
            placeholder="+ 새 작업 (Enter 로 추가)"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
        </form>
      )}

      {groups.length === 0 && (
        <div className="empty-state px-1 py-[18px] text-[13px] text-faint">
          아직 항목이 없다.{' '}
          {selected === 'all'
            ? '보드를 골라 작업을 추가해 보자.'
            : '위 입력창으로 첫 작업을 추가하자.'}
        </div>
      )}

      {groups.map((group) => (
        <section key={group.key} className="mb-[26px]">
          <div className="mb-1.5 border-b border-line pb-[5px] font-mono text-[10px] uppercase tracking-[0.22em] text-warm-dim">
            {group.title}
          </div>
          {renderTree(group.items, 0)}
        </section>
      ))}
    </main>
  );
}
