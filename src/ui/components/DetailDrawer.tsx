import { useEffect, useRef, useState } from 'react';
import type { Comment, HistoryEntry } from '../../store';
import {
  actorTone,
  copyRefWithFeedback,
  formatElapsed,
  formatStamp,
  isEditableTarget,
  linkLabel,
  mdTokens,
  mergeTimeline,
} from '../lib';
import { useUiStore } from '../store';

/** 우측 상세 드로어 — todo/note 상세 + 상태 버튼 + 히스토리 타임라인. */
export function DetailDrawer() {
  const detail = useUiStore((s) => s.detail);
  const closeDetail = useUiStore((s) => s.closeDetail);

  // Escape 로 닫기 — backdrop 클릭과 함께 키보드 접근성 확보
  useEffect(() => {
    if (!detail) {
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      // 입력 중인 Esc 는 그 입력의 취소지 드로어 닫기가 아니다 — 제목 편집뿐 아니라
      // 설명 textarea 에서도 편집분이 날아가지 않게 전역에서 걸러 낸다.
      if (e.key === 'Escape' && !isEditableTarget(e.target)) {
        closeDetail();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [detail, closeDetail]);

  if (!detail) {
    return null;
  }

  return (
    <div className="drawer-backdrop">
      <button type="button" className="backdrop-hit" aria-label="상세 닫기" onClick={closeDetail} />
      <aside className="drawer" role="dialog" aria-modal="true">
        <button type="button" className="drawer-close" onClick={closeDetail}>
          ✕
        </button>
        {detail.kind === 'todo' ? <TodoDetail /> : <NoteDetail />}
        {detail.kind === 'todo' && detail.todo && <CommentComposer todoId={detail.todo.id} />}
        <Timeline history={detail.history} comments={detail.comments} />
      </aside>
    </div>
  );
}

function TodoDetail() {
  const detail = useUiStore((s) => s.detail);
  const setTodoStatus = useUiStore((s) => s.setTodoStatus);
  const patchTodo = useUiStore((s) => s.patchTodo);
  const sections = useUiStore((s) => s.sections);
  const handoffs = useUiStore((s) => s.handoffs);
  const sessions = useUiStore((s) => s.sessions);
  const fetchSessions = useUiStore((s) => s.fetchSessions);
  const sendHandoff = useUiStore((s) => s.sendHandoff);
  const cancelHandoff = useUiStore((s) => s.cancelHandoff);
  const todo = detail?.todo;
  const [desc, setDesc] = useState(todo?.description ?? '');
  const [editingDesc, setEditingDesc] = useState(false);
  const [copied, setCopied] = useState(false);
  const [title, setTitle] = useState(todo?.title ?? '');
  const [editingTitle, setEditingTitle] = useState(false);
  /** Esc 로 빠져나온 blur 인지 — 커밋 경로가 onBlur 하나이므로 취소 의사를 여기로 넘긴다. */
  const cancelledRef = useRef(false);
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [handoffNote, setHandoffNote] = useState('');
  const [handoffSession, setHandoffSession] = useState('');
  const [handoffBusy, setHandoffBusy] = useState(false);
  const [handoffError, setHandoffError] = useState<string | null>(null);

  useEffect(() => {
    if (!editingDesc) {
      setDesc(todo?.description ?? '');
    }
  }, [todo?.description, editingDesc]);

  useEffect(() => {
    if (!editingTitle) {
      setTitle(todo?.title ?? '');
    }
  }, [todo?.title, editingTitle]);

  if (!todo) {
    return null;
  }

  const handleCopyRef = () => copyRefWithFeedback(todo.ref, setCopied);
  const boardSections = sections.filter((s) => s.boardId === todo.boardId);

  const pending = handoffs.find((h) => h.todoId === todo.id && h.status === 'pending');

  const openHandoff = async () => {
    setHandoffOpen(true);
    setHandoffError(null);
    try {
      await fetchSessions();
    } catch (error) {
      setHandoffError(error instanceof Error ? error.message : String(error));
    }
  };

  const submitHandoff = async () => {
    setHandoffBusy(true);
    setHandoffError(null);
    try {
      await sendHandoff(todo.id, {
        sessionId: handoffSession || undefined,
        note: handoffNote || undefined,
      });
      // 성공했을 때만 닫는다 — 실패하면 고쳐서 다시 낼 수 있어야 한다.
      setHandoffOpen(false);
      setHandoffNote('');
      setHandoffSession('');
    } catch (error) {
      setHandoffError(error instanceof Error ? error.message : String(error));
    } finally {
      setHandoffBusy(false);
    }
  };

  /**
   * 제목 커밋은 **onBlur 한 곳**에서만 일어난다. Enter 도 Esc 도 blur 로 빠지고, 취소인지
   * 여부만 ref 로 남긴다 — 커밋 경로가 둘이면 Enter 후 blur 로 같은 PATCH 가 두 번 나가고,
   * Esc 로 되돌린 값도 blur 클로저가 옛 state 를 읽어 저장돼 버린다.
   *
   * 값은 state 대신 실제 input 값을 받는다. Esc 직후의 blur 처럼 state 갱신이 아직
   * 반영되지 않은 시점에도 화면에 있는 값과 어긋나지 않게 하기 위해서다.
   * 제목은 필수 필드라 빈 값이면 저장하지 않는다.
   */
  const commitTitle = (raw: string) => {
    const next = raw.trim();
    setEditingTitle(false);
    if (next === '' || next === todo.title) {
      setTitle(todo.title);
      return;
    }
    void patchTodo(todo.id, { title: next });
  };

  const cancelTitle = () => {
    setTitle(todo.title);
    setEditingTitle(false);
  };

  const statusButton = (label: string, action: Parameters<typeof setTodoStatus>[1]) => (
    <button
      type="button"
      className="drawer-btn"
      onClick={() => void setTodoStatus(todo.id, action)}
    >
      {label}
    </button>
  );

  return (
    <div className="drawer-body">
      <button
        type="button"
        className="drawer-ref"
        onClick={() => void handleCopyRef()}
        title={copied ? '복사됨' : `${todo.ref} 복사`}
        aria-label={copied ? '복사됨' : `${todo.ref} 복사`}
      >
        {copied ? '✓' : todo.ref}
      </button>
      {editingTitle ? (
        <input
          className="drawer-title-input"
          value={title}
          aria-label="제목 수정 (Enter 저장 · Esc 취소)"
          // biome-ignore lint/a11y/noAutofocus: 클릭으로 진입한 편집이라 즉시 입력이 기대 동작
          autoFocus
          onChange={(e) => setTitle(e.target.value)}
          onBlur={(e) => {
            // Esc 로 빠져나온 blur 면 저장하지 않는다 — 플래그는 여기서 소비한다.
            if (cancelledRef.current) {
              cancelledRef.current = false;
              cancelTitle();
              return;
            }
            commitTitle(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              // Enter 도 Esc 도 blur 로 빠진다 — 커밋 경로를 onBlur 하나로 유지해야
              // 같은 변경이 두 번 PATCH 되지 않는다.
              e.currentTarget.blur();
            } else if (e.key === 'Escape') {
              // 드로어의 window keydown 리스너까지 올라가면 편집 취소가 아니라 드로어가
              // 통째로 닫힌다 — 안내한 "Esc 취소"와 다른 동작이 되므로 여기서 끊는다.
              e.stopPropagation();
              cancelledRef.current = true;
              e.currentTarget.blur();
            }
          }}
        />
      ) : (
        // heading 시맨틱은 유지한다 — 노트 상세도 h2 라 같은 영역에서 구조가 갈리지 않게.
        // 클릭 affordance 는 안쪽 버튼에만 건다.
        <h2 className="drawer-title">
          <button
            type="button"
            className="drawer-title-edit"
            onClick={() => setEditingTitle(true)}
            title="클릭해서 제목 수정 (Enter 저장 · Esc 취소)"
            aria-label={`제목 수정: ${todo.title}`}
          >
            {todo.title}
          </button>
        </h2>
      )}
      <div className="drawer-id">{todo.id}</div>
      <div className="drawer-chips">
        <span className={`chip prio-${todo.priority}`}>{todo.priority}</span>
        {todo.labels.map((label) => (
          <span key={label} className="chip chip-label">
            {label}
          </span>
        ))}
        {todo.due && <span className="chip chip-due">{todo.due}</span>}
        {todo.archivedAt && <span className="chip">보관됨</span>}
      </div>
      {/*
        섹션 이동 — 이 보드의 섹션만 후보다. 빈 값은 섹션 해제(store 가 공백을 해제로 읽는다).
        `전체` 뷰에서는 스토어가 sections 를 비워 두므로 피커를 아예 감춘다. 그대로 두면
        현재 섹션에 해당하는 option 이 없어 값이 (없음) 으로 잘못 보이고, 건드리는 순간
        멀쩡한 섹션이 해제된다.
      */}
      {boardSections.length > 0 && (
        <label className="drawer-section-pick">
          <span className="drawer-section-label">섹션</span>
          <select
            className="drawer-select"
            value={todo.sectionId ?? ''}
            onChange={(e) => {
              const picked = boardSections.find((s) => s.id === e.target.value);
              void patchTodo(todo.id, { section: picked ? picked.title : null });
            }}
          >
            <option value="">(없음)</option>
            {boardSections.map((section) => (
              <option key={section.id} value={section.id}>
                {section.title}
              </option>
            ))}
          </select>
        </label>
      )}
      {todo.links.length > 0 && (
        <div className="drawer-links">
          {todo.links.map((link) => (
            <a
              key={link.url}
              href={link.url}
              target="_blank"
              rel="noreferrer"
              className="chip chip-link"
            >
              {link.title ?? linkLabel(link.url)} ↗
            </a>
          ))}
        </div>
      )}
      <div className="drawer-section-label">설명</div>
      {editingDesc ? (
        <div>
          <textarea
            className="drawer-desc-edit"
            value={desc}
            rows={8}
            onChange={(e) => setDesc(e.target.value)}
          />
          <div className="drawer-actions">
            <button
              type="button"
              className="drawer-btn"
              onClick={() => {
                void patchTodo(todo.id, { description: desc });
                setEditingDesc(false);
              }}
            >
              저장
            </button>
            <button type="button" className="drawer-btn" onClick={() => setEditingDesc(false)}>
              취소
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="drawer-desc" onClick={() => setEditingDesc(true)}>
          {todo.description === '' ? (
            <span className="drawer-desc-empty">설명 없음 — 눌러서 작성</span>
          ) : (
            <Markdown text={todo.description} />
          )}
        </button>
      )}
      <div className="drawer-actions">
        {todo.status !== 'doing' && statusButton('▶ 시작', 'start')}
        {todo.status === 'doing' && statusButton('⏸ 중단', 'stop')}
        {todo.status !== 'done' && statusButton('✓ 완료', 'done')}
        {todo.status === 'done' && statusButton('↺ 다시 열기', 'reopen')}
        {todo.archivedAt
          ? statusButton('보관 해제', 'unarchive')
          : statusButton('▣ 보관', 'archive')}
      </div>
      {pending ? (
        <div className="handoff-pending">
          <span>대기 중 · {pending.sessionName ?? pending.sessionId} 에게</span>
          {pending.stale ? <span className="handoff-stale">세션 없음</span> : null}
          <button type="button" onClick={() => void cancelHandoff(pending.id)}>
            취소
          </button>
        </div>
      ) : (
        <button type="button" className="drawer-btn" onClick={() => void openHandoff()}>
          에이전트에게 보내기
        </button>
      )}
      {handoffOpen && !pending ? (
        <div className="handoff-panel">
          {sessions.available ? (
            <>
              <select value={handoffSession} onChange={(e) => setHandoffSession(e.target.value)}>
                <option value="">자동 (이 보드의 세션)</option>
                {sessions.list.map((session) => (
                  <option key={session.sessionId} value={session.sessionId}>
                    {session.name} · {session.status} · {session.cwd}
                  </option>
                ))}
              </select>
              <input
                value={handoffNote}
                placeholder="메모 (선택)"
                onChange={(e) => setHandoffNote(e.target.value)}
              />
              <button type="button" onClick={() => void submitHandoff()} disabled={handoffBusy}>
                보내기
              </button>
            </>
          ) : (
            <p>세션 목록을 가져올 수 없다: {sessions.reason}</p>
          )}
          {handoffError ? (
            <p className="handoff-error" role="alert">
              {handoffError}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function NoteDetail() {
  const detail = useUiStore((s) => s.detail);
  const note = detail?.note;
  const [copied, setCopied] = useState(false);

  if (!note) {
    return null;
  }

  // 글로벌 메모는 note.ref 가 `#3` 처럼 보드 접두사 없이 오는데, copyRefWithFeedback 은
  // 그 문자열을 그대로 복사하므로 별도 분기가 없다.
  const handleCopyRef = () => copyRefWithFeedback(note.ref, setCopied);

  return (
    <div className="drawer-body">
      <button
        type="button"
        className="drawer-ref"
        onClick={() => void handleCopyRef()}
        title={copied ? '복사됨' : `${note.ref} 복사`}
        aria-label={copied ? '복사됨' : `${note.ref} 복사`}
      >
        {copied ? '✓' : note.ref}
      </button>
      <h2 className="drawer-title">{note.title}</h2>
      <div className="drawer-id">{note.id}</div>
      <div className="drawer-desc drawer-desc-static">
        <Markdown text={note.content} />
      </div>
    </div>
  );
}

function Markdown({ text }: { text: string }) {
  return (
    <>
      {text.split('\n').map((line, lineIndex) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 정적 텍스트 줄 렌더
        <p key={lineIndex} className="md-line">
          {mdTokens(line).map((token, i) => {
            const key = `${i}-${token.value}`;
            if (token.type === 'bold') {
              return <strong key={key}>{token.value}</strong>;
            }
            if (token.type === 'code') {
              return <code key={key}>{token.value}</code>;
            }
            if (token.type === 'link') {
              return (
                <a key={key} href={token.value} target="_blank" rel="noreferrer">
                  {token.value}
                </a>
              );
            }
            return <span key={key}>{token.value}</span>;
          })}
        </p>
      ))}
    </>
  );
}

/** 댓글 작성 — ⌘/Ctrl+Enter 로 전송. 빈 본문은 보내지 않는다. */
function CommentComposer({ todoId }: { todoId: string }) {
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
    <div className="comment-compose">
      <div className="drawer-section-label">댓글</div>
      <textarea
        className="comment-input"
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
        <div className="comment-error" role="alert">
          {error}
        </div>
      )}
      <div className="drawer-actions">
        <button
          type="button"
          className="drawer-btn"
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
    <div className={`comment-card${archived ? ' is-archived' : ''}`}>
      <div className="comment-head">
        <span className={`history-dot tone-${actorTone(comment.actor)}`} />
        <span className={`comment-actor tone-${actorTone(comment.actor)}`}>{comment.actor}</span>
        <span className="comment-at">{formatStamp(comment.createdAt)}</span>
        {edited && <span className="comment-edited">(수정됨)</span>}
        {archived && <span className="comment-edited">(보관됨)</span>}
        <span className="comment-tools">
          <button
            type="button"
            className="comment-tool"
            onClick={() => {
              setEditing(!editing);
              setError(null);
            }}
          >
            {editing ? '취소' : '편집'}
          </button>
          <button
            type="button"
            className="comment-tool"
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
            className="comment-input"
            value={draft}
            rows={3}
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="drawer-actions">
            <button type="button" className="drawer-btn" disabled={busy} onClick={save}>
              {busy ? '저장 중…' : '저장'}
            </button>
          </div>
        </div>
      ) : (
        <div className="comment-body">
          <Markdown text={comment.body} />
        </div>
      )}
      {error && (
        <div className="comment-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

/** 히스토리와 댓글을 한 줄기로 보여준다 — 지라식 탭 분리를 하지 않는다. */
function Timeline({ history, comments }: { history: HistoryEntry[]; comments: Comment[] }) {
  const items = mergeTimeline(history, comments);
  return (
    <div className="drawer-history">
      <div className="drawer-section-label">타임라인</div>
      {items.map((item) =>
        item.kind === 'comment' ? (
          <CommentCard key={`c-${item.comment.id}`} comment={item.comment} />
        ) : (
          <div key={`h-${item.entry.id}`} className="history-row">
            <span className={`history-dot tone-${actorTone(item.entry.actor)}`} />
            <span className={`history-actor tone-${actorTone(item.entry.actor)}`}>
              {item.entry.actor}
            </span>
            <span className="history-action">{actionLabel(item.entry.action)}</span>
            {item.entry.changes?.title && (
              <span className="history-change">→ {String(item.entry.changes.title[1])}</span>
            )}
            <span className="history-at">{formatElapsed(item.entry.at)} 전</span>
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
