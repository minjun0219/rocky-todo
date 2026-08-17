import { ArrowUpRight } from 'lucide-react';
import { useState } from 'react';
import type { Board } from '../../store';
import { useUiStore } from '../store';

/**
 * 선택된 보드의 정체 — 이름 · slug · 설명 · GitHub 레포 · 레포 경로, 그리고 그 전부를
 * 고치는 편집 폼.
 *
 * 보드 목록은 `title` 만 보여주므로 "이 보드가 무엇인가" 를 알 자리가 없었고, `key` 는
 * 한번 정하면 바꿀 방법이 아예 없었다(이름이 바뀐 프로젝트의 보드가 옛 이름으로 방치됐다).
 * 편집 폼은 네 필드(이름·key·설명·GitHub)를 묶어 한 번의 PATCH 로 보낸다 — 서버가
 * 트랜잭션으로 적용하므로 일부만 반영된 상태가 없다. `path` 는 표시만 한다: 그 값은
 * 데몬이 프로세스를 띄우는 자리(spawn)라 사람이 손으로 칠 대상이 아니고, spawn 흐름이
 * 이미 자기 입력창을 갖고 있다(`DetailDrawer`).
 */
export function BoardHeader({ board }: { board: Board }) {
  const updateBoard = useUiStore((s) => s.updateBoard);
  const [editing, setEditing] = useState(false);

  if (editing) {
    return <BoardEditForm board={board} onDone={() => setEditing(false)} onSave={updateBoard} />;
  }

  return (
    <header className="mb-4">
      <div className="flex items-baseline gap-2.5">
        <h1 className="m-0 text-[17px] font-bold leading-[1.3]">{board.title}</h1>
        {/* 제목이 key 그대로면 같은 글자를 두 번 찍지 않는다. */}
        {board.title !== board.key && (
          <span
            className="font-mono text-[11px] text-faint"
            title="보드 key — 참조 접두사이자 cwd 로 유추되는 이름"
          >
            {board.key}
          </span>
        )}
        <div className="flex-1" />
        <button
          type="button"
          className="text-[11px] text-faint hover:text-warm"
          onClick={() => setEditing(true)}
          title="보드 이름·slug·설명·GitHub 레포 수정"
        >
          편집
        </button>
      </div>
      {board.description && <p className="mt-1 mb-0 text-[13px] text-muted">{board.description}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {board.repo && (
          <a
            className="chip chip-link"
            href={`https://github.com/${board.repo}`}
            target="_blank"
            rel="noreferrer"
          >
            {board.repo} <ArrowUpRight size={11} aria-hidden className="inline align-[-1px]" />
          </a>
        )}
        {board.path && <span className="chip text-faint">{board.path}</span>}
        {board.previousKeys && board.previousKeys.length > 0 && (
          // 옛 참조(`gotgan-12`)가 아직 살아 있다는 걸 아는 유일한 자리다 — 다른 표면은
          // 언제나 새 key 만 내보낸다.
          <span className="chip text-faint" title="옛 이름 — 이 참조도 계속 풀린다">
            옛 이름 {board.previousKeys.join(', ')}
          </span>
        )}
      </div>
    </header>
  );
}

/** 편집 폼 — 저장에 성공해야 닫힌다. 실패 사유는 입력을 유지한 채 그 자리에 보여준다. */
function BoardEditForm({
  board,
  onDone,
  onSave,
}: {
  board: Board;
  onDone: () => void;
  onSave: (
    boardKey: string,
    patch: { key?: string; title?: string; description?: string | null; repo?: string | null },
  ) => Promise<void>;
}) {
  const [key, setKey] = useState(board.key);
  const [title, setTitle] = useState(board.title);
  const [description, setDescription] = useState(board.description ?? '');
  const [repo, setRepo] = useState(board.repo ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    // 저장 버튼은 `disabled={busy}` 지만 input 의 Enter 는 버튼 상태와 무관하게 submit 을
    // 일으킨다 — 연타하면 같은 변경이 두 번 나가고, 첫 요청의 에러가 두 번째 응답에 덮인다.
    if (busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // 안 바뀐 필드는 아예 보내지 않는다 — 서버의 no-op 판정에 기대는 대신 여기서
      // 걸러야 "설명만 고쳤는데 key 변경 검증에 걸리는" 일이 없다. 비운 값은 `null`
      // ("지운다")로 보낸다 — 빈 문자열은 서버가 400 으로 거절한다.
      const patch: Parameters<typeof onSave>[1] = {};
      if (key.trim() !== board.key) {
        patch.key = key.trim();
      }
      if (title.trim() !== board.title) {
        patch.title = title.trim();
      }
      if (description.trim() !== (board.description ?? '')) {
        patch.description = description.trim() === '' ? null : description.trim();
      }
      if (repo.trim() !== (board.repo ?? '')) {
        patch.repo = repo.trim() === '' ? null : repo.trim();
      }
      if (Object.keys(patch).length > 0) {
        await onSave(board.key, patch);
      }
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="mb-4 rounded-lg border border-line bg-surface px-3.5 py-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label className="mb-1.5 flex items-center gap-2.5">
        <span className="w-14 shrink-0 font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
          이름
        </span>
        <input
          className="board-edit-input min-w-0 flex-1 rounded-md border border-line bg-bg px-[9px] py-[5px] text-[13px] text-text placeholder:text-faint"
          value={title}
          // biome-ignore lint/a11y/noAutofocus: 편집 버튼을 눌러 진입한 폼이라 즉시 입력이 기대 동작
          autoFocus
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <label className="mb-1.5 flex items-center gap-2.5">
        <span className="w-14 shrink-0 font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
          key
        </span>
        <input
          className="board-edit-input min-w-0 flex-1 rounded-md border border-line bg-bg px-[9px] py-[5px] text-[13px] text-text placeholder:text-faint"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          aria-describedby="board-edit-key-hint"
        />
      </label>
      <p
        className="mb-2 ml-[66px] mt-0 text-[11px] leading-normal text-faint [&_code]:font-mono"
        id="board-edit-key-hint"
      >
        key 는 참조 접두사(<code>{key.trim() || board.key}-12</code>)이자 레포 이름으로 유추되는
        식별자다. 바꿔도 옛 참조는 계속 풀린다.
      </p>
      <label className="mb-1.5 flex items-center gap-2.5">
        <span className="w-14 shrink-0 font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
          설명
        </span>
        <input
          className="board-edit-input min-w-0 flex-1 rounded-md border border-line bg-bg px-[9px] py-[5px] text-[13px] text-text placeholder:text-faint"
          value={description}
          placeholder="이 보드가 무엇인가 (한 줄)"
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>
      <label className="mb-1.5 flex items-center gap-2.5">
        <span className="w-14 shrink-0 font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
          GitHub
        </span>
        <input
          className="board-edit-input min-w-0 flex-1 rounded-md border border-line bg-bg px-[9px] py-[5px] text-[13px] text-text placeholder:text-faint"
          value={repo}
          placeholder="OWNER/NAME"
          onChange={(e) => setRepo(e.target.value)}
        />
      </label>
      {/* 저장 실패 사유는 즉시 읽혀야 한다 — 보이기만 하면 스크린리더가 놓친다. */}
      {error && (
        <div className="board-add-error" role="alert">
          {error}
        </div>
      )}
      <div className="drawer-actions">
        <button type="submit" className="drawer-btn" disabled={busy}>
          {busy ? '저장 중…' : '저장'}
        </button>
        <button type="button" className="drawer-btn" onClick={onDone} disabled={busy}>
          취소
        </button>
      </div>
    </form>
  );
}
