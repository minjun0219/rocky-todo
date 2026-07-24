import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { writeEnabledFlag } from './enable';

describe('writeEnabledFlag', () => {
  test('기존 파일의 다른 키를 보존하며 todo.enabled=true 를 병합한다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rocky-enable-'));
    const path = join(dir, 'rocky.json');
    writeFileSync(path, JSON.stringify({ soul: 'rocky', callsign: 'Logan', todo: { port: 9000 } }));
    writeEnabledFlag(path);
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    expect(parsed.soul).toBe('rocky');
    expect(parsed.callsign).toBe('Logan');
    expect(parsed.todo.port).toBe(9000);
    expect(parsed.todo.enabled).toBe(true);
  });

  test('파일이 없으면 새로 만든다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rocky-enable-'));
    const path = join(dir, 'rocky.json');
    writeEnabledFlag(path);
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    expect(parsed.todo.enabled).toBe(true);
  });

  test('파싱 불가한 파일은 덮지 않고 throw 한다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rocky-enable-'));
    const path = join(dir, 'rocky.json');
    writeFileSync(path, '{ not valid json');
    expect(() => writeEnabledFlag(path)).toThrow();
    // 원본 보존 확인
    expect(readFileSync(path, 'utf8')).toBe('{ not valid json');
  });
});
