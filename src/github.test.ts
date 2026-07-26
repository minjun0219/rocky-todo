import { describe, expect, test } from 'bun:test';
import {
  createIssue,
  findIssueLink,
  isRepoSlug,
  issueBody,
  issueNumberFrom,
  parseRepoFromRemote,
  type RunCommand,
} from './github';

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
  });
});
