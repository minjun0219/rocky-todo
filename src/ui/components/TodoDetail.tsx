import { useEffect, useRef, useState } from 'react';
import type { TodoView } from '../../server';
import { findIssueLink } from '../../github';
import { copyRefWithFeedback, linkLabel } from '../lib';
import { useUiStore } from '../store';
import { Markdown } from './Markdown';

/** 우선순위 → 색 유틸. Tailwind 정적 스캔 때문에 리터럴이다 (TodoItem 과 동일 값). */
const PRIO_CHIP: Record<string, string> = {
  p1: 'border-(--p1) text-(--p1)',
  p2: 'border-(--p2) text-(--p2)',
  p3: 'border-(--p3) text-(--p3)',
};

export function TodoDetail() {
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

  const handleCopyRef = () => copyRefWithFeedback(todo.ref, setCopied);
  const boardSections = sections.filter((s) => s.boardId === todo.boardId);

  const pending = handoffs.find((h) => h.todoId === todo.id && h.status === 'pending');

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
      className="drawer-btn rounded-[7px] border border-(--line-strong) bg-(--surface-2) px-3 py-1.5 text-xs hover:border-(--warm-dim) hover:text-(--warm) max-[900px]:inline-flex max-[900px]:min-h-11 max-[900px]:items-center max-[900px]:justify-center"
      onClick={() => void setTodoStatus(todo.id, action)}
    >
      {label}
    </button>
  );

  return (
    <div className="drawer-body">
      <button
        type="button"
        className="drawer-ref cursor-pointer text-[0.9em] text-(--muted) tabular-nums hover:text-(--text) hover:underline max-[900px]:inline-flex max-[900px]:min-h-11 max-[900px]:min-w-11 max-[900px]:items-center"
        onClick={() => void handleCopyRef()}
        title={copied ? '복사됨' : `${todo.ref} 복사`}
        aria-label={copied ? '복사됨' : `${todo.ref} 복사`}
      >
        {copied ? '✓' : todo.ref}
      </button>
      {editingTitle ? (
        <input
          className="drawer-title-input mt-1 mb-2.5 w-full rounded-md border border-(--warm-dim) bg-(--surface) px-1.5 py-[3px] text-lg leading-[1.35] font-bold text-(--text)"
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
        <h2 className="drawer-title mt-1 mb-2.5 text-lg leading-[1.35] font-bold text-(--text)">
          <button
            type="button"
            className="drawer-title-edit block w-full cursor-text text-left hover:rounded-[3px] hover:bg-(--surface) hover:shadow-[0_0_0_4px_var(--surface)]"
            onClick={() => setEditingTitle(true)}
            title="클릭해서 제목 수정 (Enter 저장 · Esc 취소)"
            aria-label={`제목 수정: ${todo.title}`}
          >
            {todo.title}
          </button>
        </h2>
      )}
      <div className="drawer-id mt-0.5 mb-2.5 font-(family-name:--mono) text-[10px] tracking-[0.14em] text-(--faint)">
        {todo.id}
      </div>
      <div className="drawer-chips mb-2.5 flex flex-wrap gap-1.5">
        <span
          className={`chip prio-${todo.priority} shrink-0 whitespace-nowrap rounded-full border px-[7px] py-px font-(family-name:--mono) text-[10px] ${PRIO_CHIP[todo.priority] ?? 'text-(--muted)'}`}
        >
          {todo.priority}
        </span>
        {todo.labels.map((label) => (
          <span
            key={label}
            className="chip chip-label shrink-0 whitespace-nowrap rounded-full border px-[7px] py-px font-(family-name:--mono) text-[10px] border-(--line) text-(--muted)"
          >
            {label}
          </span>
        ))}
        {todo.due && (
          <span className="chip chip-due shrink-0 whitespace-nowrap rounded-full border px-[7px] py-px font-(family-name:--mono) text-[10px] border-(--line) text-(--muted)">
            {todo.due}
          </span>
        )}
        {todo.archivedAt && (
          <span className="chip shrink-0 whitespace-nowrap rounded-full border px-[7px] py-px font-(family-name:--mono) text-[10px] border-(--line) text-(--muted)">
            보관됨
          </span>
        )}
      </div>
      {/*
        섹션 이동 — 이 보드의 섹션만 후보다. 빈 값은 섹션 해제(store 가 공백을 해제로 읽는다).
        `전체` 뷰에서는 스토어가 sections 를 비워 두므로 피커를 아예 감춘다. 그대로 두면
        현재 섹션에 해당하는 option 이 없어 값이 (없음) 으로 잘못 보이고, 건드리는 순간
        멀쩡한 섹션이 해제된다.
      */}
      {boardSections.length > 0 && (
        <label className="drawer-section-pick mt-2.5 mb-1 flex items-center gap-2">
          <span className="drawer-section-label mt-4 mb-1.5 font-(family-name:--mono) text-[10px] tracking-[0.22em] text-(--faint)">
            섹션
          </span>
          <select
            className="drawer-select flex-auto rounded-md border border-(--line-strong) bg-(--surface) px-2 py-[5px] text-[13px] text-(--text)"
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
        <div className="drawer-links mb-2.5 flex flex-wrap gap-1.5">
          {todo.links.map((link) => (
            <a
              key={link.url}
              href={link.url}
              target="_blank"
              rel="noreferrer"
              className="chip chip-link shrink-0 whitespace-nowrap rounded-full border px-[7px] py-px font-(family-name:--mono) text-[10px] border-(--line) text-(--cool) no-underline hover:border-(--cool)"
            >
              {link.title ?? linkLabel(link.url)} ↗
            </a>
          ))}
        </div>
      )}
      <div className="drawer-section-label mt-4 mb-1.5 font-(family-name:--mono) text-[10px] tracking-[0.22em] text-(--faint)">
        설명
      </div>
      {editingDesc ? (
        <div>
          <textarea
            className="drawer-desc-edit w-full resize-y rounded-lg border border-(--warm-dim) bg-(--bg) px-3 py-2.5 text-[13px] max-[900px]:text-base"
            value={desc}
            rows={8}
            onChange={(e) => setDesc(e.target.value)}
          />
          <div className="drawer-actions mt-3.5 flex flex-wrap gap-2">
            <button
              type="button"
              className="drawer-btn rounded-[7px] border border-(--line-strong) bg-(--surface-2) px-3 py-1.5 text-xs hover:border-(--warm-dim) hover:text-(--warm) max-[900px]:inline-flex max-[900px]:min-h-11 max-[900px]:items-center max-[900px]:justify-center"
              onClick={() => {
                void patchTodo(todo.id, { description: desc });
                setEditingDesc(false);
              }}
            >
              저장
            </button>
            <button
              type="button"
              className="drawer-btn rounded-[7px] border border-(--line-strong) bg-(--surface-2) px-3 py-1.5 text-xs hover:border-(--warm-dim) hover:text-(--warm) max-[900px]:inline-flex max-[900px]:min-h-11 max-[900px]:items-center max-[900px]:justify-center"
              onClick={() => setEditingDesc(false)}
            >
              취소
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="drawer-desc block w-full rounded-lg border border-(--line-strong) bg-(--bg) px-3 py-2.5 text-left text-[13px] text-(--text)"
          onClick={() => setEditingDesc(true)}
        >
          {todo.description === '' ? (
            <span className="drawer-desc-empty text-(--faint)">설명 없음 — 눌러서 작성</span>
          ) : (
            <Markdown text={todo.description} />
          )}
        </button>
      )}
      <div className="drawer-actions mt-3.5 flex flex-wrap gap-2">
        {todo.status !== 'doing' && statusButton('▶ 시작', 'start')}
        {todo.status === 'doing' && statusButton('⏸ 중단', 'stop')}
        {todo.status !== 'done' && statusButton('✓ 완료', 'done')}
        {todo.status === 'done' && statusButton('↺ 다시 열기', 'reopen')}
        {todo.archivedAt
          ? statusButton('보관 해제', 'unarchive')
          : statusButton('▣ 보관', 'archive')}
      </div>
      {pending ? (
        <div className="handoff-pending mt-2 flex items-center gap-2 text-(--handoff)">
          <span>대기 중 · {pending.sessionName ?? pending.sessionId} 에게</span>
          {pending.stale ? <span className="handoff-stale text-(--p1)">세션 없음</span> : null}
          <button type="button" onClick={() => void cancelHandoff(pending.id)}>
            취소
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="drawer-btn rounded-[7px] border border-(--line-strong) bg-(--surface-2) px-3 py-1.5 text-xs hover:border-(--warm-dim) hover:text-(--warm) max-[900px]:inline-flex max-[900px]:min-h-11 max-[900px]:items-center max-[900px]:justify-center"
          onClick={() => void openHandoff()}
        >
          에이전트에게 보내기
        </button>
      )}
      {handoffOpen && !pending ? (
        <div className="handoff-panel mt-2 flex flex-wrap gap-1.5">
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
            <p className="handoff-error w-full text-(--p1)" role="alert">
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
      <div className="drawer-actions mt-3.5 flex flex-wrap gap-2">
        <a
          className="drawer-btn rounded-[7px] border border-(--line-strong) bg-(--surface-2) px-3 py-1.5 text-xs hover:border-(--warm-dim) hover:text-(--warm) max-[900px]:inline-flex max-[900px]:min-h-11 max-[900px]:items-center max-[900px]:justify-center"
          href={issueUrl}
          target="_blank"
          rel="noreferrer"
        >
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
      <div className="issue-action mt-2.5">
        <p className="issue-unavailable m-0 text-xs leading-[1.4] text-(--muted)">
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
    <div className="issue-action mt-2.5">
      {asking && (
        <input
          className="issue-repo-input w-full rounded-md border border-(--line-strong) bg-(--bg) px-2 py-1.5"
          value={repo}
          placeholder="OWNER/NAME"
          aria-label="GitHub 레포 (OWNER/NAME)"
          onChange={(e) => setRepo(e.target.value)}
        />
      )}
      <div className="drawer-actions mt-3.5 flex flex-wrap gap-2">
        <button
          type="button"
          className="drawer-btn rounded-[7px] border border-(--line-strong) bg-(--surface-2) px-3 py-1.5 text-xs hover:border-(--warm-dim) hover:text-(--warm) max-[900px]:inline-flex max-[900px]:min-h-11 max-[900px]:items-center max-[900px]:justify-center"
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
        <div
          className="issue-error mt-1.5 text-xs leading-[1.4] whitespace-pre-wrap text-(--p1)"
          role="alert"
        >
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
      <div className="spawn-action mt-2.5 flex flex-col gap-1.5">
        <p className="spawn-unavailable m-0 text-xs leading-[1.4] text-(--muted)">
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
    <div className="spawn-action mt-2.5 flex flex-col gap-1.5">
      {asking && (
        <input
          className="spawn-path-input w-full rounded-md border border-(--line) bg-(--bg) px-2 py-1.5"
          value={path}
          placeholder="/Users/…/레포 절대경로"
          aria-label="메인 레포 절대경로"
          onChange={(e) => setPath(e.target.value)}
        />
      )}
      <input
        className="spawn-note-input w-full rounded-md border border-(--line) bg-(--bg) px-2 py-1.5"
        value={note}
        placeholder="메모 (선택)"
        aria-label="세션에 함께 보낼 메모"
        onChange={(e) => setNote(e.target.value)}
      />
      <div className="drawer-actions mt-3.5 flex flex-wrap gap-2">
        <button
          type="button"
          className="drawer-btn rounded-[7px] border border-(--line-strong) bg-(--surface-2) px-3 py-1.5 text-xs hover:border-(--warm-dim) hover:text-(--warm) max-[900px]:inline-flex max-[900px]:min-h-11 max-[900px]:items-center max-[900px]:justify-center"
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
        <div className="spawn-result mt-1.5 flex flex-col gap-1 text-xs leading-[1.4] text-(--handoff)">
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
        <div
          className="spawn-error mt-1.5 text-xs leading-[1.4] whitespace-pre-wrap text-(--p1)"
          role="alert"
        >
          {error}
        </div>
      )}
    </div>
  );
}
