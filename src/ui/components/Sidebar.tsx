import { useState } from 'react';
import { useUiStore } from '../store';

/** 좌측 보드 목록 — 전체 뷰 + 보드별 뷰 전환, 보드 생성, 아카이브 토글. */
export function Sidebar() {
  const boards = useUiStore((s) => s.boards);
  const todos = useUiStore((s) => s.todos);
  const selected = useUiStore((s) => s.selected);
  const setSelected = useUiStore((s) => s.setSelected);
  const showArchived = useUiStore((s) => s.showArchived);
  const setShowArchived = useUiStore((s) => s.setShowArchived);
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
      {adding ? (
        <div className="board-add">
          <input
            className="board-add-input"
            value={key}
            placeholder="보드 이름 (레포 이름 권장)"
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
          {error && <div className="board-add-error">{error}</div>}
        </div>
      ) : (
        <button type="button" className="board-item board-add-open" onClick={() => setAdding(true)}>
          + 새 보드
        </button>
      )}
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
