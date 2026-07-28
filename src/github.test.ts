import { Database } from 'bun:sqlite';
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

  // `\bauth\b` 하나로는 실제로 마주치는 문구 대부분을 놓친다 — gh/GitHub 은 상황마다
  // 다른 말을 쓴다. 놓치면 사용자는 원인 모를 실패 문구만 보고 `gh auth login` 에 도달하지 못한다.
  test.each([
    'authentication required',
    'HTTP 401: Unauthorized (https://api.github.com/graphql)',
    'error: Bad credentials',
    'To get started with GitHub CLI, please run: gh auth login',
    'error: not logged in to any GitHub hosts',
  ])('attaches the login hint to %p', (stderr) => {
    const run = fakeRun({ code: 1, stdout: '', stderr });
    const result = createIssue({ repo: 'o/n', title: 't', body: 'b' }, run);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain('gh auth login');
  });

  // 반대로 넓히기만 하면 `auth` 를 품은 무관한 단어가 걸린다 — 이슈 생성 오류에 흔하다.
  test.each([
    'Author field required',
    'could not assign author: not a collaborator',
    'authored by someone else',
  ])('does not mistake %p for an auth failure', (stderr) => {
    const run = fakeRun({ code: 1, stdout: '', stderr });
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
    expect(run.calls[0]?.stdin).toContain(`rocky-${todo.number}`);
  });

  // refOf 가 board 참조를 만든다 — 공백이 섞인 legacy board key(`ensureBoard` 를 거치지
  // 않은 구버전 데이터, seedLegacyBoard 로 재현)는 `isRefSafeBoardKey` 를 통과하지 못해
  // `<key>#<number>`/`<key>-<number>` 대신 todo 의 raw id 로 폴백한다. 손으로 문자열을
  // 이어붙이면(예전 코드) `my repo#1` 처럼 resolveRef 가 되읽지 못하는 참조가 이슈 본문에
  // 영구히 남는다 — 이 테스트는 그 회귀를 막는다.
  test('legacy board key 에 공백이 있으면 이슈 본문은 raw id 로 폴백한다', () => {
    const raw = new Database(join(dir, 'todo.db'));
    raw
      .query('INSERT INTO boards (id, key, title, created_at) VALUES (?, ?, ?, ?)')
      .run('legacy-space-board', 'my repo', 'my repo', new Date().toISOString());
    raw.close();
    store.setBoardRepo('my repo', 'o/n', 'tester');
    const todo = store.createTodo({ board: 'my repo', title: '작업' }, 'tester');
    const run = fakeRun({ code: 0, stdout: 'https://github.com/o/n/issues/7\n', stderr: '' });

    createIssueForTodo(store, todo.id, { actor: 'tester', run });

    expect(run.calls[0]?.stdin).toContain(todo.id);
    expect(run.calls[0]?.stdin).not.toContain('my repo#1');
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

  // finding A/C: 서버가 client 대신 어느 보드에 repo 를 저장할지 정한다 — `options.repo`
  // 가 그 경로다. 세 시나리오가 회귀를 지킨다: 보드에 repo 가 없을 때 채워짐, `gh` 실패
  // 시 절대 채워지지 않음(finding C 의 근본 원인), 이미 다른 repo 가 있어도 이번 호출은
  // 넘긴 값으로 실행되고 성공하면 그 값이 남는다.
  test('options.repo fills in a repo-less board on success', () => {
    store.ensureBoard('rocky', { actor: 'tester' });
    const todo = store.createTodo({ board: 'rocky', title: '작업' }, 'tester');
    const run = fakeRun({ code: 0, stdout: 'https://github.com/o/n/issues/7\n', stderr: '' });

    const result = createIssueForTodo(store, todo.id, { actor: 'tester', run, repo: 'o/n' });

    expect(result.url).toBe('https://github.com/o/n/issues/7');
    expect(store.boardById(todo.boardId)?.repo).toBe('o/n');
  });

  test('options.repo is never persisted when gh fails (root cause of finding C)', () => {
    store.ensureBoard('rocky', { actor: 'tester' });
    const todo = store.createTodo({ board: 'rocky', title: '작업' }, 'tester');
    const run = fakeRun({ code: 1, stdout: '', stderr: 'could not resolve to a Repository' });

    expect(() =>
      createIssueForTodo(store, todo.id, { actor: 'tester', run, repo: 'wrong/slug' }),
    ).toThrow(/could not resolve/);
    expect(store.boardById(todo.boardId)?.repo).toBeUndefined();
  });

  test('options.repo overrides an already-set board repo for this call and persists on success', () => {
    store.ensureBoard('rocky', { actor: 'tester' });
    store.setBoardRepo('rocky', 'old/repo', 'tester');
    const todo = store.createTodo({ board: 'rocky', title: '작업' }, 'tester');
    const run = fakeRun({ code: 0, stdout: 'https://github.com/new/repo/issues/1\n', stderr: '' });

    const result = createIssueForTodo(store, todo.id, {
      actor: 'tester',
      run,
      repo: 'new/repo',
    });

    expect(result.url).toBe('https://github.com/new/repo/issues/1');
    expect(run.calls[0]?.cmd).toEqual([
      'gh',
      'issue',
      'create',
      '-R',
      'new/repo',
      '-t',
      '작업',
      '-F',
      '-',
    ]);
    expect(store.boardById(todo.boardId)?.repo).toBe('new/repo');
  });
});
