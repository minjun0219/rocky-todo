import { useState } from 'react';
import type { TodoView } from '../../../server';
import { useUiStore } from '../../store';

export function SpawnAction({ todo }: { todo: TodoView }) {
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
