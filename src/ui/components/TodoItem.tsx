import { useState } from 'react';
import type { TodoView } from '../../server';
import {
  actorTone,
  boardCommand,
  copyRefWithFeedback,
  doingWarning,
  formatDue,
  formatElapsed,
  hasUnreadComments,
  isOverdue,
  linkLabel,
} from '../lib';
import { useUiStore } from '../store';

interface TodoItemProps {
  todo: TodoView;
  depth: number;
}

/** todo 한 줄 — 번호(클릭 복사) + 체크박스 + 제목 + 메타 칩 + 댓글 뱃지 + doing 뱃지. 클릭 시 상세 드로어. */
export function TodoItem({ todo, depth }: TodoItemProps) {
  const setTodoStatus = useUiStore((s) => s.setTodoStatus);
  const openTodoDetail = useUiStore((s) => s.openTodoDetail);
  const seenComments = useUiStore((s) => s.seenComments);
  const pendingHandoff = useUiStore((s) =>
    s.handoffs.find((h) => h.todoId === todo.id && h.status === 'pending'),
  );
  const [copied, setCopied] = useState(false);

  const done = todo.status === 'done';
  const doing = todo.status === 'doing';
  const warning = doing ? doingWarning(todo) : null;
  // 커서는 zustand 상태에서 읽는다 — localStorage 를 직접 읽으면 커서가 바뀌어도
  // 리렌더가 걸리지 않아 배지 강조가 다음 refetch 까지 안 풀린다.
  const unread = hasUnreadComments(todo, seenComments);

  const handleCopyRef = () => copyRefWithFeedback(boardCommand(todo.ref), setCopied);

  return (
    <div
      className={`todo-row flex min-h-8 items-center gap-2 rounded-md px-1.5 py-[5px] hover:bg-surface ${done ? 'is-done' : ''} ${todo.archivedAt ? 'is-archived' : ''}`}
      style={{ paddingLeft: `${depth * 22}px` }}
    >
      <label className="todo-check-hit">
        <input
          type="checkbox"
          className="todo-check"
          checked={done}
          title={done ? '다시 열기' : '완료'}
          aria-label={done ? '다시 열기' : '완료'}
          onChange={() => void setTodoStatus(todo.id, done ? 'reopen' : 'done')}
        />
      </label>
      <button
        type="button"
        className="todo-ref"
        onClick={() => void handleCopyRef()}
        title={copied ? '복사됨' : `${todo.ref} 복사`}
        aria-label={copied ? '복사됨' : `${todo.ref} 복사`}
      >
        {copied ? '✓' : todo.number}
      </button>
      <button
        type="button"
        className={`todo-title min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-left ${done ? 'text-faint line-through' : 'text-text hover:text-warm'}`}
        onClick={() => void openTodoDetail(todo.id)}
      >
        {todo.title}
      </button>
      {/*
        메타 칩 묶음. 넓은 화면에서는 `display: contents` 라 칩들이 그대로 `.todo-row` 의
        flex 아이템이 된다 — 이 래퍼가 생겨도 레이아웃이 바뀌지 않는다. 좁은 화면에서만
        실제 박스가 되어 제목 아래 줄로 내려간다(`responsive.css`).
      */}
      <span className="todo-meta">
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
        {todo.commentCount > 0 && (
          <button
            type="button"
            className={`comment-badge cursor-pointer border-none bg-transparent px-0.5 py-0 text-xs ${unread ? 'is-unread font-semibold text-inherit' : 'text-muted'}`}
            title={unread ? '읽지 않은 댓글이 있다' : '댓글 보기'}
            aria-label={
              unread
                ? `읽지 않은 댓글 ${todo.commentCount}개 — 눌러서 열기`
                : `댓글 ${todo.commentCount}개 — 눌러서 열기`
            }
            onClick={() => void openTodoDetail(todo.id)}
          >
            💬 {todo.commentCount}
          </button>
        )}
        {pendingHandoff ? (
          <span
            className="chip chip-handoff"
            title={`${pendingHandoff.sessionName ?? pendingHandoff.sessionId} 에게 보냄`}
          >
            → {pendingHandoff.sessionName ?? '세션'}
          </span>
        ) : null}
        {doing && todo.doingBy && (
          <span
            className={`doing-badge tone-${actorTone(todo.doingBy)} ${
              warning ? `is-stale warn-${warning.tone}` : ''
            }`}
            title={warning ? warning.title : '처리중'}
          >
            <span className="doing-pulse" />
            {todo.doingBy} · {todo.doingSince ? formatElapsed(todo.doingSince) : ''}
            {warning ? ` ⚠ ${warning.label}` : ''}
          </span>
        )}
      </span>
    </div>
  );
}
