# todo → GitHub 이슈 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** todo 하나를 버튼(또는 명령) 한 번으로 GitHub 이슈로 만들고, 생성된 이슈 URL 이 그 todo 의 `links` 에 자동으로 붙게 한다.

**Architecture:** 토큰을 저장하지 않고 `gh` CLI 를 실행해 사용자 인증을 빌린다(`src/tailscale.ts` 가 이미 쓰는 패턴). 보드가 레포를 모르므로 `boards` 에 `repo` 컬럼을 더한다(진짜 마이그레이션). 외부 명령 실행은 `RunCommand` 로 주입 가능하게 두어 **`gh` 가 없는 머신에서도 전 테스트가 통과**한다.

**Tech Stack:** Bun + TypeScript(ESM) · `bun:sqlite` · `bun:test` · React 19 + zustand(웹 UI) · `@modelcontextprotocol/sdk` · Biome. 새 의존성 없음.

## Global Constraints

- 설계 문서: `docs/superpowers/specs/2026-07-26-github-issue-design.md` (승인됨). 이탈 시 문서를 먼저 고친다.
- import 는 전부 상대경로, 확장자 없음(`@modelcontextprotocol/sdk/...js` 는 예외). `__dirname` 금지 — `import.meta.dir`/`import.meta.url`.
- **새 런타임 의존성 추가 금지.** 테스트용 dep 도 금지 — 이 레포에는 React 컴포넌트 테스트 하네스가 없다.
- **삭제는 없다** — 아카이브만 존재한다.
- **MCP 도구는 정확히 5개를 유지한다** (`todo_list` / `todo_write` / `todo_status` / `note_list` / `note_write`).
- exported 함수/클래스/타입에 JSDoc. 한국어 주석 OK, 코드 식별자·경로·명령·URL 은 영어 원형.
- 게이트: `bun run check` · `bun run typecheck` · `bun test` 세 개가 모두 통과해야 태스크 완료다.
- **`gh` 가 설치되지 않은 머신에서도 `bun test` 가 전부 통과해야 한다** — 외부 명령은 반드시 주입된 fake 를 거친다.
- 커밋 메시지는 Conventional Commits + 한국어 요약.
- 작업 브랜치는 `feat/github-issue` (main 기반, 이미 생성됨).
- 역방향 동기화(이슈 닫힘 → todo 완료)는 범위 밖이다.

## File Structure

| 파일 | 역할 | 태스크 |
| --- | --- | --- |
| `src/github.ts` | **신규.** GitHub 연동의 단일 소유자 — remote URL 파싱, repo slug 검증, 이슈 링크 판별, `gh` 실행, todo→이슈 오케스트레이션 | 1, 3 |
| `src/github.test.ts` | **신규.** 순수 함수 + 주입된 fake `run` 으로 `gh` 경로 검증 | 1, 3 |
| `src/migrations.ts` | `boards.repo` 마이그레이션 | 2 |
| `src/migrations.test.ts` | 마이그레이션이 기존 행을 보존하는지 | 2 |
| `src/store.ts` | `Board.repo` + `boardById` + `setBoardRepo` | 2 |
| `src/store.test.ts` | 스토어 계약 | 2 |
| `src/server.ts` | 라우트 2개 + `RunCommand` 주입 | 3 |
| `src/server.test.ts` | 라우트 계약 | 3 |
| `src/mcp.ts` | `todo_write.createIssue` + `RunCommand` 주입 | 4 |
| `src/mcp.test.ts` | MCP 계약 | 4 |
| `src/cli.ts` | `issue` / `board repo` 명령 | 5 |
| `src/cli.test.ts` | CLI 계약 | 5 |
| `src/ui/store.ts` · `src/ui/components/DetailDrawer.tsx` · `src/ui/styles.css` | 웹 UI 버튼 + repo 입력 | 6 |
| `FEATURES.md` · `AGENTS.md` · `docs/rocky-todo.md` · `README.md` | 문서 동기화 | 7 |

**Task 6 에는 자동 테스트가 없다** — React 컴포넌트 테스트 하네스가 없고 테스트용 dep 추가는 금지다. 게이트 + 격리 데몬 런타임 확인 + 브라우저 육안 확인으로 검증한다.

---

### Task 1: `src/github.ts` — 순수 함수와 `gh` 실행

**Files:**
- Create: `src/github.ts`
- Test: `src/github.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces:
  - `export interface RunCommand { (cmd: readonly string[], stdin: string): { code: number; stdout: string; stderr: string } }`
  - `export function parseRepoFromRemote(url: string): string | undefined`
  - `export function isRepoSlug(value: string): boolean`
  - `export function findIssueLink(links: readonly { url: string }[]): string | undefined`
  - `export function issueNumberFrom(url: string): number | undefined`
  - `export function issueBody(description: string, ref: string): string`
  - `export function createIssue(input: { repo: string; title: string; body: string }, run?: RunCommand): { ok: true; url: string } | { ok: false; message: string }`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src/github.test.ts` 를 새로 만든다:

```ts
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
function fakeRun(
  result: { code: number; stdout: string; stderr: string },
): RunCommand & { calls: { cmd: readonly string[]; stdin: string }[] } {
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
    expect(run.calls[0]?.cmd).toEqual(['gh', 'issue', 'create', '-R', 'o/n', '-t', '제목', '-F', '-']);
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
```

- [ ] **Step 2: 실패를 확인한다**

Run: `bun test src/github.test.ts`
Expected: FAIL — `Cannot find module './github'`

- [ ] **Step 3: 구현한다**

`src/github.ts` 를 새로 만든다:

```ts
/**
 * GitHub 연동 — todo 를 이슈로 올리는 경로의 단일 소유자.
 *
 * 토큰을 저장하지 않는다. 데몬은 사용자 프로세스로 도니 `gh` CLI 를 실행하면 사용자의
 * 인증을 그대로 빌릴 수 있다 — `src/tailscale.ts` 가 tailscale 에 대해 쓰는 것과 같은 형태다.
 *
 * 외부 명령 실행은 `RunCommand` 로 주입 가능하다. 테스트가 fake 를 넣기 위해서이고,
 * 그래서 `gh` 가 설치되지 않은 머신에서도 이 파일의 테스트가 전부 돈다.
 */

/** 외부 명령 한 번 실행. stdin 을 넘기고 종료 코드/출력을 돌려준다. */
export interface RunCommand {
  (cmd: readonly string[], stdin: string): { code: number; stdout: string; stderr: string };
}

/** 기본 실행자 — Bun.spawnSync. 배열을 넘기므로 셸이 개입하지 않는다(주입 없음). */
const defaultRun: RunCommand = (cmd, stdin) => {
  const proc = Bun.spawnSync({
    cmd: [...cmd],
    stdin: new TextEncoder().encode(stdin),
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 30_000,
  });
  return {
    code: proc.exitCode ?? 1,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
};

/** `owner/name` — GitHub 의 소유자·레포 이름이 허용하는 문자만. */
const REPO_SLUG = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/** 스킴이 붙은 원격 URL(`https://`, `http://`, `ssh://`, `git://`)만 인식한다 — 그 외는 scp-like 로 취급. */
const SCHEME_URL = /^(?:https?|ssh|git):\/\//i;

/** scp-like 원격(`git@github.com:o/n.git`, `github.com:o/n`) — user@ 접두사는 최대 하나, 호스트는 앵커된 정확 일치. */
const SCP_LIKE = /^(?:[^@/]+@)?github\.com:(.+)$/;

/**
 * git remote URL → `owner/name`. GitHub 이 아니거나 해석할 수 없으면 undefined.
 * `git@github.com:o/n.git` · `https://github.com/o/n(.git)` · `ssh://git@github.com/o/n` 을 받는다.
 */
export function parseRepoFromRemote(url: string): string | undefined {
  const trimmed = url.trim().replace(/\/+$/, '');
  if (trimmed === '') {
    return undefined;
  }
  // 호스트를 **부분 문자열로 찾지 않는다.** `https://evil.com//github.com/o/n` 처럼
  // 문자열 뒤쪽에 `//github.com/` 이 끼어 있으면 부분 검색은 그 지점부터 다시 앵커해
  // 남의 호스트를 GitHub 으로 오인한다 — 이 슬러그가 "어느 레포에 이슈를 올릴지"를
  // 정하므로 오인은 곧 엉뚱한 레포로 내용이 나가는 일이다.
  if (SCHEME_URL.test(trimmed)) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return undefined;
    }
    if (parsed.hostname.toLowerCase() !== 'github.com') {
      return undefined;
    }
    const slug = parsed.pathname.replace(/^\/+/, '').replace(/\.git$/, '');
    return REPO_SLUG.test(slug) ? slug : undefined;
  }

  const tail = SCP_LIKE.exec(trimmed)?.[1];
  if (!tail) {
    return undefined;
  }
  const slug = tail.replace(/\.git$/, '');
  return REPO_SLUG.test(slug) ? slug : undefined;
}

/** 사용자 입력(웹 UI·CLI 플래그)이 `owner/name` 모양인지. */
export function isRepoSlug(value: string): boolean {
  return REPO_SLUG.test(value.trim());
}

/**
 * links 중 GitHub **이슈** URL 을 찾는다. 중복 생성 가드와 웹 UI 표시가 같은 판별을 쓰도록
 * 여기 하나로 둔다. PR URL(`/pull/<n>`)은 이슈가 아니다.
 */
export function findIssueLink(links: readonly { url: string }[]): string | undefined {
  return links.find((link) => /^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+/.test(link.url))
    ?.url;
}

/** 이슈 URL 끝의 번호. 링크 제목(`#12`)을 만드는 데 쓴다. */
export function issueNumberFrom(url: string): number | undefined {
  const match = /\/issues\/(\d+)/.exec(url.trim());
  return match?.[1] ? Number(match[1]) : undefined;
}

/**
 * 이슈 본문 — 설명 뒤에 보드 참조 한 줄을 붙인다.
 * 데몬은 루프백이라 클릭 가능한 URL 을 넣을 수 없다. 참조 문자열이 사람이 되짚을 수 있는
 * 가장 안정적인 단서다.
 */
export function issueBody(description: string, ref: string): string {
  const backlink = `— rocky-todo \`${ref}\``;
  const body = description.trim();
  return body === '' ? backlink : `${body}\n\n${backlink}`;
}

/**
 * `gh` 로 이슈를 만든다. 실패를 던지지 않고 **사람이 읽는 메시지**로 돌려준다 —
 * 호출자(REST 라우트)가 그대로 사용자에게 보여줄 수 있어야 한다.
 *
 * 본문은 argv 가 아니라 stdin(`-F -`)으로 넘긴다: 긴 설명의 길이 제한과 이스케이프를 피한다.
 */
export function createIssue(
  input: { repo: string; title: string; body: string },
  run: RunCommand = defaultRun,
): { ok: true; url: string } | { ok: false; message: string } {
  let result: { code: number; stdout: string; stderr: string };
  try {
    result = run(
      ['gh', 'issue', 'create', '-R', input.repo, '-t', input.title, '-F', '-'],
      input.body,
    );
  } catch {
    return {
      ok: false,
      message: 'gh CLI 를 찾을 수 없다 — 설치가 필요하다 (https://cli.github.com)',
    };
  }
  const output = `${result.stdout}${result.stderr}`.trim();
  if (result.code !== 0) {
    if (/auth|login|credential/i.test(output)) {
      return { ok: false, message: `${output}\n(먼저: gh auth login)` };
    }
    return { ok: false, message: output === '' ? 'gh issue create 실패' : output };
  }
  const url = result.stdout.trim().split('\n').at(-1)?.trim() ?? '';
  if (!/^https:\/\/github\.com\//.test(url)) {
    return { ok: false, message: `gh 가 이슈 URL 을 돌려주지 않았다: ${output || '(빈 출력)'}` };
  }
  return { ok: true, url };
}
```

- [ ] **Step 4: 테스트 통과를 확인한다**

Run: `bun test src/github.test.ts`
Expected: PASS

- [ ] **Step 5: 게이트를 돌린다**

Run: `bun run check && bun run typecheck && bun test`
Expected: 세 명령 모두 성공 종료

- [ ] **Step 6: 커밋**

```bash
git add src/github.ts src/github.test.ts
git commit -m "feat(github): remote URL 파싱과 gh 이슈 생성"
```

---

### Task 2: `boards.repo` — 마이그레이션과 스토어

**Files:**
- Modify: `src/migrations.ts`
- Modify: `src/store.ts`
- Test: `src/migrations.test.ts`, `src/store.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces:
  - `Board` 에 `repo?: string`
  - `TodoStore.boardById(boardId: string): Board | undefined`
  - `TodoStore.setBoardRepo(key: string, repo: string, actor: string): Board`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src/migrations.test.ts` 끝에 더한다 (이 파일이 쓰는 헬퍼·import 관례를 먼저 읽고 맞춘다):

```ts
describe('addBoardRepo migration', () => {
  test('adds the column and preserves existing rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rocky-todo-mig-repo-'));
    const dbPath = join(dir, 'todo.db');
    const db = new Database(dbPath, { create: true });
    db.run(`CREATE TABLE boards (
      id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
      created_at TEXT NOT NULL, archived_at TEXT
    )`);
    db.run(
      "INSERT INTO boards (id, key, title, created_at) VALUES ('b1', 'rocky', 'rocky', '2026-07-01T00:00:00.000Z')",
    );

    runMigrations(db, { migrations: [addBoardRepo] });

    const row = db
      .query<{ key: string; repo: string | null }, []>('SELECT key, repo FROM boards')
      .get();
    expect(row?.key).toBe('rocky');
    expect(row?.repo).toBeNull();

    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
```

`addBoardRepo` 를 `src/migrations.ts` 에서 export 해야 이 테스트가 import 할 수 있다 — Step 3 에서 함께 한다. 파일 상단 import 에 `addBoardRepo` 를 더한다.

`src/store.test.ts` 의 `describe('boards', ...)` 안에 더한다:

```ts
  test('setBoardRepo stores the slug and it survives a reload', () => {
    const board = store.ensureBoard('rocky', { actor: 'tester' });
    expect(board.repo).toBeUndefined();

    const updated = store.setBoardRepo('rocky', 'minjun0219/rocky', 'tester');
    expect(updated.repo).toBe('minjun0219/rocky');
    expect(store.boardById(board.id)?.repo).toBe('minjun0219/rocky');
    expect(store.listBoards().find((b) => b.key === 'rocky')?.repo).toBe('minjun0219/rocky');
  });

  test('setBoardRepo does not create a board', () => {
    expect(() => store.setBoardRepo('nosuchboard', 'o/n', 'tester')).toThrow(/not found/);
    expect(store.listBoards()).toHaveLength(0);
  });

  test('boardById returns undefined for an unknown id', () => {
    expect(store.boardById('nosuchid')).toBeUndefined();
  });
```

- [ ] **Step 2: 실패를 확인한다**

Run: `bun test src/migrations.test.ts src/store.test.ts`
Expected: FAIL — `addBoardRepo` 를 import 할 수 없고 `store.setBoardRepo is not a function`

- [ ] **Step 3: 마이그레이션을 더한다**

`src/migrations.ts` 의 `addNumbers` 정의 **뒤**, `MIGRATIONS` 배열 **앞**에 넣는다:

```ts
/**
 * 마이그레이션 2: 보드에 GitHub 레포(`owner/name`)를 붙인다.
 *
 * 웹 UI 의 "이슈 만들기" 는 데몬 안에서 실행되는데 데몬에는 cwd 개념이 없어, 보드 key
 * (= git remote basename) 만으로는 owner 를 알 수 없다. 기존 행에는 NULL 이 남고
 * CLI/웹 UI 가 나중에 채운다.
 */
const addBoardRepo: Migration = (db) => {
  db.run('ALTER TABLE boards ADD COLUMN repo TEXT');
};
```

`MIGRATIONS` 배열을 바꾼다 — **기존 항목은 절대 수정하지 않고 뒤에 더하기만 한다**:

```ts
/** 적용 순서 = 배열 순서. 인덱스+1 이 곧 user_version. 기존 항목은 절대 수정하지 않는다. */
export const MIGRATIONS: Migration[] = [addNumbers, addBoardRepo];
```

테스트가 직접 부를 수 있도록 export 한다 — `const addBoardRepo` 를 `export const addBoardRepo` 로 바꾼다.

- [ ] **Step 4: 스토어를 고친다**

`src/store.ts` 의 `Board` 인터페이스에 필드를 더한다:

```ts
export interface Board {
  id: string;
  key: string;
  title: string;
  /** `owner/name` — GitHub 이슈 생성 대상. 설정 전에는 undefined. */
  repo?: string;
  createdAt: string;
  archivedAt?: string;
}
```

`BoardRow` 에도 더한다:

```ts
interface BoardRow {
  id: string;
  key: string;
  title: string;
  repo: string | null;
  created_at: string;
  archived_at: string | null;
}
```

`SCHEMA` 의 `boards` 정의에 컬럼을 더한다 — 신규 DB 는 마이그레이션 없이 이 정의로 만들어지므로 **양쪽이 같아야 한다**:

```sql
CREATE TABLE IF NOT EXISTS boards (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  repo TEXT,
  created_at TEXT NOT NULL,
  archived_at TEXT
);
```

> 신규 DB 는 `SCHEMA` 로 컬럼을 갖고 태어나고, `runMigrations` 는 `user_version` 이 0 이면 `ALTER TABLE` 을 실행하려다 "duplicate column" 으로 실패한다. **막는 방법:** `TodoStore` 생성자는 `SCHEMA` 실행 후 `runMigrations` 를 부르는데, 신규 DB 도 `user_version` 이 0 이다. 그래서 `addBoardRepo` 는 컬럼이 이미 있으면 조용히 넘어가야 한다. 마이그레이션 본문을 다음으로 쓴다:
>
> ```ts
> const addBoardRepo: Migration = (db) => {
>   const columns = db.query<{ name: string }, []>('PRAGMA table_info(boards)').all();
>   if (columns.some((c) => c.name === 'repo')) {
>     return;
>   }
>   db.run('ALTER TABLE boards ADD COLUMN repo TEXT');
> };
> ```
>
> Step 3 의 코드를 이 버전으로 대체한다. Step 1 의 마이그레이션 테스트는 컬럼이 **없는** 테이블에서 시작하므로 그대로 통과하고, 컬럼이 이미 있는 경우도 이 가드가 덮는다.

`toBoard` 를 고친다:

```ts
function toBoard(row: BoardRow): Board {
  return {
    id: row.id,
    key: row.key,
    title: row.title,
    repo: row.repo ?? undefined,
    createdAt: row.created_at,
    archivedAt: row.archived_at ?? undefined,
  };
}
```

`boardKeyOf` 메서드 **뒤**에 두 메서드를 더한다:

```ts
  /** boardId 로 보드 한 건. 이슈 라우트가 todo → 보드 → repo 를 따라갈 때 쓴다. */
  boardById(boardId: string): Board | undefined {
    const row = this.db
      .query<BoardRow, [string]>('SELECT * FROM boards WHERE id = ?')
      .get(boardId);
    return row ? toBoard(row) : undefined;
  }

  /**
   * 보드의 GitHub 레포(`owner/name`)를 설정한다.
   * @throws 없는 보드면 — 여기서 보드를 만들지 않는다. 오타난 key 로 빈 보드가 생기는
   *   편이 조용한 사고가 된다(`ensureSection` 과 같은 판단).
   */
  setBoardRepo(key: string, repo: string, actor: string): Board {
    const existing = this.db
      .query<BoardRow, [string]>('SELECT * FROM boards WHERE key = ?')
      .get(key);
    if (!existing) {
      throw new Error(`board not found: ${key}`);
    }
    this.db.query('UPDATE boards SET repo = ? WHERE id = ?').run(repo, existing.id);
    this.recordHistory(
      'board',
      existing.id,
      actor,
      'update',
      { repo: [existing.repo ?? null, repo] },
      existing.id,
    );
    return { ...toBoard(existing), repo };
  }
```

- [ ] **Step 5: 테스트 통과를 확인한다**

Run: `bun test src/migrations.test.ts src/store.test.ts`
Expected: PASS

- [ ] **Step 6: 게이트를 돌린다**

Run: `bun run check && bun run typecheck && bun test`
Expected: 전부 성공

- [ ] **Step 7: 실제 DB 로 마이그레이션을 한 번 확인한다**

기존 DB 가 실제로 올라가는지 본다. **사용자의 실제 보드를 건드리지 않는다** — 임시 디렉터리를 쓴다:

```bash
export ROCKY_TODO_DIR=$(mktemp -d)
export ROCKY_TODO_PORT=8999
export ROCKY_TODO_EXPOSE=""
bun src/daemon.ts &
sleep 3
curl -s -X POST -H 'content-type: application/json' -H 'x-rocky-actor: t' \
  -d '{"key":"demo"}' "http://127.0.0.1:8999/api/boards"; echo
kill %1
bun -e "
const { Database } = require('bun:sqlite');
const db = new Database(process.env.ROCKY_TODO_DIR + '/todo.db');
console.log('user_version:', db.query('PRAGMA user_version').get());
console.log('columns:', db.query('PRAGMA table_info(boards)').all().map(c => c.name).join(','));
"
rm -rf "$ROCKY_TODO_DIR"
```
Expected: `user_version` 이 2, `columns` 에 `repo` 포함

- [ ] **Step 8: 커밋**

```bash
git add src/migrations.ts src/migrations.test.ts src/store.ts src/store.test.ts
git commit -m "feat(store): 보드에 GitHub 레포를 붙인다"
```

---

### Task 3: 오케스트레이션과 REST 라우트

**Files:**
- Modify: `src/github.ts`
- Modify: `src/server.ts`
- Test: `src/github.test.ts`, `src/server.test.ts`

**Interfaces:**
- Consumes: Task 1 의 `createIssue`/`findIssueLink`/`issueBody`/`issueNumberFrom`/`isRepoSlug`/`RunCommand`, Task 2 의 `boardById`/`setBoardRepo`/`Board.repo`
- Produces:
  - `export function createIssueForTodo(store: TodoStore, ref: string, options: { actor: string; currentBoardId?: string; run?: RunCommand }): { url: string; todo: Todo }`
  - `TodoServerOptions` 에 `run?: RunCommand`
  - `POST /api/todos/:ref/issue` → 201 `{ url, todo }` · 404 · 409 · 400
  - `PATCH /api/boards/:key` `{ repo }` → `Board` · 400 · 404

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src/github.test.ts` 끝에 더한다. 파일 상단 import 를 `createIssueForTodo` 와 스토어 준비에 맞춰 넓힌다 (`import { Database } from 'bun:sqlite'` 는 필요 없다):

```ts
import { afterEach, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIssueForTodo } from './github';
import { TodoStore } from './store';

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
```

`src/server.test.ts` 끝에 더한다:

```ts
describe('github issue', () => {
  test('PATCH /api/boards/:key sets the repo', async () => {
    await req('/api/boards', { method: 'POST', body: JSON.stringify({ key: 'rocky' }) });
    const res = await req('/api/boards/rocky', {
      method: 'PATCH',
      body: JSON.stringify({ repo: 'o/n' }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { repo: string }).repo).toBe('o/n');
  });

  test('PATCH rejects a malformed slug and an unknown board', async () => {
    await req('/api/boards', { method: 'POST', body: JSON.stringify({ key: 'rocky' }) });
    const bad = await req('/api/boards/rocky', {
      method: 'PATCH',
      body: JSON.stringify({ repo: 'not-a-slug' }),
    });
    expect(bad.status).toBe(400);

    const missing = await req('/api/boards/nosuch', {
      method: 'PATCH',
      body: JSON.stringify({ repo: 'o/n' }),
    });
    expect(missing.status).toBe(404);
  });

  test('POST /api/todos/:ref/issue is 400 without a repo and 404 for an unknown todo', async () => {
    const created = await req('/api/todos', {
      method: 'POST',
      body: JSON.stringify({ board: 'rocky', title: '작업' }),
    });
    const todo = (await created.json()) as { id: string };

    const noRepo = await req(`/api/todos/${todo.id}/issue`, { method: 'POST' });
    expect(noRepo.status).toBe(400);

    const missing = await req('/api/todos/nosuchid/issue', { method: 'POST' });
    expect(missing.status).toBe(404);
  });

  test('POST /api/todos/:ref/issue is 409 when an issue link already exists', async () => {
    const created = await req('/api/todos', {
      method: 'POST',
      body: JSON.stringify({
        board: 'rocky',
        title: '작업',
        links: [{ url: 'https://github.com/o/n/issues/3' }],
      }),
    });
    const todo = (await created.json()) as { id: string };
    await req('/api/boards/rocky', { method: 'PATCH', body: JSON.stringify({ repo: 'o/n' }) });

    const res = await req(`/api/todos/${todo.id}/issue`, { method: 'POST' });
    expect(res.status).toBe(409);
  });
});
```

> 이 서버 테스트들은 **`gh` 를 부르지 않는 경로만** 검증한다(400/404/409). 성공 경로는 `github.test.ts` 가 주입된 fake 로 덮는다 — `gh` 없는 머신에서도 전부 통과해야 하기 때문이다.

- [ ] **Step 2: 실패를 확인한다**

Run: `bun test src/github.test.ts src/server.test.ts`
Expected: FAIL — `createIssueForTodo` 를 import 할 수 없고, 라우트가 없어 404 가 온다

- [ ] **Step 3: 오케스트레이터를 더한다**

`src/github.ts` 상단 import 에 타입을 더한다:

```ts
import type { Todo, TodoStore } from './store';
```

파일 끝에 더한다:

```ts
/**
 * todo 하나를 GitHub 이슈로 만들고 그 URL 을 todo 의 `links` 에 덧붙인다.
 *
 * 링크 저장은 기존 `updateTodo` 를 거친다 — 새 저장 경로를 만들지 않으므로 히스토리·SSE·
 * `/api/changes` 훅 주입에 자동으로 실린다.
 *
 * @throws todo/보드를 못 찾거나, 보드에 repo 가 없거나, 이미 이슈 링크가 있거나,
 *   `gh` 가 실패하면. 메시지는 그대로 사용자에게 보여줄 수 있게 쓴다.
 */
export function createIssueForTodo(
  store: TodoStore,
  ref: string,
  options: { actor: string; currentBoardId?: string; run?: RunCommand },
): { url: string; todo: Todo } {
  const todo = store.getTodo(ref, options.currentBoardId);
  if (!todo) {
    throw new Error(`todo not found: ${ref}`);
  }
  const existing = findIssueLink(todo.links);
  if (existing) {
    throw new Error(`todo already has a GitHub issue: ${existing}`);
  }
  const board = store.boardById(todo.boardId);
  if (!board) {
    throw new Error(`board not found for todo: ${ref}`);
  }
  if (!board.repo) {
    throw new Error(
      `board has no GitHub repo: ${board.key} — 먼저 설정한다 (rocky-todo board repo OWNER/NAME)`,
    );
  }
  const boardRef = `${board.key}#${todo.number}`;
  const result = createIssue(
    { repo: board.repo, title: todo.title, body: issueBody(todo.description, boardRef) },
    options.run,
  );
  if (!result.ok) {
    throw new Error(result.message);
  }
  const number = issueNumberFrom(result.url);
  const updated = store.updateTodo(
    todo.id,
    { links: [...todo.links, { url: result.url, title: number ? `#${number}` : 'issue' }] },
    options.actor,
  );
  return { url: result.url, todo: updated };
}
```

- [ ] **Step 4: 라우트를 더한다**

`src/server.ts` 상단 import 에 더한다:

```ts
import { createIssueForTodo, findIssueLink, isRepoSlug, type RunCommand } from './github';
```

`TodoServerOptions` 를 바꾼다:

```ts
export interface TodoServerOptions {
  store: TodoStore;
  /** 외부 명령 실행자 — 테스트가 fake 를 넣는다. 생략하면 실제 `gh` 를 부른다. */
  run?: RunCommand;
}
```

`buildTodoServer` 의 구조분해를 바꾼다:

```ts
  const { store, run } = options;
```

`/api/boards` POST 블록 **뒤**에 넣는다:

```ts
      const boardDetail = path.match(/^\/api\/boards\/([^/]+)$/);
      if (boardDetail?.[1] && method === 'PATCH') {
        const body = await readBody(req);
        if (typeof body.repo !== 'string' || !isRepoSlug(body.repo)) {
          return errorResponse('repo must look like OWNER/NAME', 400);
        }
        return json(store.setBoardRepo(decodeURIComponent(boardDetail[1]), body.repo.trim(), actor));
      }
```

todo 라우트들 뒤(`// ── comments ──` 주석 **앞**)에 넣는다:

```ts
      const todoIssue = path.match(/^\/api\/todos\/([^/]+)\/issue$/);
      if (todoIssue?.[1] && method === 'POST') {
        const ref = decodeURIComponent(todoIssue[1]);
        const currentBoardId = currentBoardIdOf(url, ref);
        const todo = store.getTodo(ref, currentBoardId);
        if (!todo) {
          return errorResponse(`todo not found: ${ref}`, 404);
        }
        // 중복은 409 로 구분한다 — 400(설정/실행 실패)과 원인이 전혀 다르고, 웹 UI 가
        // "이미 있음"을 별도로 다뤄야 한다. 판별은 `findIssueLink` 하나를 공유한다.
        const existing = findIssueLink(todo.links);
        if (existing) {
          return json({ error: `todo already has a GitHub issue: ${existing}`, url: existing }, 409);
        }
        const result = createIssueForTodo(store, ref, { actor, currentBoardId, run });
        return json({ url: result.url, todo: withRef(store, result.todo) }, 201);
      }
```

- [ ] **Step 5: 테스트 통과를 확인한다**

Run: `bun test src/github.test.ts src/server.test.ts`
Expected: PASS

- [ ] **Step 6: 게이트를 돌린다**

Run: `bun run check && bun run typecheck && bun test`
Expected: 전부 성공

- [ ] **Step 7: 커밋**

```bash
git add src/github.ts src/github.test.ts src/server.ts src/server.test.ts
git commit -m "feat(server): 이슈 생성 라우트와 보드 repo 설정"
```

---

### Task 4: MCP — `todo_write.createIssue`

**Files:**
- Modify: `src/mcp.ts`
- Test: `src/mcp.test.ts`

**Interfaces:**
- Consumes: Task 3 의 `createIssueForTodo`, Task 1 의 `RunCommand`
- Produces: `todo_write` 의 `createIssue?: boolean`, `TodoMcpOptions` 에 `run?: RunCommand`. **도구는 5개 그대로.**

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src/mcp.test.ts` 끝에 더한다. 이 파일의 `connect()` 헬퍼는 `buildTodoMcpServer({ store })` 를 부르므로, fake `run` 을 넘길 수 있도록 **헬퍼에 선택 인자를 더한다** (기존 호출부는 그대로 동작해야 한다):

```ts
describe('createIssue through MCP', () => {
  test('todo_write with only createIssue does not create an update history row', async () => {
    store.ensureBoard('rocky', { actor: 'tester' });
    store.setBoardRepo('rocky', 'o/n', 'tester');
    const created = resultJson(
      await client.callTool({ name: 'todo_write', arguments: { board: 'rocky', title: '작업' } }),
    ) as { id: string };

    const issueClient = await connect({
      run: () => ({ code: 0, stdout: 'https://github.com/o/n/issues/7\n', stderr: '' }),
    });
    const patched = resultJson(
      await issueClient.callTool({
        name: 'todo_write',
        arguments: { id: created.id, createIssue: true, actor: 'claude-code' },
      }),
    ) as { links: { url: string }[] };

    expect(patched.links.map((l) => l.url)).toEqual(['https://github.com/o/n/issues/7']);

    const detail = resultJson(
      await client.callTool({ name: 'todo_list', arguments: { id: created.id } }),
    ) as { history: { action: string }[] };
    // links 를 붙이는 updateTodo 는 정당한 update 다. 그 외의 빈 update 가 없어야 한다.
    expect(detail.history.filter((h) => h.action === 'update')).toHaveLength(1);
  });

  test('createIssue on a board without a repo fails and changes nothing', async () => {
    store.ensureBoard('norepo', { actor: 'tester' });
    const created = resultJson(
      await client.callTool({ name: 'todo_write', arguments: { board: 'norepo', title: '작업' } }),
    ) as { id: string };

    const result = await client.callTool({
      name: 'todo_write',
      arguments: { id: created.id, createIssue: true },
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(store.getTodo(created.id)?.links).toEqual([]);
  });

  test('the tool surface is still exactly five tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TODO_MCP_TOOLS].sort());
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `bun test src/mcp.test.ts`
Expected: FAIL — `connect` 가 인자를 받지 않고, `createIssue` 인자가 무시돼 링크가 붙지 않는다

- [ ] **Step 3: `connect` 헬퍼를 넓힌다**

`src/mcp.test.ts` 의 `connect` 를 바꾼다:

```ts
async function connect(options: { run?: RunCommand } = {}): Promise<Client> {
  const server = buildTodoMcpServer({ store, run: options.run });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), c.connect(clientTransport)]);
  return c;
}
```

파일 상단 import 에 `import type { RunCommand } from './github';` 를 더한다.

- [ ] **Step 4: MCP 를 고친다**

`src/mcp.ts` 상단 import 에 더한다:

```ts
import { createIssueForTodo, findIssueLink, type RunCommand } from './github';
```

`TodoMcpOptions` 를 바꾼다:

```ts
export interface TodoMcpOptions {
  store: TodoStore;
  /** 외부 명령 실행자 — 테스트가 fake 를 넣는다. 생략하면 실제 `gh` 를 부른다. */
  run?: RunCommand;
}
```

`buildTodoMcpServer` 의 구조분해를 바꾼다:

```ts
  const { store, run } = options;
```

`todo_write` 의 `inputSchema` 에서 `comment` 다음 줄에 더한다:

```ts
        createIssue: z
          .boolean()
          .optional()
          .describe(
            'true → also open a GitHub issue for this todo and attach its URL to links. Requires the board to have a repo set (rocky-todo board repo OWNER/NAME)',
          ),
```

`todo_write` 의 description 끝에 한 문장을 더한다:

```
 createIssue: true 를 주면 이 todo 를 GitHub 이슈로 올리고 그 URL 을 links 에 붙인다 (보드에 repo 가 설정돼 있어야 한다).
```

핸들러의 구조분해와 본문을 바꾼다. **`createIssue` 를 반드시 구조분해로 빼낸다** — `...rest` 에 남으면 `hasPatch` 가 참이 되어 아무것도 안 바뀐 `update` 히스토리가 생긴다(댓글 때 같은 함정):

```ts
    async ({ id, board, title, comment, createIssue: wantIssue, actor, ...rest }) => {
      const who = actor ?? 'agent';
      // create/patch 를 먼저 실행하고 나서 comment 검증에 걸리면, 이미 만들어진/바뀐
      // todo 는 그대로 남고 에러만 돌아간다 — 호출자가 재시도하면 중복 생성(create)
      // 이거나 의도치 않은 부분 수정(patch)이 이미 적용된 채 남는다. `store.addComment`
      // 가 던질 조건(trim 후 빈 문자열)을 write 전에 그대로 재현해 all-or-nothing 을
      // 보장한다 — 메시지는 `store.addComment` 와 동일하게 맞춰 REST/MCP 표면 간
      // 에러 문구가 갈리지 않게 한다.
      if (comment !== undefined && comment.trim() === '') {
        throw new Error('comment body is required');
      }
      if (id) {
        const currentBoardId = resolveBoardId(store, board, id);
        // 이미 이슈가 있으면 write 전에 끊는다 — 흔한 재시도에서 patch 만 적용되고
        // 에러가 나는 부분 반영을 막는다. gh 실행 자체의 실패는 미리 알 수 없어
        // patch 뒤에 남지만, 그때는 patch 가 정당하게 적용된 상태다.
        if (wantIssue) {
          const current = store.getTodo(id, currentBoardId);
          if (current && findIssueLink(current.links)) {
            throw new Error(`todo already has a GitHub issue: ${findIssueLink(current.links)}`);
          }
        }
        // comment/createIssue 만 온 호출은 updateTodo 를 건너뛴다 — 아무것도 안 바뀐
        // `update` 히스토리 줄이 따라붙어 타임라인을 어지럽히지 않게.
        const hasPatch =
          title !== undefined || Object.values(rest).some((value) => value !== undefined);
        let todo = hasPatch
          ? store.updateTodo(id, { title, ...rest }, who, currentBoardId)
          : store.getTodo(id, currentBoardId);
        if (!todo) {
          throw new Error(`todo not found: ${id}`);
        }
        if (comment !== undefined) {
          store.addComment(todo.id, comment, who);
        }
        if (wantIssue) {
          todo = createIssueForTodo(store, todo.id, { actor: who, run }).todo;
        }
        return jsonResult(withRef(store, todo));
      }
      if (!board || !title) {
        throw new Error('board and title are required to create a todo');
      }
      let created = store.createTodo({ board, title, ...rest }, who);
      if (comment !== undefined) {
        store.addComment(created.id, comment, who);
      }
      if (wantIssue) {
        created = createIssueForTodo(store, created.id, { actor: who, run }).todo;
      }
      return jsonResult(withRef(store, created));
    },
```

- [ ] **Step 5: 테스트 통과를 확인한다**

Run: `bun test src/mcp.test.ts`
Expected: PASS — 도구 수 테스트 포함

- [ ] **Step 6: 게이트를 돌린다**

Run: `bun run check && bun run typecheck && bun test`
Expected: 전부 성공

- [ ] **Step 7: 커밋**

```bash
git add src/mcp.ts src/mcp.test.ts
git commit -m "feat(mcp): todo_write 에 createIssue 추가"
```

---

### Task 5: CLI — `issue` 와 `board repo`

**Files:**
- Modify: `src/cli.ts`
- Test: `src/cli.test.ts`

**Interfaces:**
- Consumes: Task 3 의 REST 라우트, Task 1 의 `parseRepoFromRemote`/`isRepoSlug`
- Produces: `rocky-todo issue REF [--repo OWNER/NAME]` · `rocky-todo board repo [OWNER/NAME]`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src/cli.test.ts` 끝에 더한다. 이 파일에 이미 있는 실서버 하네스(임시 store + `Bun.serve({ port: 0 })` + `buildContext(server.port)`)와 같은 모양을 쓴다:

```ts
describe('issue command paths', () => {
  let dir: string;
  let store: TodoStore;
  let server: ReturnType<typeof Bun.serve>;
  let ctx: CliContext;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rocky-todo-cli-issue-'));
    store = new TodoStore({ dbPath: join(dir, 'todo.db') });
    const api = buildTodoServer({ store });
    server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: (req) => api.fetch(req) });
    if (server.port === undefined) {
      throw new Error('Bun.serve did not assign a port');
    }
    ctx = buildContext({ port: server.port, dir, actor: 'tester' });
  });

  afterEach(() => {
    server.stop(true);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('todoRefPath builds the issue endpoint', () => {
    expect(todoRefPath('rocky#3', '/issue', 'rocky')).toBe('/api/todos/rocky%233/issue?board=rocky');
  });

  test('boardRepoPath encodes the board key', () => {
    expect(boardRepoPath('my.board')).toBe('/api/boards/my.board');
  });

  test('setting a board repo through the CLI path round-trips', async () => {
    store.ensureBoard('rocky', { actor: 'tester' });
    const board = await request<{ repo: string }>(ctx, 'PATCH', boardRepoPath('rocky'), {
      repo: 'o/n',
    });
    expect(board.repo).toBe('o/n');
  });

  test('the issue endpoint answers 400 when the board has no repo', async () => {
    store.ensureBoard('rocky', { actor: 'tester' });
    const todo = store.createTodo({ board: 'rocky', title: '작업' }, 'tester');
    await expect(
      request(ctx, 'POST', todoRefPath(todo.id, '/issue', 'rocky')),
    ).rejects.toThrow(/repo/);
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `bun test src/cli.test.ts`
Expected: FAIL — `boardRepoPath` 를 import 할 수 없다

- [ ] **Step 3: 경로 헬퍼를 더한다**

`src/cli.ts` 의 `noteRefPath` **뒤**에 넣는다:

```ts
/** 보드 단건 엔드포인트 — repo 설정에 쓴다. board key 는 `.` 등을 담을 수 있어 인코딩한다. */
export function boardRepoPath(key: string): string {
  return `/api/boards/${encodeURIComponent(key)}`;
}
```

파일 상단 import 에 더한다:

```ts
import { isRepoSlug, parseRepoFromRemote } from './github';
```

`src/cli.test.ts` 상단 import 에 `boardRepoPath` 를 더한다.

- [ ] **Step 4: `board repo` 서브커맨드를 더한다**

`src/cli.ts` 의 `case 'board':` 블록에서 `add` 분기 **뒤**, `throw new Error('usage: ...')` **앞**에 넣는다:

```ts
      if (sub === 'repo') {
        // 인자를 주면 그 값, 없으면 cwd 의 git remote 에서 유추한다.
        const explicit = rest[1];
        const repo = explicit ?? parseRepoFromRemote(git(['remote', 'get-url', 'origin']) ?? '');
        if (!repo || !isRepoSlug(repo)) {
          throw new Error(
            'GitHub 레포를 알 수 없다 — OWNER/NAME 을 직접 준다: rocky-todo board repo OWNER/NAME',
          );
        }
        const updated = await request<Board>(ctx, 'PATCH', boardRepoPath(board), { repo });
        print(updated, () => `✓ ${updated.key} → ${updated.repo}`);
        return;
      }
```

같은 블록의 usage 문구를 바꾼다:

```ts
      throw new Error(
        'usage: rocky-todo board ls | board add KEY [제목] | board repo [OWNER/NAME]',
      );
```

- [ ] **Step 5: `issue` 커맨드를 더한다**

`src/cli.ts` 의 `case 'comment':` 블록 **뒤**에 넣는다:

```ts
    case 'issue': {
      const id = rest[0];
      if (!id) {
        throw new Error('usage: rocky-todo issue REF [--repo OWNER/NAME]');
      }
      const explicitRepo = str(flags.repo);
      if (explicitRepo) {
        if (!isRepoSlug(explicitRepo)) {
          throw new Error(`--repo 는 OWNER/NAME 모양이어야 한다: ${explicitRepo}`);
        }
        await request(ctx, 'PATCH', boardRepoPath(board), { repo: explicitRepo });
      }
      const path = todoRefPath(id, '/issue', board);
      try {
        const result = await request<{ url: string }>(ctx, 'POST', path);
        print(result, () => `✓ ${result.url}`);
        return;
      } catch (error) {
        // 보드에 repo 가 없을 때만 cwd 에서 유추해 한 번 재시도한다. 미리 보드를 조회하지
        // 않는 이유: 이미 설정된 흔한 경우에 왕복이 하나 줄어든다.
        const message = error instanceof Error ? error.message : String(error);
        // 판별은 반드시 서버의 **특정 메시지**로 한다(`isMissingRepoError`). 맨 `/repo/`
        // 부분 문자열은 이슈 URL 에 `repo` 가 든 409 나 `gh` 의 `repo` 스코프 인증 실패까지
        // 걸려, 보드 repo 를 조용히 덮어쓰고 진짜 원인을 가린다.
        const inferred = isMissingRepoError(message)
          ? parseRepoFromRemote(git(['remote', 'get-url', 'origin']) ?? '')
          : undefined;
        if (!inferred) {
          throw error;
        }
        await request(ctx, 'PATCH', boardRepoPath(board), { repo: inferred });
        const result = await request<{ url: string }>(ctx, 'POST', path);
        print(result, () => `✓ ${result.url} (보드 repo 를 ${inferred} 로 설정했다)`);
        return;
      }
    }
```

`VALUE_FLAGS` 에 `'repo'` 를 더한다:

```ts
const VALUE_FLAGS = new Set([
  'board',
  'section',
  'parent',
  'desc',
  'due',
  'priority',
  'actor',
  'title',
  'content',
  'limit',
  'repo',
]);
```

- [ ] **Step 6: HELP 를 갱신한다**

`src/cli.ts` 의 `HELP` 상수에서 `comment` 줄 **뒤**에 넣는다:

```
  rocky-todo issue REF [--repo OWNER/NAME]      todo 를 GitHub 이슈로 (gh CLI 필요)
```

그리고 `board ls · board add KEY [제목]` 가 있는 줄을 `board repo` 까지 담게 고친다:

```
  rocky-todo history REF [--limit N] [--global|--note] · board ls|add|repo · section ls
```

- [ ] **Step 7: 테스트 통과를 확인한다**

Run: `bun test src/cli.test.ts`
Expected: PASS

- [ ] **Step 8: 게이트를 돌린다**

Run: `bun run check && bun run typecheck && bun test`
Expected: 전부 성공

- [ ] **Step 9: 커밋**

```bash
git add src/cli.ts src/cli.test.ts
git commit -m "feat(cli): issue 명령과 board repo 설정"
```

---

### Task 6: 웹 UI — 버튼과 repo 입력

**Files:**
- Modify: `src/ui/store.ts`
- Modify: `src/ui/components/DetailDrawer.tsx`
- Modify: `src/ui/styles.css`

**Interfaces:**
- Consumes: Task 3 의 REST 라우트, Task 1 의 `findIssueLink`
- Produces: `useUiStore` 액션 `createIssue(todoId: string): Promise<void>` · `setBoardRepo(key: string, repo: string): Promise<void>`

- [ ] **Step 1: 스토어 액션을 더한다**

`src/ui/store.ts` 의 `UiState` 인터페이스에서 `unarchiveComment` 뒤에 더한다:

```ts
  /**
   * todo 를 GitHub 이슈로 만든다.
   * @throws 서버가 거절한 이유를 그대로 던진다 — 보드에 repo 가 없거나(400), 이미 이슈가
   *   있거나(409), gh 가 실패한 경우다. 호출자가 사용자에게 보여줘야 한다.
   */
  createIssue: (todoId: string) => Promise<void>;
  /** 보드의 GitHub 레포를 설정한다. @throws 모양이 틀리면 400 을 그대로 던진다. */
  setBoardRepo: (key: string, repo: string) => Promise<void>;
```

`archiveComment`/`unarchiveComment` 구현 뒤에 더한다:

```ts
  createIssue: async (todoId) => {
    const { actor } = get();
    await api(`/api/todos/${todoId}/issue`, actor, { method: 'POST' });
    await get().refetch();
  },

  setBoardRepo: async (key, repo) => {
    const { actor } = get();
    await api(`/api/boards/${encodeURIComponent(key)}`, actor, {
      method: 'PATCH',
      body: JSON.stringify({ repo }),
    });
    await get().refetch();
  },
```

- [ ] **Step 2: 드로어에 버튼을 더한다**

`src/ui/components/DetailDrawer.tsx` 의 import 에 더한다:

```ts
import type { TodoView } from '../../server';
import { findIssueLink } from '../../github';
```

> **왜 서버 쪽 모듈을 브라우저 번들이 import 해도 되나:** `src/github.ts` 의 유일한 Bun 참조는 `defaultRun` **함수 본문 안**에 있고, 그 함수는 브라우저에서 절대 호출되지 않는다(웹 UI 는 REST 를 거친다). 모듈 로드 시점에 실행되는 코드는 정규식 상수뿐이다. 판별 규칙을 두 벌로 복붙하지 않는 편이 낫다 — 서버의 409 가드와 이 버튼 표시가 **같은 판별**을 써야 화면과 서버가 갈리지 않는다.

`TodoDetail` 의 상태 버튼 묶음(`<div className="drawer-actions">` 중 `▶ 시작` 등이 있는 블록) **뒤**에 넣는다:

```tsx
      <IssueAction todo={todo} />
```

`TodoDetail` 함수 **뒤**에 컴포넌트를 더한다:

```tsx
/** GitHub 이슈 — 없으면 만들고, 있으면 링크로 보낸다. 보드 repo 가 없으면 1회 입력받는다. */
function IssueAction({ todo }: { todo: TodoView }) {
  const boards = useUiStore((s) => s.boards);
  const createIssue = useUiStore((s) => s.createIssue);
  const setBoardRepo = useUiStore((s) => s.setBoardRepo);
  const [repo, setRepo] = useState('');
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const board = boards.find((b) => b.id === todo.boardId);
  const issueUrl = findIssueLink(todo.links);

  if (issueUrl) {
    return (
      <div className="drawer-actions">
        <a className="drawer-btn" href={issueUrl} target="_blank" rel="noreferrer">
          이슈 열기 ↗
        </a>
      </div>
    );
  }

  const submit = async (): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      if (asking) {
        await setBoardRepo(board?.key ?? '', repo.trim());
        setAsking(false);
      }
      await createIssue(todo.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="issue-action">
      {asking && (
        <input
          className="issue-repo-input"
          value={repo}
          placeholder="OWNER/NAME"
          aria-label="GitHub 레포 (OWNER/NAME)"
          onChange={(e) => setRepo(e.target.value)}
        />
      )}
      <div className="drawer-actions">
        <button
          type="button"
          className="drawer-btn"
          disabled={busy || (asking && repo.trim() === '')}
          onClick={() => {
            if (!board?.repo && !asking) {
              setAsking(true);
              return;
            }
            void submit();
          }}
        >
          {busy ? '만드는 중…' : 'GitHub 이슈 만들기'}
        </button>
      </div>
      {/* 실패 사유는 즉시 읽혀야 한다 — 보이기만 하면 스크린리더가 놓친다. */}
      {error && (
        <div className="issue-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: 스타일을 더한다**

`src/ui/styles.css` 끝에 더한다. **새 CSS 변수를 만들지 않는다** — 아래 이름들(`--line`, `--bg`, `--p1`)은 실재를 확인했다. `--p1` 은 p1 우선순위 색이자 기존 `.board-add-error` 가 쓰는 에러 색이라 같은 것을 쓴다:

```css
/* ── GitHub 이슈 ──────────────────────────────────────────────────────────── */
.issue-action {
  margin-top: 10px;
}

.issue-repo-input {
  width: 100%;
  font: inherit;
  padding: 6px 8px;
  border-radius: 6px;
  border: 1px solid var(--line);
  background: var(--bg);
  color: inherit;
}

.issue-error {
  margin-top: 6px;
  font-size: 12px;
  line-height: 1.4;
  color: var(--p1);
  white-space: pre-wrap;
}
```

- [ ] **Step 4: 게이트를 돌린다**

Run: `bun run check && bun run typecheck && bun test`
Expected: 전부 성공

- [ ] **Step 5: 격리 데몬으로 런타임을 확인한다**

**사용자의 실제 보드를 건드리지 않는다.**

```bash
export ROCKY_TODO_DIR=$(mktemp -d)
export ROCKY_TODO_PORT=8999
export ROCKY_TODO_EXPOSE=""
bun src/daemon.ts &
sleep 4
curl -s -o /dev/null -w '/  %{http_code}\n' "http://127.0.0.1:8999/"
curl -s -X POST -H 'content-type: application/json' -H 'x-rocky-actor: t' \
  -d '{"key":"demo"}' "http://127.0.0.1:8999/api/boards" >/dev/null
curl -s -X POST -H 'content-type: application/json' -H 'x-rocky-actor: t' \
  -d '{"board":"demo","title":"이슈 확인"}' "http://127.0.0.1:8999/api/todos"; echo
```

브라우저 확인 항목(직접 못 하면 보고서에 컨트롤러용 체크리스트로 남긴다 — 없는 확인을 했다고 쓰지 말 것):
1. todo 드로어에 "GitHub 이슈 만들기" 버튼이 보인다
2. 보드에 repo 가 없으므로 누르면 `OWNER/NAME` 입력이 뜬다
3. 아무 값이나 넣고 다시 누르면 `gh` 실패 사유가 `role="alert"` 로 읽힌다 (실제 이슈를 만들지 않는다 — **남의 레포에 이슈를 만들지 말 것**)
4. `links` 에 이슈 URL 이 있는 todo 에서는 버튼이 "이슈 열기 ↗" 로 바뀐다

끝나면 **반드시** 데몬을 내리고 임시 디렉터리를 지운다:

```bash
kill %1
rm -rf "$ROCKY_TODO_DIR"
```

- [ ] **Step 6: 커밋**

```bash
git add src/ui/store.ts src/ui/components/DetailDrawer.tsx src/ui/styles.css
git commit -m "feat(ui): 드로어에서 GitHub 이슈 만들기"
```

---

### Task 7: 문서와 changeset

**Files:**
- Modify: `FEATURES.md`, `AGENTS.md`, `docs/rocky-todo.md`, `README.md`
- Create: `.changeset/<이름>.md`

- [ ] **Step 1: 문서를 읽고 형식을 확인한다**

네 문서를 먼저 읽는다. 아래는 담을 **사실**이지 넣을 위치가 아니다 — 각 파일의 기존 형식(표·불릿·코드 블록)과 간결함을 따르는 것이 우선이다.

- [ ] **Step 2: 사실을 문서화한다**

```
todo 를 GitHub 이슈로 올린다 — 웹 UI 드로어의 버튼, CLI `rocky-todo issue REF`,
MCP `todo_write { id, createIssue: true }`. 만들어진 이슈 URL 은 그 todo 의 links 에 자동으로 붙는다.

인증은 `gh` CLI 를 빌린다 — 토큰을 저장하지 않는다. `gh` 가 없거나 로그인 전이면 그 사유를 그대로 보여준다.

보드마다 GitHub 레포(`owner/name`)를 알아야 한다:
  rocky-todo board repo [OWNER/NAME]   # 인자 없으면 cwd 의 git remote 에서 유추
`rocky-todo issue REF` 는 보드에 repo 가 없으면 cwd 에서 유추해 저장하고 진행한다.
웹 UI 는 버튼을 처음 누를 때 1회 입력받는다.

이미 이슈 링크가 있는 todo 는 다시 만들지 않는다(409). 이슈가 닫혀도 todo 는 자동으로 완료되지 않는다.
```

`AGENTS.md` 는 Layout 트리에 `src/github.ts` 를 더하고, MCP 도구 설명이 있으면 `todo_write` 의 `createIssue` 를 언급한다. **도구 수는 5개 그대로**이므로 나열을 늘리지 않는다.

없는 기능을 쓰지 않는다 — 역방향 동기화(이슈 닫힘 → todo 완료)는 **없다**.

- [ ] **Step 3: changeset 을 만든다**

```bash
bunx changeset
```
- bump: **minor**
- 요약: `todo 를 GitHub 이슈로 — 웹 UI 버튼 · CLI issue · MCP todo_write.createIssue (gh CLI 사용, 링크 자동 첨부)`

`bunx changeset` 이 대화형이라 막히면 `.changeset/` 의 기존 파일을 하나 읽어 형식을 확인하고 같은 모양으로 직접 만든다. 패키지명은 `package.json` 의 `name`.

- [ ] **Step 4: 게이트를 돌린다**

Run: `bun run check && bun run typecheck && bun test`
Expected: 전부 성공

- [ ] **Step 5: 커밋**

```bash
git add FEATURES.md AGENTS.md docs/rocky-todo.md README.md .changeset
git commit -m "docs: GitHub 이슈 연동 문서화와 changeset"
```

---

## 완료 조건

1. `bun run check` · `bun run typecheck` · `bun test` 전부 통과 — **`gh` 없는 머신에서도**
2. MCP 도구가 여전히 5개
3. 보드에 repo 가 없으면 400, 이미 이슈가 있으면 409
4. `gh` 실패 사유가 웹 UI 에서 `role="alert"` 로 읽힌다
5. 마이그레이션 후 기존 보드 행이 보존되고 `user_version` 이 2
6. `rocky-todo#8` 을 `done` 으로 전이
