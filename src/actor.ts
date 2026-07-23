import { basename } from 'node:path';

/**
 * actor(누가) 와 board key(어느 프로젝트) 해석 — CLI 가 쓰는 순수 로직.
 *
 * actor 우선순위: env `ROCKY_TODO_ACTOR` > 호스트 마커 자동 감지 > 'agent'.
 * (CLI `--actor` 플래그는 cli.ts 에서 이 함수보다 앞서 적용된다.)
 *
 * board key 는 사람이 읽는 값이라 worklog 의 `<basename>-<hash>` 대신
 * git remote basename 을 우선한다 — 같은 레포의 워크트리 여러 개가
 * 자연스럽게 같은 보드로 모인다.
 */

/** 호스트 감지 마커 — 앞선 항목이 이긴다. */
const HOST_MARKERS: readonly [prefix: string, actor: string][] = [
  ['CLAUDECODE', 'claude-code'],
  ['CLAUDE_CODE', 'claude-code'],
  ['OPENCODE', 'opencode'],
  ['CODEX', 'codex'],
];

export function detectActor(env: Record<string, string | undefined> = process.env): string {
  const explicit = env.ROCKY_TODO_ACTOR;
  if (explicit && explicit.trim() !== '') {
    return explicit.trim();
  }
  for (const [prefix, actor] of HOST_MARKERS) {
    if (Object.keys(env).some((key) => key.startsWith(prefix) && env[key])) {
      return actor;
    }
  }
  return 'agent';
}

export interface BoardKeySources {
  /** `git remote get-url origin` 결과 (실패 시 undefined) */
  remoteUrl?: string;
  /** `git rev-parse --show-toplevel` 결과 (실패 시 undefined) */
  toplevel?: string;
  cwd?: string;
}

function sanitizeKey(raw: string): string {
  return raw
    .replace(/\.git$/, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** git remote basename > toplevel basename > cwd basename. 비면 'board'. */
export function boardKeyFrom(sources: BoardKeySources): string {
  const candidates: (string | undefined)[] = [
    sources.remoteUrl ? basename(sources.remoteUrl.replace(/\/+$/, '')) : undefined,
    sources.toplevel ? basename(sources.toplevel) : undefined,
    sources.cwd ? basename(sources.cwd) : undefined,
  ];
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    const key = sanitizeKey(candidate);
    if (key !== '') {
      return key;
    }
  }
  return 'board';
}
