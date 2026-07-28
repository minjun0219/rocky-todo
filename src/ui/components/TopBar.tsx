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

/** 상단 바 — 워드마크 + 링크(SSE) 상태 + 테마 토글 + 보관됨 표시 토글 + 호출자(actor) 설정. */
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
    <header className="topbar flex items-center gap-4 border-b border-(--line) bg-(--surface) px-5 py-2.5 max-[900px]:flex-wrap max-[900px]:gap-2.5 max-[900px]:px-3.5">
      <span className="wordmark font-(family-name:--mono) text-[13px] font-bold tracking-[0.22em]">
        ROCKY<span className="text-(--warm)">·</span>TODO
      </span>
      <span
        className={`link-status inline-flex items-center gap-1.5 font-(family-name:--mono) text-[11px] tracking-[0.18em] ${connected ? 'is-on text-(--warm)' : 'is-off text-(--faint)'}`}
        title="데몬 SSE 연결 상태"
      >
        <span
          className={`link-pulse size-1.5 rounded-full bg-current ${connected ? '[animation:pulse_2.4s_ease-in-out_infinite] motion-reduce:animate-none' : ''}`}
        />
        {connected ? 'LINK ♪' : 'NO LINK'}
      </span>
      <div className="flex-1" />
      <button
        type="button"
        className="theme-toggle inline-flex items-center justify-center font-(family-name:--mono) text-[13px] text-(--muted) hover:text-(--text) max-[900px]:min-h-11 max-[900px]:min-w-11"
        title={`테마 — ${THEME_LABEL[themePref]} (눌러서 ${THEME_LABEL[THEME_CYCLE[themePref]]})`}
        aria-label={`테마 — 현재 ${THEME_LABEL[themePref]}. 눌러서 ${THEME_LABEL[THEME_CYCLE[themePref]]}`}
        onClick={() => setThemePref(THEME_CYCLE[themePref])}
      >
        {THEME_GLYPH[themePref]}
      </button>
      <label className="archived-toggle flex cursor-pointer items-center gap-1.5 text-xs text-(--muted) max-[900px]:min-h-11 max-[900px]:whitespace-nowrap">
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
            className="actor-input w-[120px] rounded-full border border-(--cool) bg-(--bg) px-3 py-[3px] font-(family-name:--mono) text-xs text-(--cool) max-[900px]:text-base"
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
          className="actor-chip tone-cool rounded-full border border-(--cool-dim) px-3 py-[3px] font-(family-name:--mono) text-xs text-(--cool)"
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
