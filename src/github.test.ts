import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createIssue,
  createIssueForTodo,
  findIssueLink,
  isRepoSlug,
  issueBody,
  issueNumberFrom,
  parseRepoFromRemote,
  type RunCommand,
} from './github';
import { TodoStore } from './store';

/** gh 를 부르지 않고 그 자리에 끼우는 fake — 호출 인자도 기록한다. */
function fakeRun(result: {
  code: number;
  stdout: string;
  stderr: string;
}): RunCommand & { calls: { cmd: readonly string[]; stdin: string }[] } {
  const calls: { cmd: readonly string[]; stdin: string }[] = [];
  const run = ((cmd: readonly string[], stdin: string) => {
    calls.push({ cmd, stdin });
    return result;
  }) as RunCommand & { calls: typeof calls };
  run.calls = calls;
  return run;
}

describe('parseRepoFromRemote', () => {
  test('reads the ssh form', () => {
    expect(parseRepoFromRemote('git@github.com:minjun0219/rocky-todo.git')).toBe(
      'minjun0219/rocky-todo',
    );
  });

  test('reads the https form, with or without .git', () => {
    expect(parseRepoFromRemote('https://github.com/minjun0219/rocky-todo.git')).toBe(
      'minjun0219/rocky-todo',
    );
    expect(parseRepoFromRemote('https://github.com/minjun0219/rocky-todo')).toBe(
      'minjun0219/rocky-todo',
    );
  });

  test('reads the ssh:// form and tolerates a trailing slash', () => {
    expect(parseRepoFromRemote('ssh://git@github.com/minjun0219/rocky-todo.git')).toBe(
      'minjun0219/rocky-todo',
    );
    expect(parseRepoFromRemote('https://github.com/minjun0219/rocky-todo/')).toBe(
      'minjun0219/rocky-todo',
    );
  });

  test('returns undefined for non-GitHub remotes and junk', () => {
    expect(parseRepoFromRemote('git@gitlab.com:acme/thing.git')).toBeUndefined();
    expect(parseRepoFromRemote('https://example.com/a/b')).toBeUndefined();
    expect(parseRepoFromRemote('')).toBeUndefined();
    expect(parseRepoFromRemote('https://github.com/onlyowner')).toBeUndefined();
  });

  test('a lookalike host is not GitHub', () => {
    expect(parseRepoFromRemote('https://evil.com//github.com/owner/repo')).toBeUndefined();
    expect(parseRepoFromRemote('git@evil.com@github.com:owner/repo.git')).toBeUndefined();
    expect(parseRepoFromRemote('https://github.com.evil.com/owner/repo')).toBeUndefined();
    expect(parseRepoFromRemote('https://notgithub.com/owner/repo')).toBeUndefined();
  });

  test('the scp-like form works with and without a user prefix', () => {
    expect(parseRepoFromRemote('github.com:owner/repo.git')).toBe('owner/repo');
    expect(parseRepoFromRemote('git@github.com:owner/repo')).toBe('owner/repo');
  });

  test('malformed input does not throw', () => {
    expect(parseRepoFromRemote('https://')).toBeUndefined();
    expect(parseRepoFromRemote('::::')).toBeUndefined();
  });
});

describe('isRepoSlug', () => {
  test('accepts owner/name', () => {
    expect(isRepoSlug('minjun0219/rocky-todo')).toBe(true);
    expect(isRepoSlug('a/b')).toBe(true);
    expect(isRepoSlug('with.dot/and_underscore')).toBe(true);
  });

  test('rejects anything else', () => {
    expect(isRepoSlug('rocky-todo')).toBe(false);
    expect(isRepoSlug('a/b/c')).toBe(false);
    expect(isRepoSlug('a /b')).toBe(false);
    expect(isRepoSlug('')).toBe(false);
    expect(isRepoSlug('/b')).toBe(false);
    expect(isRepoSlug('a/')).toBe(false);
  });
});

describe('findIssueLink', () => {
  test('finds a GitHub issue url among links', () => {
    expect(
      findIssueLink([
        { url: 'https://example.com/x' },
        { url: 'https://github.com/o/n/issues/12' },
      ]),
    ).toBe('https://github.com/o/n/issues/12');
  });

  test('a pull request url is not an issue link', () => {
    expect(findIssueLink([{ url: 'https://github.com/o/n/pull/12' }])).toBeUndefined();
  });

  test('no links means none', () => {
    expect(findIssueLink([])).toBeUndefined();
  });

  test('the issue number must end at a boundary', () => {
    expect(findIssueLink([{ url: 'https://github.com/o/n/issues/12abc' }])).toBeUndefined();
    expect(findIssueLink([{ url: 'https://github.com/o/n/issues/12/' }])).toBe(
      'https://github.com/o/n/issues/12/',
    );
    expect(findIssueLink([{ url: 'https://github.com/o/n/issues/12#comment' }])).toBe(
      'https://github.com/o/n/issues/12#comment',
    );
  });
});

describe('issueNumberFrom', () => {
  test('reads the trailing number', () => {
    expect(issueNumberFrom('https://github.com/o/n/issues/12')).toBe(12);
    expect(issueNumberFrom('https://github.com/o/n/issues/12\n')).toBe(12);
  });

  test('returns undefined when there is no number', () => {
    expect(issueNumberFrom('https://github.com/o/n/issues/')).toBeUndefined();
    expect(issueNumberFrom('nonsense')).toBeUndefined();
  });
});

describe('issueBody', () => {
  test('appends a back-reference after the description', () => {
    expect(issueBody('설명이다', 'rocky-todo#8')).toBe('설명이다\n\n— rocky-todo `rocky-todo#8`');
  });

  test('an empty description leaves only the back-reference', () => {
    expect(issueBody('', 'rocky-todo#8')).toBe('— rocky-todo `rocky-todo#8`');
  });
});

describe('createIssue', () => {
  test('passes the body on stdin and returns the url', () => {
    const run = fakeRun({ code: 0, stdout: 'https://github.com/o/n/issues/7\n', stderr: '' });
    const result = createIssue({ repo: 'o/n', title: '제목', body: '본문' }, run);

    expect(result).toEqual({ ok: true, url: 'https://github.com/o/n/issues/7' });
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]?.cmd).toEqual([
      'gh',
      'issue',
      'create',
      '-R',
      'o/n',
      '-t',
      '제목',
      '-F',
      '-',
    ]);
    expect(run.calls[0]?.stdin).toBe('본문');
  });

  test('reports a missing gh executable in a way a human can act on', () => {
    const run: RunCommand = () => {
      throw new Error('spawn gh ENOENT');
    };
    const result = createIssue({ repo: 'o/n', title: 't', body: 'b' }, run);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain('gh');
    expect(result.ok === false && result.message).toContain('cli.github.com');
  });

  test('surfaces an auth failure with the login hint', () => {
    const run = fakeRun({ code: 1, stdout: '', stderr: 'gh auth login required' });
    const result = createIssue({ repo: 'o/n', title: 't', body: 'b' }, run);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain('gh auth login');
  });

  test('does not mistake "Author" for an auth failure', () => {
    const run = fakeRun({ code: 1, stdout: '', stderr: 'Author field required' });
    const result = createIssue({ repo: 'o/n', title: 't', body: 'b' }, run);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).not.toContain('gh auth login');
  });

  test('surfaces any other failure verbatim', () => {
    const run = fakeRun({ code: 1, stdout: '', stderr: 'could not resolve to a Repository' });
    const result = createIssue({ repo: 'o/n', title: 't', body: 'b' }, run);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain('could not resolve to a Repository');
  });

  test('a zero exit with no url is still a failure', () => {
    const run = fakeRun({ code: 0, stdout: '\n', stderr: '' });
    const result = createIssue({ repo: 'o/n', title: 't', body: 'b' }, run);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain('URL');
  });

  test('finds the issue url even with a trailing warning after it', () => {
    const run = fakeRun({
      code: 0,
      stdout: 'https://github.com/o/n/issues/9\nwarning: something noisy\n',
      stderr: '',
    });
    const result = createIssue({ repo: 'o/n', title: 't', body: 'b' }, run);
    expect(result).toEqual({ ok: true, url: 'https://github.com/o/n/issues/9' });
  });
});

describe('createIssueForTodo', () => {
  let dir: string;
  let store: TodoStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rocky-todo-gh-'));
    store = new TodoStore({ dbPath: join(dir, 'todo.db') });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('creates the issue and appends the link to the todo', () => {
    store.ensureBoard('rocky', { actor: 'tester' });
    store.setBoardRepo('rocky', 'o/n', 'tester');
    const todo = store.createTodo({ board: 'rocky', title: '작업', description: '설명' }, 'tester');
    const run = fakeRun({ code: 0, stdout: 'https://github.com/o/n/issues/7\n', stderr: '' });

    const result = createIssueForTodo(store, todo.id, { actor: 'tester', run });

    expect(result.url).toBe('https://github.com/o/n/issues/7');
    expect(result.todo.links).toEqual([{ url: 'https://github.com/o/n/issues/7', title: '#7' }]);
    expect(store.getTodo(todo.id)?.links).toHaveLength(1);
    // 본문에 설명과 백링크가 함께 들어간다
    expect(run.calls[0]?.stdin).toContain('설명');
    expect(run.calls[0]?.stdin).toContain(`rocky#${todo.number}`);
  });

  test('refuses when the board has no repo', () => {
    store.ensureBoard('rocky', { actor: 'tester' });
    const todo = store.createTodo({ board: 'rocky', title: '작업' }, 'tester');
    const run = fakeRun({ code: 0, stdout: 'https://github.com/o/n/issues/7', stderr: '' });

    expect(() => createIssueForTodo(store, todo.id, { actor: 'tester', run })).toThrow(/repo/);
    expect(run.calls).toHaveLength(0);
  });

  test('refuses when the todo already has an issue link', () => {
    store.ensureBoard('rocky', { actor: 'tester' });
    store.setBoardRepo('rocky', 'o/n', 'tester');
    const todo = store.createTodo(
      { board: 'rocky', title: '작업', links: [{ url: 'https://github.com/o/n/issues/3' }] },
      'tester',
    );
    const run = fakeRun({ code: 0, stdout: 'https://github.com/o/n/issues/7', stderr: '' });

    expect(() => createIssueForTodo(store, todo.id, { actor: 'tester', run })).toThrow(/already/);
    expect(run.calls).toHaveLength(0);
  });

  test('a gh failure leaves the todo untouched', () => {
    store.ensureBoard('rocky', { actor: 'tester' });
    store.setBoardRepo('rocky', 'o/n', 'tester');
    const todo = store.createTodo({ board: 'rocky', title: '작업' }, 'tester');
    const run = fakeRun({ code: 1, stdout: '', stderr: 'could not resolve to a Repository' });

    expect(() => createIssueForTodo(store, todo.id, { actor: 'tester', run })).toThrow(
      /could not resolve/,
    );
    expect(store.getTodo(todo.id)?.links).toEqual([]);
  });

  test('an unknown todo throws not found', () => {
    expect(() => createIssueForTodo(store, 'nosuchid', { actor: 'tester' })).toThrow(/not found/);
  });
});
