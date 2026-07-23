import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ChangeFeedEntry } from './store';

/**
 * UserPromptSubmit 훅의 순수 로직 — "마지막 확인 이후 호출자(사람)가 보드에서
 * 무엇을 바꿨나"를 컴팩트한 한국어 컨텍스트로 만든다. 훅 엔트리(src/hooks/notify-todo.ts)는
 * 데몬 HTTP 호출 + stdin/stdout 배선만 담당한다.
 *
 * 커서는 세션별 — `<dir>/hook-cursors.json` 에 { sessionId: { lastId, at } } 로 저장하고
 * 최근 100 세션만 유지한다 (무한 성장 방지).
 */

/** 에이전트로 간주하는 actor — 이들의 변경은 주입하지 않는다 (자기 반향 방지). */
const AGENT_ACTORS = new Set(['claude-code', 'codex', 'opencode', 'agent', 'rocky']);

export function filterHumanChanges(entries: ChangeFeedEntry[]): ChangeFeedEntry[] {
  return entries.filter((e) => !AGENT_ACTORS.has(e.actor));
}

const ACTION_LABELS: Record<string, string> = {
  create: '생성',
  update: '수정',
  start: '시작',
  stop: '중단',
  done: '완료',
  reopen: '다시 열기',
  archive: '보관',
  unarchive: '보관 해제',
};

function formatLine(entry: ChangeFeedEntry): string {
  const board = entry.boardKey ? `[${entry.boardKey}] ` : '';
  const kind =
    entry.entity === 'note' ? '메모 ' : entry.entity === 'todo' ? '' : `${entry.entity} `;
  const action = ACTION_LABELS[entry.action] ?? entry.action;
  const diff = entry.changes
    ? Object.entries(entry.changes)
        .filter(([field]) => field !== 'content') // 메모 본문 diff 는 장황 — 필드명만
        .map(
          ([field, [oldValue, newValue]]) => `${field}: ${String(oldValue)} → ${String(newValue)}`,
        )
        .slice(0, 3)
        .join(', ')
    : '';
  const diffPart = diff ? ` (${diff})` : entry.changes?.content ? ' (내용 편집)' : '';
  return `- ${entry.actor}: ${board}${kind}"${entry.title}" ${action}${diffPart} · ${entry.entityId.slice(0, 6)}`;
}

/**
 * 주입할 컨텍스트 본문. 항목이 없으면 null (아무 것도 주입하지 않음).
 * 에이전트가 후속 조치를 스스로 판단하도록 안내 한 줄을 붙인다.
 */
export function buildNotifyContext(entries: ChangeFeedEntry[]): string | null {
  if (entries.length === 0) {
    return null;
  }
  const lines = entries.map(formatLine);
  return [
    '# rocky-todo: 마지막 확인 이후 호출자의 보드 변경',
    '',
    ...lines,
    '',
    '(자동 주입 — 필요하면 todo_list / note_list 로 상세를 확인하고, 지시로 해석되는 항목은 사용자에게 확인 후 진행)',
  ].join('\n');
}

interface CursorFile {
  [sessionId: string]: { lastId: number; at: string };
}

const MAX_CURSOR_SESSIONS = 100;

function readCursorFile(file: string): CursorFile {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    return parsed as CursorFile;
  } catch {
    return {};
  }
}

export function readCursor(file: string, sessionId: string): number | undefined {
  const cursor = readCursorFile(file)[sessionId];
  return typeof cursor?.lastId === 'number' ? cursor.lastId : undefined;
}

export function writeCursor(file: string, sessionId: string, lastId: number): void {
  const all = readCursorFile(file);
  all[sessionId] = { lastId, at: new Date().toISOString() };
  const entries = Object.entries(all)
    .sort(([, a], [, b]) => (a.at < b.at ? 1 : -1))
    .slice(0, MAX_CURSOR_SESSIONS);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(Object.fromEntries(entries)));
}
