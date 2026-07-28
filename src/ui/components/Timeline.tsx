import { useEffect, useState } from 'react';
import type { Comment, HistoryEntry } from '../../store';
import { actorTone, formatElapsed, formatStamp, mergeTimeline } from '../lib';
import { useUiStore } from '../store';
import { Markdown } from './Markdown';

export function CommentComposer({ todoId }: { todoId: string }) {
  const addComment = useUiStore((s) => s.addComment);
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  /**
   * 등록에 성공했을 때만 입력을 비운다 — 데몬이 내려갔거나 요청이 실패하면 방금 쓴
   * 본문이 화면에서 그대로 사라진다(되돌릴 방법 없음). 실패하면 초안을 남기고 이유를
   * 보여준다 — 보드 추가(`Sidebar`)와 같은 방침.
   */
  const submit = async () => {
    const next = body.trim();
    if (next === '' || sending) {
      return;
    }
    setSending(true);
    try {
      await addComment(todoId, next);
      setBody('');
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="comment-compose mt-3.5">
      <div className="drawer-section-label mt-4 mb-1.5 font-(family-name:--mono) text-[11px] tracking-[0.22em] text-(--faint)">
        댓글
      </div>
      <textarea
        className="comment-input w-full resize-y rounded-md border border-(--line-strong) bg-(--bg) p-2"
        value={body}
        rows={3}
        placeholder="진행 상황이나 질문을 남긴다 (⌘/Ctrl+Enter 전송)"
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit();
          }
        }}
      />
      {error && (
        <div className="comment-error px-0.5 pt-1 text-xs leading-[1.4] text-(--p1)" role="alert">
          {error}
        </div>
      )}
      <div className="drawer-actions mt-3.5 flex flex-wrap gap-2">
        <button
          type="button"
          className="drawer-btn rounded-[7px] border border-(--line-strong) bg-(--surface-2) px-3 py-1.5 text-xs hover:border-(--warm-dim) hover:text-(--warm) max-[900px]:inline-flex max-[900px]:min-h-11 max-[900px]:items-center max-[900px]:justify-center"
          onClick={() => void submit()}
          disabled={body.trim() === '' || sending}
        >
          {sending ? '등록 중…' : '등록'}
        </button>
      </div>
    </div>
  );
}

/** 댓글 카드 — 작성 시각(절대) + actor + 본문 + 편집/보관. */
function CommentCard({ comment }: { comment: Comment }) {
  const editComment = useUiStore((s) => s.editComment);
  const archiveComment = useUiStore((s) => s.archiveComment);
  const unarchiveComment = useUiStore((s) => s.unarchiveComment);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!editing) {
      setDraft(comment.body);
    }
  }, [comment.body, editing]);

  const edited = comment.updatedAt !== comment.createdAt;
  const archived = comment.archivedAt !== undefined;

  /**
   * 요청이 성공했을 때만 화면 상태를 넘긴다 — `CommentComposer` 와 같은 방침. 실패를
   * `void` 로 버리면 unhandled rejection 이 콘솔에만 남고, 편집 초안은 닫힌 채 사라지며
   * 화면은 성공한 것처럼 보인다(실제 저장 상태와 어긋난다).
   */
  const run = async (op: () => Promise<void>, onDone?: () => void) => {
    if (busy) {
      return;
    }
    setBusy(true);
    try {
      await op();
      setError(null);
      onDone?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    const next = draft.trim();
    // 빈 본문·무변경은 요청 없이 닫는다 — 서버가 빈 본문을 거절하므로 보내봐야 에러다.
    if (next === '' || next === comment.body) {
      setEditing(false);
      setError(null);
      return;
    }
    void run(
      () => editComment(comment.id, next),
      () => setEditing(false),
    );
  };

  return (
    <div
      className={`comment-card border-b border-(--line) py-2 ${archived ? 'is-archived opacity-(--dim-archived)' : ''}`}
    >
      <div className="comment-head flex items-center gap-1.5 text-xs">
        <span
          className={`history-dot size-[7px] shrink-0 self-center rounded-full bg-current tone-${actorTone(comment.actor)}`}
        />
        <span className={`comment-actor font-semibold tone-${actorTone(comment.actor)}`}>
          {comment.actor}
        </span>
        <span className="comment-at text-(--muted)">{formatStamp(comment.createdAt)}</span>
        {edited && <span className="comment-edited text-(--muted)">(수정됨)</span>}
        {archived && <span className="comment-edited text-(--muted)">(보관됨)</span>}
        <span className="comment-tools ml-auto flex gap-1.5">
          <button
            type="button"
            className="comment-tool cursor-pointer text-xs text-(--muted) hover:text-inherit max-[900px]:min-h-11 max-[900px]:px-2"
            onClick={() => {
              setEditing(!editing);
              setError(null);
            }}
          >
            {editing ? '취소' : '편집'}
          </button>
          <button
            type="button"
            className="comment-tool cursor-pointer text-xs text-(--muted) hover:text-inherit max-[900px]:min-h-11 max-[900px]:px-2"
            disabled={busy}
            onClick={() =>
              void run(() => (archived ? unarchiveComment(comment.id) : archiveComment(comment.id)))
            }
          >
            {archived ? '보관 해제' : '보관'}
          </button>
        </span>
      </div>
      {editing ? (
        <div>
          <textarea
            className="comment-input w-full resize-y rounded-md border border-(--line-strong) bg-(--bg) p-2"
            value={draft}
            rows={3}
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="drawer-actions mt-3.5 flex flex-wrap gap-2">
            <button
              type="button"
              className="drawer-btn rounded-[7px] border border-(--line-strong) bg-(--surface-2) px-3 py-1.5 text-xs hover:border-(--warm-dim) hover:text-(--warm) max-[900px]:inline-flex max-[900px]:min-h-11 max-[900px]:items-center max-[900px]:justify-center"
              disabled={busy}
              onClick={save}
            >
              {busy ? '저장 중…' : '저장'}
            </button>
          </div>
        </div>
      ) : (
        <div className="comment-body mt-1 text-[13px] leading-normal">
          <Markdown text={comment.body} />
        </div>
      )}
      {error && (
        <div className="comment-error px-0.5 pt-1 text-xs leading-[1.4] text-(--p1)" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

/** 히스토리와 댓글을 한 줄기로 보여준다 — 지라식 탭 분리를 하지 않는다. */
export function Timeline({ history, comments }: { history: HistoryEntry[]; comments: Comment[] }) {
  const items = mergeTimeline(history, comments);
  return (
    <div className="drawer-history mt-[18px] border-t border-(--line)">
      <div className="drawer-section-label mt-4 mb-1.5 font-(family-name:--mono) text-[11px] tracking-[0.22em] text-(--faint)">
        타임라인
      </div>
      {items.map((item) =>
        item.kind === 'comment' ? (
          <CommentCard key={`c-${item.comment.id}`} comment={item.comment} />
        ) : (
          <div
            key={`h-${item.entry.id}`}
            className="history-row flex items-baseline gap-2 py-[5px] text-xs"
          >
            <span
              className={`history-dot size-[7px] shrink-0 self-center rounded-full bg-current tone-${actorTone(item.entry.actor)}`}
            />
            <span
              className={`history-actor font-(family-name:--mono) text-[11px] tone-${actorTone(item.entry.actor)}`}
            >
              {item.entry.actor}
            </span>
            <span className="history-action text-(--muted)">{actionLabel(item.entry.action)}</span>
            {item.entry.changes?.title && (
              <span className="history-change min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-(--faint)">
                → {String(item.entry.changes.title[1])}
              </span>
            )}
            <span className="history-at ml-auto shrink-0 font-(family-name:--mono) text-[11px] text-(--faint)">
              {formatElapsed(item.entry.at)} 전
            </span>
          </div>
        ),
      )}
    </div>
  );
}

const ACTION_LABELS: Record<string, string> = {
  create: '생성',
  update: '수정',
  start: '시작',
  stop: '중단',
  done: '완료',
  reopen: '다시 열기',
  archive: '보관',
  unarchive: '보관 해제',
  'comment-archive': '댓글 보관',
  'comment-unarchive': '댓글 보관 해제',
};

function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}
