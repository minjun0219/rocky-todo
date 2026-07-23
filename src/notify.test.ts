import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildNotifyContext, filterHumanChanges, readCursor, writeCursor } from './notify';
import type { ChangeFeedEntry } from './store';

function entry(partial: Partial<ChangeFeedEntry>): ChangeFeedEntry {
  return {
    id: 1,
    entity: 'todo',
    entityId: 'abcd1234',
    actor: 'logan',
    action: 'update',
    at: '2026-07-23T10:00:00.000Z',
    title: '제목',
    boardKey: 'rocky',
    ...partial,
  };
}

describe('filterHumanChanges', () => {
  test('drops agent actors, keeps human actors', () => {
    const entries = [
      entry({ id: 1, actor: 'claude-code' }),
      entry({ id: 2, actor: 'logan' }),
      entry({ id: 3, actor: 'codex' }),
      entry({ id: 4, actor: 'web' }),
    ];
    expect(filterHumanChanges(entries).map((e) => e.id)).toEqual([2, 4]);
  });
});

describe('buildNotifyContext', () => {
  test('null when no entries', () => {
    expect(buildNotifyContext([])).toBeNull();
  });

  test('formats compact korean lines with board, action, and diff', () => {
    const context = buildNotifyContext([
      entry({ action: 'update', changes: { title: ['a', 'b'] } }),
      entry({ id: 2, entity: 'note', action: 'create', title: '메모', boardKey: undefined }),
      entry({ id: 3, action: 'done', title: '끝난 일' }),
    ]);
    expect(context).toContain('rocky-todo');
    expect(context).toContain('[rocky]');
    expect(context).toContain('logan');
    expect(context).toContain('제목');
    expect(context).toContain('title: a → b');
    expect(context).toContain('메모');
    expect(context).toContain('완료');
  });
});

describe('cursor store', () => {
  test('read missing → undefined; write then read round-trips', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rocky-todo-cursor-'));
    const file = join(dir, 'hook-cursors.json');
    try {
      expect(readCursor(file, 'sess-1')).toBeUndefined();
      writeCursor(file, 'sess-1', 42);
      expect(readCursor(file, 'sess-1')).toBe(42);
      writeCursor(file, 'sess-1', 50);
      expect(readCursor(file, 'sess-1')).toBe(50);
      expect(readCursor(file, 'sess-2')).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('prunes to the most recent 100 sessions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rocky-todo-cursor-'));
    const file = join(dir, 'hook-cursors.json');
    try {
      for (let i = 0; i < 120; i++) {
        writeCursor(file, `sess-${i}`, i);
      }
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      expect(Object.keys(raw).length).toBeLessThanOrEqual(100);
      expect(readCursor(file, 'sess-119')).toBe(119);
      expect(readCursor(file, 'sess-0')).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('corrupt cursor file is treated as empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rocky-todo-cursor-'));
    const file = join(dir, 'hook-cursors.json');
    try {
      writeCursor(file, 'a', 1);
      require('node:fs').writeFileSync(file, '{broken');
      expect(readCursor(file, 'a')).toBeUndefined();
      writeCursor(file, 'a', 2);
      expect(readCursor(file, 'a')).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
