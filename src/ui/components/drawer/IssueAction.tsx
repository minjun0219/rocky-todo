import { ArrowUpRight } from 'lucide-react';
import { useState } from 'react';
import { findIssueLink } from '../../../github';
import type { TodoView } from '../../../server';
import { useUiStore } from '../../store';

export function IssueAction({ todo }: { todo: TodoView }) {
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
          이슈 열기 <ArrowUpRight size={11} aria-hidden className="inline align-[-1px]" />
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
