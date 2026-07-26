import { join } from 'node:path';
import { resolveTodoRuntimeConfig } from '../src/config';
import { buildHandoffPrompt } from '../src/handoff';
import {
  buildNotifyContext,
  filterHumanChanges,
  mergeContext,
  readCursor,
  writeCursor,
} from '../src/notify';
import { loadTodoConfig } from '../src/rocky-config';
import type { ChangeFeedEntry, ClaimedHandoff } from '../src/store';

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

/** 이 세션 앞의 핸드오프 한 건을 집어온다. 없거나 실패하면 null (fail-open). */
async function claimHandoff(baseUrl: string, sessionId: string): Promise<ClaimedHandoff | null> {
  try {
    const res = await fetch(`${baseUrl}/api/handoffs/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, via: 'prompt' }),
      signal: AbortSignal.timeout(1500),
    });
    if (res.status !== 200) {
      return null;
    }
    return (await res.json()) as ClaimedHandoff;
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

  const { todo } = loadTodoConfig();
  if (envToggle === undefined && todo?.watch === false) {
    return;
  }

  const runtime = resolveTodoRuntimeConfig(process.env, todo);
  const baseUrl = `http://127.0.0.1:${runtime.port}`;
  const cursorFile = join(runtime.dir, 'hook-cursors.json');

  // claim 과 changes 조회는 서로 독립적이라 순차 await 하면 각각 1500ms timeout 이
  // 최악의 경우 더해져(3s) 훅 지연이 배가된다. claim 은 먼저 띄워두고, changes 쪽
  // 요청(커서 분기에 따라 head 1건 또는 feed)까지 만든 뒤 한 번에 Promise.all 로
  // 기다린다 — 커서 읽기/쓰기 순서와 "첫 프롬프트엔 과거 히스토리를 주입하지 않는다"는
  // 기존 동작은 그대로 유지한다 (읽기는 동기, 쓰기는 각 응답이 도착한 뒤).
  const claimPromise = claimHandoff(baseUrl, sessionId);

  const cursor = readCursor(cursorFile, sessionId);
  const feedPromise =
    cursor === undefined ? fetchChanges(baseUrl, 0, 1) : fetchChanges(baseUrl, cursor, 100);

  const [claimed, feed] = await Promise.all([claimPromise, feedPromise]);
  const handoffContext = claimed ? buildHandoffPrompt(claimed) : null;

  let changeContext: string | null = null;
  if (cursor === undefined) {
    // 첫 프롬프트 — 현재 watermark 만 기록하고 과거 히스토리는 주입하지 않는다.
    if (feed) {
      writeCursor(cursorFile, sessionId, feed.lastId);
    }
  } else if (feed) {
    if (feed.lastId !== cursor) {
      writeCursor(cursorFile, sessionId, feed.lastId);
    }
    changeContext = buildNotifyContext(filterHumanChanges(feed.entries));
  }

  const context = mergeContext([changeContext, handoffContext]);
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
