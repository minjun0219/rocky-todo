import { describe, expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_TODO_DIR, DEFAULT_TODO_PORT, resolveTodoRuntimeConfig } from './config';
import { DEFAULT_STATUSLINE_TEMPLATE } from './statusline';

describe('resolveTodoRuntimeConfig', () => {
  test('defaults when nothing is set', () => {
    const resolved = resolveTodoRuntimeConfig({});
    expect(resolved.port).toBe(DEFAULT_TODO_PORT);
    expect(resolved.dir).toBe(DEFAULT_TODO_DIR);
  });

  test('rocky.json todo block overrides defaults', () => {
    const resolved = resolveTodoRuntimeConfig({}, { port: 9000, dir: '/data/todo' });
    expect(resolved.port).toBe(9000);
    expect(resolved.dir).toBe('/data/todo');
  });

  test('env wins over config, tilde is expanded', () => {
    const resolved = resolveTodoRuntimeConfig(
      { ROCKY_TODO_PORT: '9999', ROCKY_TODO_DIR: '~/custom' },
      { port: 9000, dir: '/data/todo' },
    );
    expect(resolved.port).toBe(9999);
    expect(resolved.dir).toBe(join(homedir(), 'custom'));
  });

  test('invalid env port falls through to config/default', () => {
    expect(resolveTodoRuntimeConfig({ ROCKY_TODO_PORT: 'abc' }).port).toBe(DEFAULT_TODO_PORT);
    expect(resolveTodoRuntimeConfig({ ROCKY_TODO_PORT: '-1' }, { port: 9000 }).port).toBe(9000);
  });

  test('expose defaults to empty (loopback bind, no channels)', () => {
    const resolved = resolveTodoRuntimeConfig({});
    expect(resolved.expose).toEqual([]);
    expect(resolved.host).toBe('127.0.0.1');
  });

  test('lan channel binds all interfaces; tailscale alone keeps loopback; both combine', () => {
    const lan = resolveTodoRuntimeConfig({}, { expose: ['lan'] });
    expect(lan.host).toBe('0.0.0.0');

    const ts = resolveTodoRuntimeConfig({}, { expose: ['tailscale-serve'] });
    expect(ts.expose).toEqual(['tailscale-serve']);
    expect(ts.host).toBe('127.0.0.1');

    const both = resolveTodoRuntimeConfig({}, { expose: ['lan', 'tailscale-serve'] });
    expect(both.expose).toEqual(['lan', 'tailscale-serve']);
    expect(both.host).toBe('0.0.0.0');

    // 문자열 하나도 배열로 정규화
    const single = resolveTodoRuntimeConfig({}, { expose: 'lan' });
    expect(single.expose).toEqual(['lan']);
    expect(single.host).toBe('0.0.0.0');

    // "off" / null 은 미설정과 동일
    expect(resolveTodoRuntimeConfig({}, { expose: 'off' }).expose).toEqual([]);
    expect(resolveTodoRuntimeConfig({}, { expose: null }).expose).toEqual([]);
  });

  test('env ROCKY_TODO_EXPOSE is comma-separated and wins entirely when set', () => {
    expect(resolveTodoRuntimeConfig({ ROCKY_TODO_EXPOSE: 'lan,tailscale-serve' }).expose).toEqual([
      'lan',
      'tailscale-serve',
    ]);
    // env 가 설정돼 있으면 config 보다 무조건 우선 — "off" 로 강제 차단 가능
    expect(
      resolveTodoRuntimeConfig({ ROCKY_TODO_EXPOSE: 'off' }, { expose: ['lan'] }).expose,
    ).toEqual([]);
    expect(
      resolveTodoRuntimeConfig({ ROCKY_TODO_EXPOSE: 'banana' }, { expose: ['lan'] }).expose,
    ).toEqual([]);
  });
});

describe('resolveTodoRuntimeConfig — statuslineTemplate', () => {
  test('설정이 없으면 기본 템플릿', () => {
    expect(resolveTodoRuntimeConfig({}, {}).statuslineTemplate).toBe(DEFAULT_STATUSLINE_TEMPLATE);
  });

  test('config > 기본', () => {
    const config = { statusline: { template: '[{doing}]' } };
    expect(resolveTodoRuntimeConfig({}, config).statuslineTemplate).toBe('[{doing}]');
  });

  test('env > config', () => {
    const config = { statusline: { template: '[{doing}]' } };
    const env = { ROCKY_TODO_STATUSLINE: '[{stale}]' };
    expect(resolveTodoRuntimeConfig(env, config).statuslineTemplate).toBe('[{stale}]');
  });

  test('빈 문자열은 오설정으로 보고 기본값으로 떨어진다', () => {
    // 끄고 싶으면 statusline 명령에서 curl 을 빼면 된다 — 여기서 빈 값을 통과시키면
    // 왜 아무것도 안 뜨는지 알아낼 방법이 없다.
    const env = { ROCKY_TODO_STATUSLINE: '   ' };
    expect(resolveTodoRuntimeConfig(env, { statusline: { template: '' } }).statuslineTemplate).toBe(
      DEFAULT_STATUSLINE_TEMPLATE,
    );
  });
});
