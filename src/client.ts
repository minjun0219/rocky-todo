import { join } from 'node:path';

/**
 * rocky-todo 데몬의 얇은 REST 클라이언트 — CLI 와 stdio MCP 브릿지가 공유한다.
 *
 * 데몬이 죽어 있으면 `ensureDaemon` 이 detached spawn 후 health 가 응답할 때까지
 * (최대 ~5s) 기다린다. 모든 요청에 `x-rocky-actor` 헤더를 붙여 히스토리에 남긴다.
 */

export interface CliContext {
  baseUrl: string;
  port: number;
  dir: string;
  actor: string;
}

/** port/dir/actor 로 CliContext 를 조립한다 (baseUrl 은 127.0.0.1 루프백). */
export function buildContext(opts: { port: number; dir: string; actor: string }): CliContext {
  return {
    baseUrl: `http://127.0.0.1:${opts.port}`,
    port: opts.port,
    dir: opts.dir,
    actor: opts.actor,
  };
}

export async function health(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(700) });
    return res.ok;
  } catch {
    return false;
  }
}

/** 데몬이 안 떠 있으면 detached spawn 하고 health 가 응답할 때까지 (최대 ~5s) 기다린다. */
export async function ensureDaemon(ctx: CliContext): Promise<void> {
  if (await health(ctx.baseUrl)) {
    return;
  }
  const daemonPath = join(import.meta.dir, 'daemon.ts');
  Bun.spawn({
    cmd: [process.execPath, 'run', daemonPath],
    stdio: ['ignore', 'ignore', 'ignore'],
    env: process.env,
  }).unref();
  for (let i = 0; i < 25; i++) {
    await Bun.sleep(200);
    if (await health(ctx.baseUrl)) {
      return;
    }
  }
  throw new Error(
    `rocky-todo daemon did not start on port ${ctx.port} — check \`rocky-todo daemon status\``,
  );
}

export async function request<T>(
  ctx: CliContext,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  await ensureDaemon(ctx);
  const res = await fetch(`${ctx.baseUrl}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      'x-rocky-actor': ctx.actor,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const payload = (await res.json()) as T & { error?: string };
  if (!res.ok) {
    throw new Error(payload.error ?? `${res.status} ${res.statusText}`);
  }
  return payload;
}
