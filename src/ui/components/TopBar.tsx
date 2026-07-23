import { useState } from 'react';
import { useUiStore } from '../store';

/** 상단 바 — 워드마크 + 링크(SSE) 상태 + 호출자(actor) 설정. */
export function TopBar() {
  const connected = useUiStore((s) => s.connected);
  const actor = useUiStore((s) => s.actor);
  const setActor = useUiStore((s) => s.setActor);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(actor);

  return (
    <header className="topbar">
      <span className="wordmark">
        ROCKY<span className="wordmark-dot">·</span>TODO
      </span>
      <span className={`link-status ${connected ? 'is-on' : 'is-off'}`} title="데몬 SSE 연결 상태">
        <span className="link-pulse" />
        {connected ? 'LINK ♪' : 'NO LINK'}
      </span>
      <div className="topbar-spacer" />
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
            className="actor-input"
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
          className="actor-chip tone-cool"
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
