import { describe, expect, test } from 'bun:test';
import { boardKeyFrom, detectActor } from './actor';

describe('detectActor', () => {
  test('explicit env override wins', () => {
    expect(detectActor({ ROCKY_TODO_ACTOR: 'rocky', CLAUDECODE: '1' })).toBe('rocky');
  });

  test('host markers are detected in order', () => {
    expect(detectActor({ CLAUDECODE: '1' })).toBe('claude-code');
    expect(detectActor({ OPENCODE: '1' })).toBe('opencode');
    expect(detectActor({ CODEX_SANDBOX: 'seatbelt' })).toBe('codex');
  });

  test('falls back to agent when nothing matches', () => {
    expect(detectActor({})).toBe('agent');
  });
});

describe('boardKeyFrom', () => {
  test('prefers git remote basename over toplevel and cwd', () => {
    expect(
      boardKeyFrom({
        remoteUrl: 'git@github.com:minjun0219/rocky.git',
        toplevel: '/Users/x/worktrees/todo',
        cwd: '/Users/x/worktrees/todo/src',
      }),
    ).toBe('rocky');
    expect(boardKeyFrom({ remoteUrl: 'https://github.com/minjun0219/my-app.git' })).toBe('my-app');
  });

  test('falls back to toplevel basename, then cwd basename', () => {
    expect(boardKeyFrom({ toplevel: '/Users/x/dev/proj', cwd: '/Users/x/dev/proj/deep' })).toBe(
      'proj',
    );
    expect(boardKeyFrom({ cwd: '/Users/x/scratch dir' })).toBe('scratch-dir');
  });

  test('sanitizes to url-safe key and never returns empty', () => {
    expect(boardKeyFrom({ cwd: '/' })).toBe('board');
    expect(boardKeyFrom({ remoteUrl: 'git@github.com:a/한글레포.git' })).toBe('board');
  });
});
