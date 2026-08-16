import { readFileSync } from 'node:fs';
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

/** `/api/health` 응답 — version/pid 는 0.2.0 이전 데몬에는 없다. */
export interface DaemonHealth {
  ok: boolean;
  name?: string;
  version?: string;
  pid?: number;
  /**
   * 이 요청과 같은 출처에서 GitHub 이슈를 만들 수 있는지 — 웹 UI 가 누를 수 없는 버튼을
   * 그리지 않기 위한 힌트다(강제는 이슈 라우트가 403 으로 한다). 이 필드가 없는 데몬에는
   * 애초에 그 가드가 없다.
   */
  issueCreateAllowed?: boolean;
}

/**
 * 데몬 health 를 본문째 돌려준다 — 호출자가 실행 중인 코드의 버전/pid 를 볼 수 있다.
 *
 * **신원 검증**: 설정된 포트에 rocky-todo 가 아닌 서비스가 떠 2xx JSON 을 돌려줄 수
 * 있으므로 `ok === true` 와 `name === 'rocky-todo'` 를 확인한 응답만 데몬으로 인정한다.
 * (version/pid 는 ≤0.1.0 데몬엔 없어 stale 판별의 근거라 검증 대상이 아니다.) 이 가드가
 * 없으면 호출자가 무관한 프로세스의 pid 에 SIGTERM 을 보낼 수 있다.
 * @returns 응답이 없거나, 비정상이거나, rocky-todo 데몬이 아니면 null.
 */
export async function daemonHealth(baseUrl: string): Promise<DaemonHealth | null> {
  try {
    const res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(700) });
    if (!res.ok) {
      return null;
    }
    const body = (await res.json()) as DaemonHealth;
    if (body?.ok !== true || body.name !== 'rocky-todo') {
      return null;
    }
    return body;
  } catch {
    return null;
  }
}

export async function health(baseUrl: string): Promise<boolean> {
  return (await daemonHealth(baseUrl)) !== null;
}

/**
 * 실행 중인 데몬에 SIGTERM 을 보내고 포트가 풀릴 때까지 (최대 ~3s) 기다린다.
 * @param pid health 가 보고한 pid. 없으면 `daemon.pid` 파일로 폴백한다.
 * @returns 종료가 확인되면 true. pid 를 못 찾거나 시간 안에 안 죽으면 false.
 */
export async function stopDaemon(ctx: CliContext, pid?: number): Promise<boolean> {
  const target = pid ?? readPidFile(ctx.dir);
  if (target === undefined) {
    return false;
  }
  try {
    process.kill(target, 'SIGTERM');
  } catch {
    // ESRCH(이미 죽음)와 EPERM(남의 프로세스)을 errno 로 나누지 않고 포트로 판정한다 —
    // 이미 죽었다면 목적은 달성된 것이고(health 확인 직후 죽는 레이스), 남의 프로세스면
    // health 가 계속 응답하므로 자연히 false 가 된다.
    return (await daemonHealth(ctx.baseUrl)) === null;
  }
  for (let i = 0; i < 15; i++) {
    await Bun.sleep(200);
    if ((await daemonHealth(ctx.baseUrl)) === null) {
      return true;
    }
  }
  return false;
}

function readPidFile(dir: string): number | undefined {
  try {
    const pid = Number(readFileSync(join(dir, 'daemon.pid'), 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
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
    // 레포 루트 고정 — bunfig.toml(Tailwind serve 플러그인)은 프로세스 시작 시점의
    // cwd 에서 읽힌다. 호출자 cwd 를 상속시키면 CSS 가 Tailwind 처리 없이 나간다.
    cwd: join(import.meta.dir, '..'),
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
