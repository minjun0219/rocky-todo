import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isAgentActor } from './actors';
import type { ChangeFeedEntry } from './store';

/**
 * UserPromptSubmit 훅의 순수 로직 — "마지막 확인 이후 호출자(사람)가 보드에서
 * 무엇을 바꿨나"를 컴팩트한 한국어 컨텍스트로 만든다. 훅 엔트리(src/hooks/notify-todo.ts)는
 * 데몬 HTTP 호출 + stdin/stdout 배선만 담당한다.
 *
 * 커서는 세션별 — `<dir>/hook-cursors.json` 에 { sessionId: { lastId, at } } 로 저장하고
 * 최근 100 세션만 유지한다 (무한 성장 방지).
 */

/**
 * 사람이 낸 변경만 남긴다 (에이전트 자신의 변경을 주입하는 자기 반향 방지).
 *
 * handoff 계열 액션은 여기까지 오지 않는다 — `TodoStore.listChangesSince` 가 쿼리에서
 * 이미 뺀다. `handoff-delivered` 의 actor 는 **대상 세션 이름**(`eelpout-a3`)이라 이름만
 * 보면 사람으로 분류될 값인데, 그 필터 덕에 여기서 한 번 더 막을 필요가 없다.
 */
export function filterHumanChanges(entries: ChangeFeedEntry[]): ChangeFeedEntry[] {
  return entries.filter((e) => !isAgentActor(e.actor));
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
  'comment-archive': '댓글 보관',
  'comment-unarchive': '댓글 보관 해제',
};

/**
 * 본문을 실어 보여주는 액션 — 나머지는 기존 `field: old → new` 렌더를 탄다.
 *
 * `src/store.ts` 의 `DETAIL_HISTORY_EXCLUDED` 와 값이 우연히 같지만(둘 다
 * `['comment', 'comment-edit']`) 여기는 별개의 결정("본문을 한 줄로 인라인 렌더할까")
 * 을 인코딩한다 — 저쪽은 "상세 화면에서 뺄까"다. 커플링하지 않는다: 셋째 댓글 액션이
 * 생겨도 이 파일의 렌더 여부는 독립적으로 정해질 수 있다.
 */
const COMMENT_ACTIONS: ReadonlySet<string> = new Set(['comment', 'comment-edit']);

/** 주입 컨텍스트가 길어지지 않게 본문 길이를 제한한다. */
const COMMENT_MAX_CHARS = 200;

/** 댓글 본문을 한 줄로 접고 길면 자른다. */
function condenseBody(body: string): string {
  const oneLine = body.replace(/\s+/g, ' ').trim();
  return oneLine.length > COMMENT_MAX_CHARS ? `${oneLine.slice(0, COMMENT_MAX_CHARS)}…` : oneLine;
}

function formatLine(entry: ChangeFeedEntry): string {
  const board = entry.boardKey ? `[${entry.boardKey}] ` : '';
  if (COMMENT_ACTIONS.has(entry.action)) {
    // 댓글은 문장이라 `field: old → new` 렌더가 맞지 않는다 — 본문을 그대로 보여준다.
    const raw = entry.changes?.comment?.[1];
    const body = typeof raw === 'string' ? condenseBody(raw) : '';
    const label = entry.action === 'comment' ? '댓글' : '댓글 수정';
    return `- ${entry.actor}: ${board}"${entry.title}" ${label} · "${body}" · ${entry.entityId.slice(0, 6)}`;
  }
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

/**
 * 여러 주입 블록을 하나의 additionalContext 로 합친다 — 사람의 보드 변경과 핸드오프
 * 요청이 같은 프롬프트에 함께 도착할 수 있다.
 * @returns 실을 내용이 하나도 없으면 null.
 */
export function mergeContext(parts: Array<string | null>): string | null {
  const kept = parts.filter((part): part is string => typeof part === 'string' && part !== '');
  return kept.length > 0 ? kept.join('\n\n') : null;
}

export function writeCursor(file: string, sessionId: string, lastId: number): void {
  const all = readCursorFile(file);
  all[sessionId] = { lastId, at: new Date().toISOString() };
  // `at` desc 로 최신 100개만 유지. `at` 은 밀리초라 여러 세션이 같은 값을 갖기 쉬워
  // 동률을 **삽입 순서**로 깨야 한다 — reverse() 로 최신 삽입을 앞에 두고, 3-way 비교
  // (동률 0)로 stable sort 를 보장해 최신이 살아남게 한다.
  //
  // 그 reverse() 는 "파일의 키 순서 = 삽입 순서(오래된 것 먼저)"를 전제한다. 그래서
  // **자르고 나서 다시 reverse 해 그 순서로 되돌려 저장한다**: 정렬된 순서(최신 먼저)를
  // 그대로 쓰면 다음 호출의 reverse() 가 전제를 잃고, 동률 그룹의 순서가 매 호출 뒤집혀
  // slice 가 오래된 것이 아니라 임의의 구간을 잘라낸다(관측: 120개를 넣었을 때 0–11 과
  // 16–23 이 빠지고 12–15 는 남았다).
  const entries = Object.entries(all)
    .reverse()
    .sort(([, a], [, b]) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, MAX_CURSOR_SESSIONS)
    .reverse();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(Object.fromEntries(entries)));
}
