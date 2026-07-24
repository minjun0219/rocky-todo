import { describe, expect, test } from 'bun:test';
import { buildContext, request } from './client';

describe('client', () => {
  test('buildContext 는 baseUrl 을 포트로 조립한다', () => {
    const ctx = buildContext({ port: 8636, dir: '/tmp/x', actor: 'claude-code' });
    expect(ctx.baseUrl).toBe('http://127.0.0.1:8636');
    expect(ctx.actor).toBe('claude-code');
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
