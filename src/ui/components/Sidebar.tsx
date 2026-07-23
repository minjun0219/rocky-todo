import { useUiStore } from '../store';

/** 좌측 보드 목록 — 전체 뷰 + 보드별 뷰 전환, 아카이브 토글. */
export function Sidebar() {
  const boards = useUiStore((s) => s.boards);
  const todos = useUiStore((s) => s.todos);
  const selected = useUiStore((s) => s.selected);
  const setSelected = useUiStore((s) => s.setSelected);
  const showArchived = useUiStore((s) => s.showArchived);
  const setShowArchived = useUiStore((s) => s.setShowArchived);

  const doingBoards = new Set(todos.filter((t) => t.status === 'doing').map((t) => t.boardId));

  return (
    <nav className="sidebar">
      <div className="sidebar-label">BOARDS</div>
      <button
        type="button"
        className={`board-item ${selected === 'all' ? 'is-active' : ''}`}
        onClick={() => setSelected('all')}
      >
        전체
      </button>
      {boards.map((board) => (
        <button
          key={board.id}
          type="button"
          className={`board-item ${selected === board.key ? 'is-active' : ''}`}
          onClick={() => setSelected(board.key)}
        >
          {board.title}
          {doingBoards.has(board.id) && <span className="doing-dot" title="처리중인 항목 있음" />}
        </button>
      ))}
      <div className="sidebar-foot">
        <label className="archived-toggle">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />
          보관됨 표시
        </label>
      </div>
    </nav>
  );
}
