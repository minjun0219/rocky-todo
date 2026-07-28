import { useState } from 'react';
import type { TodoView } from '../../server';
import {
  actorTone,
  copyRefWithFeedback,
  formatDue,
  formatElapsed,
  hasUnreadComments,
  isOverdue,
  isStale,
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
  const stale = doing && isStale(todo.doingSince);
  // 커서는 zustand 상태에서 읽는다 — localStorage 를 직접 읽으면 커서가 바뀌어도
  // 리렌더가 걸리지 않아 배지 강조가 다음 refetch 까지 안 풀린다.
  const unread = hasUnreadComments(todo, seenComments);

  const handleCopyRef = () => copyRefWithFeedback(todo.ref, setCopied);

  return (
    <div
      className={`todo-row ${done ? 'is-done' : ''} ${todo.archivedAt ? 'is-archived' : ''}`}
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
        {copied ? '✓' : `#${todo.number}`}
      </button>
      <button type="button" className="todo-title" onClick={() => void openTodoDetail(todo.id)}>
        {todo.title}
      </button>
      {/* 메타(칩·뱃지)를 한 랩에 담는다. 데스크톱에선 display:contents 라 지금과 같은
          한 줄 flex 이고, 모바일에선 이 랩이 통째로 둘째 줄이 되어 제목 시작선에
          맞춰 들여쓰인다 — 랩이 없으면 줄바꿈된 칩이 체크박스 밑까지 흘러가
          어느 항목 소속인지 모호해진다. 메타가 없으면 랩도 그리지 않는다(빈 줄 방지). */}
      {(todo.priority !== 'p4' ||
        todo.labels.length > 0 ||
        todo.due ||
        todo.links.length > 0 ||
        todo.commentCount > 0 ||
        pendingHandoff ||
        (doing && todo.doingBy)) && <span className="todo-meta">{renderMeta()}</span>}
    </div>
  );

  function renderMeta() {
    return (
      <>
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
            className={`comment-badge ${unread ? 'is-unread' : ''}`}
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
            className={`doing-badge tone-${actorTone(todo.doingBy)} ${stale ? 'is-stale' : ''}`}
            title={stale ? '30분 이상 갱신 없음' : '처리중'}
          >
            <span className="doing-pulse" />
            {todo.doingBy} · {todo.doingSince ? formatElapsed(todo.doingSince) : ''}
            {stale ? ' ⚠' : ''}
          </span>
        )}
      </>
    );
  }
}
