import { useState } from 'react';
import type { ThemePref } from '../lib';
import { useUiStore } from '../store';
import { ThermalStrip } from './ThermalStrip';

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
    <header className="topbar flex items-center gap-4 border-b border-line bg-surface px-5 py-[10px]">
      <span className="wordmark font-mono text-[13px] font-bold tracking-[0.22em]">
        ROCKY<span className="text-warm">·</span>TODO
      </span>
      <span
        className={`link-status inline-flex items-center gap-1.5 font-mono text-[10px] tracking-[0.18em] ${connected ? 'is-on text-warm' : 'text-faint'}`}
        title="데몬 SSE 연결 상태"
      >
        <span className="link-pulse size-1.5 rounded-full bg-current" />
        {/* 초좁은 화면에선 텍스트를 접고 펄스 점만 — 상태는 점 색과 title 로 남는다.
            한 줄에 전부 들어가는 게 그룹째 줄바꿈보다 낫다(실기기 제보). */}
        <span className="max-[430px]:hidden">{connected ? 'LINK ♪' : 'NO LINK'}</span>
      </span>
      <div className="flex-1" />
      <ThermalStrip />
      <div className="flex-1" />
      {/* 컨트롤 묶음 — 좁은 화면에서 폭이 모자라면 낱개가 아니라 **그룹째** 다음 줄로
          떨어지고, ml-auto 가 그 줄에서도 우측 정렬을 유지한다. 낱개로 흩어지면 actor
          칩이 혼자 왼쪽에 떠 깨져 보인다(실기기 제보). */}
      <div className="ml-auto flex items-center gap-2.5">
        <button
          type="button"
          className="theme-toggle inline-flex items-center justify-center font-mono text-[13px] text-muted hover:text-text"
          title={`테마 — ${THEME_LABEL[themePref]} (눌러서 ${THEME_LABEL[THEME_CYCLE[themePref]]})`}
          aria-label={`테마 — 현재 ${THEME_LABEL[themePref]}. 눌러서 ${THEME_LABEL[THEME_CYCLE[themePref]]}`}
          onClick={() => setThemePref(THEME_CYCLE[themePref])}
        >
          {THEME_GLYPH[themePref]}
        </button>
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
      </div>
    </header>
  );
}
