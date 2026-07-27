import { useState } from 'react';
import type { ThemePref } from '../lib';
import { useUiStore } from '../store';

/** 토글 순환 — auto 에서 시작해 명시 선택을 거쳐 다시 auto 로 돌아온다. */
const THEME_CYCLE: Record<ThemePref, ThemePref> = {
  auto: 'dark',
  dark: 'light',
  light: 'auto',
};

const THEME_GLYPH: Record<ThemePref, string> = {
  auto: '◐',
  dark: '●',
  light: '○',
};

const THEME_LABEL: Record<ThemePref, string> = {
  auto: '시스템 설정 따름',
  dark: '어두운 테마',
  light: '밝은 테마',
};

/** 상단 바 — 워드마크 + 링크(SSE) 상태 + 보관됨 표시 토글 + 호출자(actor) 설정. */
export function TopBar() {
  const connected = useUiStore((s) => s.connected);
  const actor = useUiStore((s) => s.actor);
  const setActor = useUiStore((s) => s.setActor);
  const showArchived = useUiStore((s) => s.showArchived);
  const setShowArchived = useUiStore((s) => s.setShowArchived);
  const themePref = useUiStore((s) => s.themePref);
  const setThemePref = useUiStore((s) => s.setThemePref);
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
      <button
        type="button"
        className="theme-toggle"
        title={`테마 — ${THEME_LABEL[themePref]} (눌러서 ${THEME_LABEL[THEME_CYCLE[themePref]]})`}
        aria-label={`테마 — 현재 ${THEME_LABEL[themePref]}. 눌러서 ${THEME_LABEL[THEME_CYCLE[themePref]]}`}
        onClick={() => setThemePref(THEME_CYCLE[themePref])}
      >
        {THEME_GLYPH[themePref]}
      </button>
      <label className="archived-toggle">
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
