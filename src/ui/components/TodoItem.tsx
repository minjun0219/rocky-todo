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

/**
 * 칩 공통 — main 디자인의 윤곽선 알약. **색(text/border)은 여기 두지 않는다**: 같은
 * 프로퍼티의 유틸을 한 요소에 두 번 주면 나열 순서가 아니라 CSS 생성 순서로 결정돼
 * 비결정적이다(실측: chip-link 가 muted 로 떨어졌다). 변형마다 색을 명시한다.
 */
const CHIP =
  'chip shrink-0 whitespace-nowrap rounded-full border px-[7px] py-px font-(family-name:--mono) text-[10px]';
const CHIP_NEUTRAL = 'border-(--line) text-(--muted)';

/**
 * 우선순위 → 색 유틸. Tailwind 는 소스를 정적으로 스캔하므로 동적 조합(text-(-- 뒤에
 * 변수 보간)은 생성되지 않는다 — 그 표기를 이 주석에 그대로 쓰면 스캐너가 후보로 집어
 * 빌드가 깨진다. 리터럴로 매핑한다.
 */
const PRIO_CHIP: Record<'p1' | 'p2' | 'p3', string> = {
  p1: 'border-(--p1) text-(--p1)',
  p2: 'border-(--p2) text-(--p2)',
  p3: 'border-(--p3) text-(--p3)',
};

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
      className={`todo-row flex min-h-8 items-center gap-2 rounded-md px-1.5 py-[5px] hover:bg-(--surface) max-[900px]:flex-wrap max-[900px]:gap-y-0.5 ${done ? 'is-done' : ''} ${todo.archivedAt ? 'is-archived opacity-(--dim-archived)' : ''}`}
      style={{ paddingLeft: `${depth * 22}px` }}
    >
      {/* 모바일 44px 히트 영역 — 음수 마진은 늘어난 히트가 행 높이·좌측 정렬을 밀지
          않게 상쇄한다(시각 밀도 유지, rocky-todo#1 방침). */}
      <label className="todo-check-hit max-[900px]:-my-2 max-[900px]:-ml-2 max-[900px]:inline-flex max-[900px]:min-h-11 max-[900px]:min-w-11 max-[900px]:items-center max-[900px]:justify-center">
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
        // min-w-[3.2em] 은 `#999` 까지 담는 자릿수 정렬(tabular) 최소 폭.
        className="todo-ref min-w-[3.2em] shrink-0 cursor-pointer text-right text-[0.85em] text-(--muted) tabular-nums hover:text-(--text) hover:underline max-[900px]:min-h-11 max-[900px]:min-w-11"
        onClick={() => void handleCopyRef()}
        title={copied ? '복사됨' : `${todo.ref} 복사`}
        aria-label={copied ? '복사됨' : `${todo.ref} 복사`}
      >
        {copied ? '✓' : `#${todo.number}`}
      </button>
      <button
        type="button"
        // 모바일: 제목이 자기 줄에 혼자 놓이면 stretch 만으로는 44px 이 안 돼 min-h 가
        // 바닥을 받친다. 둘 다 필요하다 (rocky-todo#1 실측 — 어느 flex 줄에 놓이느냐에
        // 따라 모자라는 쪽이 다르다).
        className={`todo-title min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-left hover:text-(--warm) max-[900px]:min-h-11 max-[900px]:self-stretch max-[900px]:whitespace-normal max-[900px]:[overflow-wrap:anywhere] ${done ? 'text-(--faint) line-through' : 'text-(--text)'}`}
        onClick={() => void openTodoDetail(todo.id)}
      >
        {todo.title}
      </button>
      {todo.priority !== 'p4' && (
        <span className={`${CHIP} prio-${todo.priority} ${PRIO_CHIP[todo.priority]}`}>
          {todo.priority}
        </span>
      )}
      {todo.labels.map((label) => (
        <span key={label} className={`${CHIP} ${CHIP_NEUTRAL} chip-label`}>
          {label}
        </span>
      ))}
      {todo.due && (
        <span
          className={`${CHIP} chip-due ${!done && isOverdue(todo.due) ? 'is-overdue border-(--p1) text-(--p1)' : CHIP_NEUTRAL}`}
        >
          {formatDue(todo.due)}
        </span>
      )}
      {todo.links.map((link) => (
        <a
          key={link.url}
          className={`${CHIP} chip-link border-(--line) text-(--cool) no-underline hover:border-(--cool)`}
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
          className={`comment-badge cursor-pointer px-0.5 text-xs ${unread ? 'is-unread font-semibold text-inherit' : 'text-(--muted)'}`}
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
          className={`${CHIP} chip-handoff border-(--line) bg-(--handoff-dim) text-(--handoff)`}
          title={`${pendingHandoff.sessionName ?? pendingHandoff.sessionId} 에게 보냄`}
        >
          → {pendingHandoff.sessionName ?? '세션'}
        </span>
      ) : null}
      {doing && todo.doingBy && (
        <span
          className={`doing-badge tone-${actorTone(todo.doingBy)} inline-flex shrink-0 items-center gap-1.5 rounded-full border px-[9px] py-0.5 font-(family-name:--mono) text-[10px] bg-[color-mix(in_srgb,currentColor_8%,transparent)] ${
            actorTone(todo.doingBy) === 'warm'
              ? 'border-(--warm-dim) text-(--warm)'
              : 'border-(--cool-dim) text-(--cool)'
          } ${stale ? 'is-stale opacity-(--dim-stale)' : ''}`}
          title={stale ? '30분 이상 갱신 없음' : '처리중'}
        >
          <span
            className={`doing-pulse size-1.5 rounded-full bg-current ${stale ? '' : '[animation:pulse_1.6s_ease-in-out_infinite] motion-reduce:animate-none'}`}
          />
          {todo.doingBy} · {todo.doingSince ? formatElapsed(todo.doingSince) : ''}
          {stale ? ' ⚠' : ''}
        </span>
      )}
    </div>
  );
}
