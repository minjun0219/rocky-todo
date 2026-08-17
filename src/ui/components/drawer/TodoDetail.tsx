import { useEffect, useRef, useState } from 'react';
import { boardCommand, copyRefWithFeedback, linkLabel } from '../../lib';
import { useUiStore } from '../../store';
import { IssueAction } from './IssueAction';
import { Markdown } from './Markdown';
import { SpawnAction } from './SpawnAction';

export function TodoDetail() {
  const detail = useUiStore((s) => s.detail);
  const setTodoStatus = useUiStore((s) => s.setTodoStatus);
  const patchTodo = useUiStore((s) => s.patchTodo);
  const sections = useUiStore((s) => s.sections);
  const boards = useUiStore((s) => s.boards);
  const moveTodoToBoard = useUiStore((s) => s.moveTodoToBoard);
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
      {/*
        보드 이동 — 번호가 대상 보드에서 새로 발급된다(참조가 바뀐다). 하위 항목이 있으면
        서버가 거부하고, 그 에러는 alert 대신 콘솔로 — 드로어에 에러 자리를 새로 만들
        만큼 흔한 실패가 아니다. 섹션은 같은 이름이 대상에 있을 때만 이어진다.
      */}
      {boards.length > 1 && (
        <label className="mt-1 mb-1 flex items-center gap-2">
          <span className="drawer-section-label">보드</span>
          <select
            className="flex-auto rounded-md border border-line bg-surface px-2 py-[5px] text-[13px] text-text"
            value={todo.boardId}
            onChange={(e) => {
              const picked = boards.find((b) => b.id === e.target.value);
              if (picked && picked.id !== todo.boardId) {
                void moveTodoToBoard(todo.id, picked.key).catch((err) => {
                  console.warn('[rocky-todo] 보드 이동 실패', err);
                });
              }
            }}
          >
            {boards.map((board) => (
              <option key={board.id} value={board.id}>
                {board.title}
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
        {/* 같은 액션 어휘이므로 같은 컨테이너다 — 밖에 두면 gap 이 안 닿아 위 줄과
            0px 로 붙는다(실기기 제보 3회의 진범). 대기 중 상태 표시는 버튼이 아니라
            아래 별도 줄로 남는다. */}
        {!pending && (
          <button type="button" className="drawer-btn" onClick={() => void openHandoff()}>
            에이전트에게 보내기
          </button>
        )}
      </div>
      {pending ? (
        <div className="mt-2 flex items-center gap-2 text-handoff">
          <span>대기 중 · {pending.sessionName ?? pending.sessionId} 에게</span>
          {pending.stale ? <span className="text-p1">세션 없음</span> : null}
          <button type="button" onClick={() => void cancelHandoff(pending.id)}>
            취소
          </button>
        </div>
      ) : null}
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
              {/* w-full + min-w-0 — select 는 가장 긴 option(세션 cwd 전체 경로)의 고유
                  폭으로 늘어나 시트에 가로 스크롤을 만든다(실기기 제보). 폭을 컨테이너에
                  가두면 긴 옵션은 select 상자 안에서 잘려 보인다. */}
              <select
                className="w-full min-w-0 rounded-md border border-line bg-surface px-2 py-[5px] text-[13px] text-text"
                value={handoffSession}
                onChange={(e) => setHandoffSession(e.target.value)}
              >
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
