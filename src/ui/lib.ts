/**
 * UI 순수 헬퍼 — actor 톤(두 대기 컨셉), 시간 표기, 초경량 markdown 렌더 토큰화.
 */

/** 에이전트로 취급하는 actor 이름 — 따뜻한 앰버 톤 (에리디언의 대기). */
const AGENT_ACTORS = new Set(['claude-code', 'codex', 'opencode', 'agent', 'rocky']);

/**
 * actor → 시각 톤. 에이전트는 warm(앰버), 사람은 cool(아이스 블루).
 * "누가 했나"를 온도로 인코딩하는 것이 이 UI 의 시그니처다.
 */
export function actorTone(actor: string): 'warm' | 'cool' {
  return AGENT_ACTORS.has(actor) ? 'warm' : 'cool';
}

/** doing 경과가 이 시간(ms)을 넘으면 stale 로 표시한다. */
export const STALE_MS = 30 * 60 * 1000;

export function isStale(doingSince: string | undefined, now = Date.now()): boolean {
  if (!doingSince) {
    return false;
  }
  return now - Date.parse(doingSince) > STALE_MS;
}

/** "방금" / "N분" / "N시간" / "N일" — doing 뱃지와 히스토리 타임스탬프용. */
export function formatElapsed(iso: string, now = Date.now()): string {
  const ms = Math.max(0, now - Date.parse(iso));
  const min = Math.floor(ms / 60_000);
  if (min < 1) {
    return '방금';
  }
  if (min < 60) {
    return `${min}분`;
  }
  const hours = Math.floor(min / 60);
  if (hours < 24) {
    return `${hours}시간`;
  }
  return `${Math.floor(hours / 24)}일`;
}

/** 마감일 표기 — "8/1" 형태. 지난 날짜 여부는 isOverdue 로 별도 판단. */
export function formatDue(due: string): string {
  const [, month, day] = due.split('-');
  if (!month || !day) {
    return due;
  }
  return `${Number(month)}/${Number(day)}`;
}

export function isOverdue(due: string, now = new Date()): boolean {
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return due < today;
}

export type MdToken =
  | { type: 'text'; value: string }
  | { type: 'bold'; value: string }
  | { type: 'code'; value: string }
  | { type: 'link'; value: string };

/**
 * 초경량 markdown 토큰화 — **bold** / `code` / http(s) URL 만 지원.
 * React 노드로 조립하므로 HTML escape 는 불필요하다 (innerHTML 미사용).
 */
export function mdTokens(text: string): MdToken[] {
  const tokens: MdToken[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|https?:\/\/\S+)/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) {
      tokens.push({ type: 'text', value: text.slice(last, index) });
    }
    const raw = match[0];
    if (raw.startsWith('**')) {
      tokens.push({ type: 'bold', value: raw.slice(2, -2) });
    } else if (raw.startsWith('`')) {
      tokens.push({ type: 'code', value: raw.slice(1, -1) });
    } else {
      tokens.push({ type: 'link', value: raw });
    }
    last = index + raw.length;
  }
  if (last < text.length) {
    tokens.push({ type: 'text', value: text.slice(last) });
  }
  return tokens;
}

/** 링크 URL → 짧은 출처 라벨 (github.com/owner/repo#12, todoist, …). */
export function linkLabel(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname === 'github.com') {
      const [owner, repo, kind, num] = u.pathname.slice(1).split('/');
      if (owner && repo && (kind === 'issues' || kind === 'pull') && num) {
        return `${repo}#${num}`;
      }
      return `${owner}/${repo ?? ''}`.replace(/\/$/, '');
    }
    if (u.hostname.includes('todoist')) {
      return 'todoist';
    }
    return u.hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
