import type { Todo } from '../../store';
import { actorTone, formatDue, formatElapsed, isOverdue, isStale, linkLabel } from '../lib';
import { useUiStore } from '../store';

interface TodoItemProps {
  todo: Todo;
  depth: number;
}

/** todo 한 줄 — 체크박스 + 제목 + 메타 칩 + doing 뱃지. 클릭 시 상세 드로어. */
export function TodoItem({ todo, depth }: TodoItemProps) {
  const setTodoStatus = useUiStore((s) => s.setTodoStatus);
  const openTodoDetail = useUiStore((s) => s.openTodoDetail);

  const done = todo.status === 'done';
  const doing = todo.status === 'doing';
  const stale = doing && isStale(todo.doingSince);

  return (
    <div
      className={`todo-row ${done ? 'is-done' : ''} ${todo.archivedAt ? 'is-archived' : ''}`}
      style={{ paddingLeft: `${depth * 22}px` }}
    >
      <input
        type="checkbox"
        className="todo-check"
        checked={done}
        title={done ? '다시 열기' : '완료'}
        onChange={() => void setTodoStatus(todo.id, done ? 'reopen' : 'done')}
      />
      <button type="button" className="todo-title" onClick={() => void openTodoDetail(todo.id)}>
        {todo.title}
      </button>
      {todo.priority !== 'p4' && (
        <span className={`chip prio-${todo.priority}`}>{todo.priority}</span>
      )}
      {todo.labels.map((label) => (
        <span key={label} className="chip chip-label">
          {label}
        </span>
      ))}
      {todo.due && (
        <span className={`chip chip-due ${!done && isOverdue(todo.due) ? 'is-overdue' : ''}`}>
          {formatDue(todo.due)}
        </span>
      )}
      {todo.links.map((link) => (
        <a
          key={link.url}
          className="chip chip-link"
          href={link.url}
          target="_blank"
          rel="noreferrer"
          title={link.title ?? link.url}
          onClick={(e) => e.stopPropagation()}
        >
          {link.title ?? linkLabel(link.url)} ↗
        </a>
      ))}
      {doing && todo.doingBy && (
        <span
          className={`doing-badge tone-${actorTone(todo.doingBy)} ${stale ? 'is-stale' : ''}`}
          title={stale ? '30분 이상 갱신 없음' : '처리중'}
        >
          <span className="doing-pulse" />
          {todo.doingBy} · {todo.doingSince ? formatElapsed(todo.doingSince) : ''}
          {stale ? ' ⚠' : ''}
        </span>
      )}
    </div>
  );
}
