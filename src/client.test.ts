import { describe, expect, test } from 'bun:test';
import { buildContext, daemonHealth, request, stopDaemon } from './client';

/** 지정한 (status, body) 를 /api/health 로 돌려주는 fetch 를 임시 설치하고 fn 을 실행한다. */
async function withHealthResponse(
  status: number,
  body: unknown,
  fn: () => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    if (String(url).endsWith('/api/health')) {
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
    }
    throw new Error('unexpected fetch');
  }) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

describe('client', () => {
  test('buildContext 는 baseUrl 을 포트로 조립한다', () => {
    const ctx = buildContext({ port: 8636, dir: '/tmp/x', actor: 'claude-code' });
    expect(ctx.baseUrl).toBe('http://127.0.0.1:8636');
    expect(ctx.actor).toBe('claude-code');
  });

  test('daemonHealth 는 rocky-todo 데몬 응답을 본문째 돌려준다', async () => {
    await withHealthResponse(
      200,
      { ok: true, name: 'rocky-todo', version: '1.2.3', pid: 42 },
      async () => {
        const h = await daemonHealth('http://127.0.0.1:8636');
        expect(h?.version).toBe('1.2.3');
        expect(h?.pid).toBe(42);
      },
    );
  });

  test('daemonHealth 는 name 이 다른 (무관한) 서비스를 데몬으로 취급하지 않는다', async () => {
    // 포트를 가로챈 남의 서비스가 2xx JSON + pid 를 줘도 null — 그 pid 에 SIGTERM 이 가면 안 된다.
    await withHealthResponse(200, { ok: true, name: 'some-other-service', pid: 9999 }, async () => {
      expect(await daemonHealth('http://127.0.0.1:8636')).toBeNull();
    });
  });

  test('daemonHealth 는 ok 가 true 가 아니면 null', async () => {
    await withHealthResponse(200, { ok: false, name: 'rocky-todo' }, async () => {
      expect(await daemonHealth('http://127.0.0.1:8636')).toBeNull();
    });
  });

  test('daemonHealth 는 비-JSON 응답에 null (throw 하지 않는다)', async () => {
    await withHealthResponse(200, 'not json', async () => {
      expect(await daemonHealth('http://127.0.0.1:8636')).toBeNull();
    });
  });

  test('stopDaemon 은 이미 죽은 pid 여도 포트가 풀렸으면 성공으로 본다', async () => {
    // health 확인 직후 데몬이 죽는 레이스 — SIGTERM 은 ESRCH 로 실패하지만 목적(종료)은
    // 달성된 상태다. 여기서 false 를 돌려주면 훅이 재기동을 건너뛰어 데몬 없는 세션이 된다.
    const proc = Bun.spawn({
      cmd: [process.execPath, '-e', 'setTimeout(() => {}, 60000)'],
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    const deadPid = proc.pid;
    proc.kill();
    await proc.exited;

    const ctx = buildContext({ port: 8636, dir: '/tmp/rocky-todo-absent', actor: 'test' });
    await withHealthResponse(503, {}, async () => {
      expect(await stopDaemon(ctx, deadPid)).toBe(true);
    });
  });

  test('request 는 x-rocky-actor 헤더를 붙이고 JSON 을 파싱한다', async () => {
    const seen: { headers?: Headers; body?: string } = {};
    const originalFetch = globalThis.fetch;
    // 데몬이 이미 떠 있다고 보이도록 health + 실제 요청을 fake
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/api/health')) {
        return new Response(JSON.stringify({ ok: true, name: 'rocky-todo' }), { status: 200 });
      }
      seen.headers = new Headers(init?.headers);
      seen.body = init?.body as string | undefined;
      return new Response(JSON.stringify({ id: 'abc123' }), { status: 200 });
    }) as typeof fetch;
    try {
      const ctx = buildContext({ port: 8636, dir: '/tmp/x', actor: 'claude-code' });
      const result = await request<{ id: string }>(ctx, 'POST', '/api/todos', { title: 't' });
      expect(result.id).toBe('abc123');
      expect(seen.headers?.get('x-rocky-actor')).toBe('claude-code');
      expect(seen.body).toBe(JSON.stringify({ title: 't' }));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('request 는 non-ok 응답의 error 필드를 throw 한다', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      if (String(url).endsWith('/api/health')) {
        return new Response(JSON.stringify({ ok: true, name: 'rocky-todo' }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'boom' }), { status: 400 });
    }) as typeof fetch;
    try {
      const ctx = buildContext({ port: 8636, dir: '/tmp/x', actor: 'x' });
      await expect(request(ctx, 'GET', '/api/todos')).rejects.toThrow('boom');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
