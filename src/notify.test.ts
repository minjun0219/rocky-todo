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

describe('comment lines', () => {
  test('renders a comment with its body instead of a field diff', () => {
    const context = buildNotifyContext([
      entry({
        action: 'comment',
        changes: { comment: [null, '이거 SSE 로도 흘러가나?'] },
        title: '댓글 기능 추가',
      }),
    ]);
    expect(context).toContain('"댓글 기능 추가" 댓글 · "이거 SSE 로도 흘러가나?"');
    expect(context).not.toContain('comment:');
  });

  test('renders an edited comment with the new body', () => {
    const context = buildNotifyContext([
      entry({ action: 'comment-edit', changes: { comment: ['오타', '고침'] } }),
    ]);
    expect(context).toContain('댓글 수정 · "고침"');
  });

  test('folds newlines and truncates a long body', () => {
    const body = `${'가'.repeat(250)}\n둘째 줄`;
    const context = buildNotifyContext([
      entry({ action: 'comment', changes: { comment: [null, body] } }),
    ]);
    expect(context).toContain('…');
    expect(context).not.toContain('\n둘째 줄');
    const line = (context ?? '').split('\n').find((l) => l.includes('댓글')) ?? '';
    expect(line.length).toBeLessThan(300);
  });

  test('agent comments are filtered out before formatting', () => {
    const entries = [
      entry({ id: 1, actor: 'claude-code', action: 'comment', changes: { comment: [null, '봇'] } }),
      entry({ id: 2, actor: 'logan', action: 'comment', changes: { comment: [null, '사람'] } }),
    ];
    const context = buildNotifyContext(filterHumanChanges(entries));
    expect(context).toContain('"사람"');
    expect(context).not.toContain('"봇"');
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

      // 개수만 보면 "어느 100개가 남았는지"를 놓친다 — `at` 이 밀리초라 세션들이 같은
      // 값을 갖기 쉽고, 그때 잘려나가는 구간이 오래된 쪽이 아니라 임의의 밴드가 되던
      // 버그가 있었다(0–11 과 16–23 이 빠지고 12–15 는 남았다). 남은 집합이 정확히
      // 최신 100개인지까지 못 박는다 — 이 단정이 없어서 위 두 줄만으로는 실행마다
      // 통과/실패가 갈렸다.
      const survivors = Array.from({ length: 120 }, (_, i) => i).filter((i) => `sess-${i}` in raw);
      expect(survivors).toEqual(Array.from({ length: 100 }, (_, i) => i + 20));
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
