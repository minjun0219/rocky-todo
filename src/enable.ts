import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { USER_CONFIG_PATH } from '../core/rocky-config';
import { buildContext, ensureDaemon } from './client';

/**
 * rocky-todo 활성화 코어 — `todo_enable` 도구와 CLI `enable` 이 공유한다.
 *
 * user rocky.json 에 `todo.enabled=true` 를 병합 기록(기존 키 보존)하고 데몬을 기동한다.
 * launchd 상주 등록은 하지 않는다 (`rocky-todo daemon install` 로 분리 유지).
 */

/** user rocky.json 을 로드해 todo.enabled=true 를 병합 기록한다. 파싱 실패 시 덮지 않고 throw. */
export function writeEnabledFlag(configPath: string = USER_CONFIG_PATH): void {
  let root: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    const raw = readFileSync(configPath, 'utf8');
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed !== 'object' || parsed === null) {
        throw new Error('rocky.json 최상위가 객체가 아니다');
      }
      root = parsed as Record<string, unknown>;
    } catch (error) {
      throw new Error(
        `rocky.json 파싱 실패 (${configPath}) — 활성화를 중단한다: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const todo = (typeof root.todo === 'object' && root.todo !== null ? root.todo : {}) as Record<
    string,
    unknown
  >;
  todo.enabled = true;
  root.todo = todo;
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(root, null, 2)}\n`);
}

export interface EnableResult {
  ok: boolean;
  url: string;
  hint: string;
}

/** rocky.json 에 enabled 기록 후 데몬을 기동한다 (health 대기 포함). */
export async function enableTodo(opts: {
  port: number;
  dir: string;
  configPath?: string;
}): Promise<EnableResult> {
  writeEnabledFlag(opts.configPath ?? USER_CONFIG_PATH);
  const ctx = buildContext({ port: opts.port, dir: opts.dir, actor: 'rocky-todo' });
  await ensureDaemon(ctx);
  return {
    ok: true,
    url: ctx.baseUrl,
    hint: '재부팅 후에도 상시 기동하려면 rocky-todo daemon install',
  };
}
