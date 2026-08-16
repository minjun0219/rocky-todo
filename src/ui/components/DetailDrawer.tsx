import { useEffect, useRef, useState } from 'react';
import type { TodoView } from '../../server';
import { findIssueLink } from '../../github';
import type { Comment, HistoryEntry } from '../../store';
import {
  actorTone,
  boardCommand,
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

  // 드로어가 열린 동안 배경 스크롤을 잠근다. 정리 함수에서 **반드시** 지운다 —
  // 남기면 드로어를 닫은 뒤 페이지 전체가 스크롤 불가가 된다.
  useEffect(() => {
    if (!detail) {
      return;
    }
    document.body.classList.add('is-drawer-open');
    return () => document.body.classList.remove('is-drawer-open');
  }, [detail]);

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

  // 드로어가 todo A → B 로 전환돼도(언마운트 없이 재사용) 핸드오프 패널의 로컬 상태가
  // 새 todo 로 새어 들어가면 안 된다 — 열려 있던 패널·입력 중이던 메모가 그대로 남으면
  // "보내기"를 눌렀을 때 A 에서 쓴 메모가 B 의 핸드오프로 조용히 전송된다.
  // biome-ignore lint/correctness/useExhaustiveDependencies: todo?.id 는 본문에서 값으로 읽지 않는 리셋 트리거다 — todo 가 바뀌었다는 사실 자체가 신호다.
  useEffect(() => {
    setHandoffOpen(false);
    setHandoffNote('');
    setHandoffSession('');
    setHandoffBusy(false);
    setHandoffError(null);
  }, [todo?.id]);

  if (!todo) {
    return null;
  }

  const handleCopyRef = () => copyRefWithFeedback(boardCommand(todo.ref), setCopied);
  const boardSections = sections.filter((s) => s.boardId === todo.boardId);

  const pending = handoffs.find((h) => h.todoId === todo.id && h.status === 'pending');
  // 집어갔는데 아무것도 안 한 건. 대기 중인 새 요청이 이미 있으면 굳이 과거를 들추지
  // 않는다 — 사용자는 이미 다시 보낸 상태다.
  const unstarted = pending ? undefined : handoffs.find((h) => h.todoId === todo.id && h.unstarted);

  // `fetchSessions` 는 실패를 던지지 않고 `sessions.available:false + reason` 으로
  // 흡수한다 — 조회 실패는 그 상태 하나로만 표현한다. 여기서 또 잡아 `handoffError` 에
  // 넣으면 같은 실패를 말하는 자리가 둘이 된다.
  const openHandoff = async () => {
    setHandoffOpen(true);
    setHandoffError(null);
    await fetchSessions();
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
          className="drawer-title-input mt-1 mb-2.5 w-full rounded-md border border-warm-dim bg-surface px-1.5 py-[3px] text-lg font-bold leading-[1.35] text-text"
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
        <h2 className="m-0 mt-1 mb-2.5 text-lg font-bold leading-[1.35] text-text">
          <button
            type="button"
            className="block w-full cursor-text border-0 bg-transparent p-0 text-left text-inherit hover:rounded-[3px] hover:bg-surface hover:shadow-[0_0_0_4px_var(--surface)]"
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
        <label className="mt-2.5 mb-1 flex items-center gap-2">
          <span className="drawer-section-label">섹션</span>
          <select
            className="flex-auto rounded-md border border-line bg-surface px-2 py-[5px] text-[13px] text-text"
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
        <div className="mt-2 flex items-center gap-2 text-handoff">
          <span>대기 중 · {pending.sessionName ?? pending.sessionId} 에게</span>
          {pending.stale ? <span className="text-p1">세션 없음</span> : null}
          <button type="button" onClick={() => void cancelHandoff(pending.id)}>
            취소
          </button>
        </div>
      ) : (
        <button type="button" className="drawer-btn" onClick={() => void openHandoff()}>
          에이전트에게 보내기
        </button>
      )}
      {unstarted ? (
        <div className="mt-2 flex items-center gap-2 text-p1" role="status">
          <span>
            ⚠ {unstarted.sessionName ?? unstarted.sessionId} 이(가) 받았지만 착수하지 않았다
          </span>
          {/* 같은 세션으로 곧장 되쏘지 않는다 — 그 세션은 사라졌을 수 있고, 그렇다면
              한 번 더 조용히 묻힐 뿐이다. 패널을 열어 지금 살아 있는 세션을 고르게 한다. */}
          <button type="button" onClick={() => void openHandoff()}>
            다시 보내기
          </button>
        </div>
      ) : null}
      {handoffOpen && !pending ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
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
            <p className="w-full text-p1" role="alert">
              {handoffError}
            </p>
          ) : null}
        </div>
      ) : null}
      <IssueAction todo={todo} />
      <SpawnAction todo={todo} />
    </div>
  );
}

/**
 * GitHub 이슈 — 없으면 만들고, 있으면 링크로 보낸다. 보드 repo 가 없으면 입력받고, 실패하면
 * 입력이 열린 채 남아 고쳐 재시도하거나 이미 설정된 repo 를 바꿀 수 있다.
 *
 * repo 는 서버가 `gh` 성공 후에만 보드에 저장한다(`createIssueForTodo` — finding C).
 * 그래서 여기서는 미리 `setBoardRepo` 를 부르지 않는다 — 실패한 슬러그를 먼저 저장해두면
 * `asking` 이 이미 false 로 내려가 입력이 다시 열리지 않는 막다른 길이 됐던 게 원래
 * 버그였다. 실패하면 무조건 `asking` 을 다시 연다: 방금 실패한 값을 그대로 보여주거나
 * (사용자가 직접 입력한 경우), 처음 실패라 아직 아무 값도 안 보였다면 board.repo 를
 * 프리필한다(있다면) — 어느 쪽이든 사용자가 고쳐서 재시도할 길을 남긴다.
 */
function IssueAction({ todo }: { todo: TodoView }) {
  const boards = useUiStore((s) => s.boards);
  const createIssue = useUiStore((s) => s.createIssue);
  const issueCreateAllowed = useUiStore((s) => s.issueCreateAllowed);
  const [repo, setRepo] = useState('');
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const board = boards.find((b) => b.id === todo.boardId);
  const issueUrl = findIssueLink(todo.links);

  if (issueUrl) {
    return (
      <div className="drawer-actions">
        <a className="drawer-btn" href={issueUrl} target="_blank" rel="noreferrer">
          이슈 열기 ↗
        </a>
      </div>
    );
  }

  // 이미 있는 이슈로 가는 링크는 어디서든 유효하지만(위), 만드는 건 로컬에서만 된다 —
  // 서버가 403 을 줄 버튼을 그리는 대신 왜 못 하는지 한 줄로 밝힌다. 조용히 사라지면
  // tailscale 로 접속한 사용자는 기능이 없어진 줄로 읽는다.
  if (!issueCreateAllowed) {
    return (
      <div className="mt-2.5">
        <p className="m-0 text-xs leading-[1.4] text-muted">
          GitHub 이슈 만들기는 로컬(루프백)에서만 — 이 화면은 노출된 데몬을 거쳐 열렸다.
        </p>
      </div>
    );
  }

  const submit = async (repoOverride: string | undefined): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      await createIssue(todo.id, repoOverride);
      setAsking(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      // 실패는 절대 조용히 막다른 길이 되면 안 된다 — 입력을 (다시) 열어 고칠 값을 보여준다.
      setAsking(true);
      setRepo(repoOverride ?? board?.repo ?? '');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2.5">
      {asking && (
        <input
          className="issue-repo-input w-full rounded-md border border-line bg-bg px-2 py-1.5 text-inherit"
          value={repo}
          placeholder="OWNER/NAME"
          aria-label="GitHub 레포 (OWNER/NAME)"
          onChange={(e) => setRepo(e.target.value)}
        />
      )}
      <div className="drawer-actions">
        <button
          type="button"
          className="drawer-btn"
          disabled={busy || (asking && repo.trim() === '')}
          onClick={() => {
            if (!board?.repo && !asking) {
              setAsking(true);
              setRepo(board?.repo ?? '');
              return;
            }
            void submit(asking ? repo.trim() : undefined);
          }}
        >
          {busy ? '만드는 중…' : 'GitHub 이슈 만들기'}
        </button>
      </div>
      {/* 실패 사유는 즉시 읽혀야 한다 — 보이기만 하면 스크린리더가 놓친다. */}
      {error && (
        <div className="mt-1.5 whitespace-pre-wrap text-xs leading-[1.4] text-p1" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

/**
 * 그 todo 전용 워크트리에 백그라운드 세션을 띄운다.
 *
 * 보드에 메인 레포 경로가 없으면 그 자리에서 입력받는다. `IssueAction` 과 같은 규칙으로
 * 실패해도 입력을 (다시) 열어 막다른 길을 만들지 않는다 — 브라우저만 쓰는 사용자에게는
 * 이 화면이 유일한 설정 경로다.
 *
 * 경로는 `IssueAction` 의 repo 와 같은 모양으로 **spawn 호출 한 번에 실어** 보낸다.
 * 여기서 `setBoardPath` 를 먼저 부르지 않는다 — 먼저 저장하면 오타난 경로가 spawn
 * 성공 여부와 무관하게 보드에 남아, 다른 todo·다른 탭에서 띄우려는 사람도 같은 실패를
 * 물려받는다(이 컴포넌트가 고치는 finding). 저장은 서버가 spawn 성공 뒤에만 한다.
 */
function SpawnAction({ todo }: { todo: TodoView }) {
  const boards = useUiStore((s) => s.boards);
  const spawnAllowed = useUiStore((s) => s.spawnAllowed);
  const spawnSession = useUiStore((s) => s.spawnSession);
  const [path, setPath] = useState('');
  const [note, setNote] = useState('');
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    reused: boolean;
    worktreePath: string;
    sessionShortId?: string;
  } | null>(null);

  const board = boards.find((b) => b.id === todo.boardId);

  if (!spawnAllowed) {
    return (
      <div className="mt-2.5 flex flex-col gap-1.5">
        <p className="m-0 text-xs leading-[1.4] text-muted">
          세션 띄우기는 로컬(루프백)에서만 — 이 화면은 노출된 데몬을 거쳐 열렸다.
        </p>
      </div>
    );
  }

  const submit = async (): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      setResult(
        await spawnSession(todo.id, {
          note: note.trim() || undefined,
          path: asking ? path.trim() : undefined,
        }),
      );
      setAsking(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      // 실패는 절대 조용히 막다른 길이 되면 안 된다 — 입력을 (다시) 열어 고칠 값을 보여준다.
      setAsking(true);
      setPath(path || board?.path || '');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2.5 flex flex-col gap-1.5">
      {asking && (
        <input
          className="w-full rounded-md border border-line bg-bg px-2 py-1.5 text-inherit"
          value={path}
          placeholder="/Users/…/레포 절대경로"
          aria-label="메인 레포 절대경로"
          onChange={(e) => setPath(e.target.value)}
        />
      )}
      <input
        className="w-full rounded-md border border-line bg-bg px-2 py-1.5 text-inherit"
        value={note}
        placeholder="메모 (선택)"
        aria-label="세션에 함께 보낼 메모"
        onChange={(e) => setNote(e.target.value)}
      />
      <div className="drawer-actions">
        <button
          type="button"
          className="drawer-btn"
          disabled={busy || (asking && path.trim() === '')}
          onClick={() => {
            if (!board?.path && !asking) {
              setAsking(true);
              setPath(board?.path ?? '');
              return;
            }
            void submit();
          }}
        >
          {busy ? '띄우는 중…' : '새 세션 띄우기'}
        </button>
      </div>
      {result && (
        <div className="mt-1.5 flex flex-col gap-1 text-xs leading-[1.4] text-handoff [&_code]:select-all">
          {result.reused ? (
            <span>이미 도는 세션에 넘겼다 · {result.worktreePath}</span>
          ) : (
            <>
              <span>
                세션 {result.sessionShortId} · {result.worktreePath}
              </span>
              <code>claude attach {result.sessionShortId}</code>
            </>
          )}
        </div>
      )}
      {/* 실패 사유는 즉시 읽혀야 한다 — 보이기만 하면 스크린리더가 놓친다. */}
      {error && (
        <div className="mt-1.5 whitespace-pre-wrap text-xs leading-[1.4] text-p1" role="alert">
          {error}
        </div>
      )}
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

  // 글로벌 메모는 note.ref 가 `note-3` 으로 오고 보드 메모는 `rocky-3` 으로 온다 —
  // 어느 쪽이든 boardCommand 가 그대로 감싸므로 별도 분기가 없다.
  const handleCopyRef = () => copyRefWithFeedback(boardCommand(note.ref), setCopied);

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
      <h2 className="m-0 mt-1 mb-2.5 text-lg font-bold leading-[1.35] text-text">{note.title}</h2>
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
    <div className="mt-3.5">
      <div className="drawer-section-label">댓글</div>
      <textarea
        className="w-full resize-y rounded-md border border-line bg-bg p-2 text-inherit"
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
        <div className="px-0.5 pt-1 text-xs leading-[1.4] text-p1" role="alert">
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
    <div className={`border-b border-line py-2 ${archived ? 'is-archived' : ''}`}>
      <div className="flex items-center gap-1.5 text-xs">
        <span
          className={`history-dot size-[7px] shrink-0 self-center rounded-full bg-current tone-${actorTone(comment.actor)}`}
        />
        <span className={`font-semibold tone-${actorTone(comment.actor)}`}>{comment.actor}</span>
        <span className="text-muted">{formatStamp(comment.createdAt)}</span>
        {edited && <span className="text-muted">(수정됨)</span>}
        {archived && <span className="text-muted">(보관됨)</span>}
        <span className="ml-auto flex gap-1.5">
          <button
            type="button"
            className="comment-tool cursor-pointer border-none bg-transparent p-0 text-xs text-muted hover:text-inherit"
            onClick={() => {
              setEditing(!editing);
              setError(null);
            }}
          >
            {editing ? '취소' : '편집'}
          </button>
          <button
            type="button"
            className="comment-tool cursor-pointer border-none bg-transparent p-0 text-xs text-muted hover:text-inherit"
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
            className="w-full resize-y rounded-md border border-line bg-bg p-2 text-inherit"
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
        <div className="mt-1 text-[13px] leading-normal">
          <Markdown text={comment.body} />
        </div>
      )}
      {error && (
        <div className="px-0.5 pt-1 text-xs leading-[1.4] text-p1" role="alert">
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
    <div className="mt-[18px] border-t border-line">
      <div className="drawer-section-label">타임라인</div>
      {items.map((item) =>
        item.kind === 'comment' ? (
          <CommentCard key={`c-${item.comment.id}`} comment={item.comment} />
        ) : (
          <div key={`h-${item.entry.id}`} className="flex items-baseline gap-2 py-[5px] text-xs">
            <span
              className={`history-dot size-[7px] shrink-0 self-center rounded-full bg-current tone-${actorTone(item.entry.actor)}`}
            />
            <span className={`font-mono text-[11px] tone-${actorTone(item.entry.actor)}`}>
              {item.entry.actor}
            </span>
            <span className="text-muted">{actionLabel(item.entry.action)}</span>
            {item.entry.changes?.title && (
              <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-faint">
                → {String(item.entry.changes.title[1])}
              </span>
            )}
            <span className="ml-auto shrink-0 font-mono text-[10px] text-faint">
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
