import { useState } from 'react';
import { useUiStore } from '../store';
import { ThermalStrip } from './ThermalStrip';

/** 상단 바 — 워드마크 + 링크(SSE) 상태 + 보관됨 표시 토글 + 호출자(actor) 설정. */
export function TopBar() {
  const connected = useUiStore((s) => s.connected);
  const actor = useUiStore((s) => s.actor);
  const setActor = useUiStore((s) => s.setActor);
  const showArchived = useUiStore((s) => s.showArchived);
  const setShowArchived = useUiStore((s) => s.setShowArchived);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(actor);

  return (
    <header className="topbar flex items-center gap-4 border-b border-line bg-surface px-5 py-[10px]">
      <span className="wordmark font-mono text-[13px] font-bold tracking-[0.22em]">
        ROCKY<span className="text-warm">·</span>TODO
      </span>
      <span
        className={`link-status inline-flex items-center gap-1.5 font-mono text-[10px] tracking-[0.18em] ${connected ? 'is-on text-warm' : 'text-faint'}`}
        title="데몬 SSE 연결 상태"
      >
        <span className="link-pulse size-1.5 rounded-full bg-current" />
        {connected ? 'LINK ♪' : 'NO LINK'}
      </span>
      <div className="flex-1" />
      <ThermalStrip />
      <div className="flex-1" />
      <label className="archived-toggle flex cursor-pointer items-center gap-1.5 text-xs text-muted">
        <input
          type="checkbox"
          checked={showArchived}
          onChange={(e) => setShowArchived(e.target.checked)}
        />
        보관됨 표시
      </label>
      {editing ? (
        <form
          className="actor-form"
          onSubmit={(e) => {
            e.preventDefault();
            const next = draft.trim();
            if (next !== '') {
              setActor(next);
            }
            setEditing(false);
          }}
        >
          <input
            className="actor-input w-[120px] rounded-full border border-cool bg-bg px-3 py-[3px] font-mono text-xs text-cool"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            // biome-ignore lint/a11y/noAutofocus: 호출자 이름 편집 진입 시 즉시 입력
            autoFocus
            onBlur={() => setEditing(false)}
          />
        </form>
      ) : (
        <button
          type="button"
          className="rounded-full border border-cool-dim px-3 py-[3px] font-mono text-xs text-cool"
          title="호출자 이름 — 웹에서의 편집은 이 이름으로 기록된다"
          onClick={() => {
            setDraft(actor);
            setEditing(true);
          }}
        >
          {actor}
        </button>
      )}
    </header>
  );
}
