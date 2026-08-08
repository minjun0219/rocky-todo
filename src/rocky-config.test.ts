import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTodoConfig } from './rocky-config';

function writeConfig(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'rocky-todo-cfg-'));
  const path = join(dir, 'rocky.json');
  writeFileSync(path, body);
  return path;
}

describe('loadTodoConfig', () => {
  test('없는 파일 → {} (fail-open)', () => {
    expect(loadTodoConfig(join(tmpdir(), 'no-such-rocky-config.json'))).toEqual({});
  });

  test('파싱 불가 JSON → {}', () => {
    expect(loadTodoConfig(writeConfig('{ not json'))).toEqual({});
  });

  test('최상위가 객체가 아니면 → {}', () => {
    expect(loadTodoConfig(writeConfig('"a string"'))).toEqual({});
  });

  test('todo 블록 없으면 → {}', () => {
    expect(loadTodoConfig(writeConfig('{ "soul": "rocky" }'))).toEqual({});
  });

  test('todo 가 객체가 아니면 → {}', () => {
    expect(loadTodoConfig(writeConfig('{ "todo": "on" }'))).toEqual({});
    expect(loadTodoConfig(writeConfig('{ "todo": ["lan"] }'))).toEqual({});
  });

  test('port / dir / expose / watch 를 읽는다', () => {
    const path = writeConfig(
      JSON.stringify({ todo: { port: 9000, dir: '~/todo', expose: ['lan'], watch: false } }),
    );
    expect(loadTodoConfig(path)).toEqual({
      todo: { port: 9000, dir: '~/todo', expose: ['lan'], watch: false },
    });
  });

  test('enabled 는 무시한다 (설치=활성화)', () => {
    const path = writeConfig(JSON.stringify({ todo: { enabled: true, port: 8636 } }));
    const result = loadTodoConfig(path);
    expect(result.todo).toEqual({ port: 8636 });
    expect(result.todo).not.toHaveProperty('enabled');
  });

  test('rocky 전용 키(openapi/seo/worklog/soul)는 파싱하지 않는다', () => {
    const path = writeConfig(
      JSON.stringify({ soul: 'rocky', worklog: { dir: 'x' }, todo: { port: 7000 } }),
    );
    expect(loadTodoConfig(path)).toEqual({ todo: { port: 7000 } });
  });

  test('잘못된 타입의 필드는 버린다 (port 문자열 등)', () => {
    const path = writeConfig(JSON.stringify({ todo: { port: '9000', dir: 123 } }));
    expect(loadTodoConfig(path)).toEqual({ todo: {} });
  });
});

describe('loadTodoConfig — statusline', () => {
  test('todo.statusline.template 을 읽는다', () => {
    const path = writeConfig(JSON.stringify({ todo: { statusline: { template: '[⏺{doing}]' } } }));
    expect(loadTodoConfig(path).todo?.statusline).toEqual({ template: '[⏺{doing}]' });
  });

  test('모양이 어긋나면 통째로 무시한다 — 다른 필드와 같은 fail-open 규칙', () => {
    expect(loadTodoConfig(writeConfig('{ "todo": { "statusline": "on" } }')).todo?.statusline).toBe(
      undefined,
    );
    expect(
      loadTodoConfig(writeConfig('{ "todo": { "statusline": { "template": 3 } } }')).todo
        ?.statusline,
    ).toBe(undefined);
  });
});
