import { useState } from 'react';
import { useUiStore } from '../store';

/** 좌측 보드 목록 — 전체 뷰 + 보드별 뷰 전환, 보드 생성. */
export function Sidebar() {
  const boards = useUiStore((s) => s.boards);
  const todos = useUiStore((s) => s.todos);
  const selected = useUiStore((s) => s.selected);
  const setSelected = useUiStore((s) => s.setSelected);
  const createBoard = useUiStore((s) => s.createBoard);

  const [adding, setAdding] = useState(false);
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);

  const doingBoards = new Set(todos.filter((t) => t.status === 'doing').map((t) => t.boardId));

  const closeAdd = () => {
    setAdding(false);
    setKey('');
    setError(null);
  };

  /**
   * 서버가 key 를 거절하면(공백·`#` 은 참조로 쓸 수 없다) 그 이유를 그대로 보여주고
   * 입력을 유지한다 — 조용히 닫으면 왜 안 만들어졌는지 알 수 없다.
   */
  const submit = async () => {
    const next = key.trim();
    if (next === '') {
      closeAdd();
      return;
    }
    try {
      await createBoard(next);
      closeAdd();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <nav className="sidebar flex flex-col gap-0.5 overflow-y-auto border-r border-line px-2.5 py-4">
      <div className="sidebar-label">BOARDS</div>
      <button
        type="button"
        className={`board-item flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-muted hover:bg-surface hover:text-text ${selected === 'all' ? 'bg-surface-2 font-semibold text-text' : ''}`}
        onClick={() => setSelected('all')}
      >
        전체
      </button>
      {boards.map((board) => (
        <button
          key={board.id}
          type="button"
          className={`board-item flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-muted hover:bg-surface hover:text-text ${selected === board.key ? 'bg-surface-2 font-semibold text-text' : ''}`}
          onClick={() => setSelected(board.key)}
        >
          {board.title}
          {doingBoards.has(board.id) && (
            <span className="doing-dot size-1.5 rounded-full bg-warm" title="처리중인 항목 있음" />
          )}
        </button>
      ))}
      {adding ? (
        <div className="board-add">
          <input
            className="board-add-input"
            value={key}
            placeholder="보드 이름 (레포 이름 권장)"
            aria-label="새 보드 이름"
            // biome-ignore lint/a11y/noAutofocus: 버튼을 눌러 진입한 입력이라 즉시 타이핑이 기대 동작
            autoFocus
            onChange={(e) => {
              setKey(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                void submit();
              } else if (e.key === 'Escape') {
                closeAdd();
              }
            }}
          />
          {/* 생성 실패 사유는 즉시 읽혀야 한다 — 보이기만 하면 스크린리더가 놓친다. */}
          {error && (
            <div className="board-add-error" role="alert">
              {error}
            </div>
          )}
        </div>
      ) : (
        <button
          type="button"
          className="board-item flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-muted hover:bg-surface hover:text-text board-add-open text-faint"
          onClick={() => setAdding(true)}
        >
          + 새 보드
        </button>
      )}
    </nav>
  );
}
