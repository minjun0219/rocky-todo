import { join } from 'node:path';
import { loadConfig } from '../core/rocky-config';
import { resolveTodoRuntimeConfig } from '../todo/config';
import { buildNotifyContext, filterHumanChanges, readCursor, writeCursor } from '../todo/notify';
import type { ChangeFeedEntry } from '../todo/store';

/**
 * UserPromptSubmit hook: 마지막 확인 이후 호출자(사람)가 rocky-todo 보드에서 바꾼
 * 내용을 additionalContext 로 주입한다 — 웹 UI 편집이 에이전트에게 자동으로 전달되는 경로.
 *
 * 원칙:
 * - fail-open: 데몬이 죽어 있거나 어떤 에러든 조용히 exit 0 (프롬프트 처리를 막지 않는다).
 *   훅에서 데몬을 자동 기동하지 않는다 — 기동은 CLI/launchd 몫.
 * - 결정론적, LLM 미사용. 에이전트(claude-code/codex/opencode) 자신의 변경은 걸러
 *   자기 반향을 막는다.
 * - 토글: env `ROCKY_TODO_WATCH` > `rocky.json` 의 `todo.watch` (기본 on).
 * - 커서는 세션별 (`<dir>/hook-cursors.json`) — 첫 프롬프트에서는 현재 위치만 기록하고
 *   아무 것도 주입하지 않는다 (과거 히스토리 덤프 방지).
 */

interface HookInput {
  session_id?: string;
  cwd?: string;
}

const OFF_VALUES = new Set(['0', 'false', 'off', 'no']);

async function readStdin(): Promise<string> {
  let raw = '';
  for await (const chunk of process.stdin) {
    raw += chunk;
  }
  return raw;
}

async function fetchChanges(
  baseUrl: string,
  sinceId: number,
  limit: number,
): Promise<{ lastId: number; entries: ChangeFeedEntry[] } | null> {
  try {
    const res = await fetch(`${baseUrl}/api/changes?sinceId=${sinceId}&limit=${limit}`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) {
      return null;
    }
    return (await res.json()) as { lastId: number; entries: ChangeFeedEntry[] };
  } catch {
    return null;
  }
}

async function run(): Promise<void> {
  const envToggle = process.env.ROCKY_TODO_WATCH?.trim().toLowerCase();
  if (envToggle !== undefined && OFF_VALUES.has(envToggle)) {
    return;
  }

  let input: HookInput = {};
  try {
    input = JSON.parse(await readStdin()) as HookInput;
  } catch {
    // stdin 이 비어도 진행 — session_id 없으면 아래에서 종료.
  }
  const sessionId = input.session_id;
  if (!sessionId) {
    return;
  }

  const { config } = await loadConfig({ projectRoot: input.cwd ?? process.cwd() });
  if (envToggle === undefined && config.todo?.watch === false) {
    return;
  }

  const runtime = resolveTodoRuntimeConfig(process.env, config.todo);
  // 마스터 스위치 (todo.enabled, 기본 off) — 꺼져 있으면 완전 침묵
  if (!runtime.enabled) {
    return;
  }
  const baseUrl = `http://127.0.0.1:${runtime.port}`;
  const cursorFile = join(runtime.dir, 'hook-cursors.json');

  const cursor = readCursor(cursorFile, sessionId);
  if (cursor === undefined) {
    // 첫 프롬프트 — 현재 watermark 만 기록, 주입 없음.
    const head = await fetchChanges(baseUrl, 0, 1);
    if (head) {
      writeCursor(cursorFile, sessionId, head.lastId);
    }
    return;
  }

  const feed = await fetchChanges(baseUrl, cursor, 100);
  if (!feed) {
    return;
  }
  if (feed.lastId !== cursor) {
    writeCursor(cursorFile, sessionId, feed.lastId);
  }
  const context = buildNotifyContext(filterHumanChanges(feed.entries));
  if (!context) {
    return;
  }
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: context,
      },
    }),
  );
}

run()
  .catch(() => {
    // fail-open — 훅 실패가 프롬프트 처리를 막지 않는다.
  })
  .finally(() => {
    process.exit(0);
  });
