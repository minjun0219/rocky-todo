import type { Todo, TodoStore } from './store';

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
export type RunCommand = (
  cmd: readonly string[],
  stdin: string,
) => { code: number; stdout: string; stderr: string };

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
 *
 * 호스트는 문자열 어딘가에 `github.com` 이 등장하는지가 아니라, 실제 파싱된 호스트가
 * 정확히 `github.com` 인지로 판별한다(대소문자 무시) — `evil.com/github.com/...` 같은
 * lookalike 가 통과하지 않게 하기 위해서다.
 */
export function parseRepoFromRemote(url: string): string | undefined {
  const trimmed = url.trim().replace(/\/+$/, '');
  if (trimmed === '') {
    return undefined;
  }

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

  const scp = SCP_LIKE.exec(trimmed);
  const tail = scp?.[1];
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
  return links.find((link) =>
    /^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+(?:[/?#]|$)/.test(link.url),
  )?.url;
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
 * 인증 실패로 보이는 `gh` 출력 — 맞으면 `gh auth login` 힌트를 덧붙인다.
 *
 * 실제로 마주치는 문구가 여러 갈래다: `gh auth login` 안내, `not logged in`,
 * `authentication required`, `HTTP 401: Unauthorized`, `Bad credentials`.
 * 그래서 `\bauth\b` 하나로는 부족하다 — `authentication`/`authorization` 을 놓친다.
 *
 * 다만 `auth` 를 그냥 prefix 로 열면 **`author`/`authored` 가 걸린다**(이슈 생성 오류에
 * 흔한 단어다). 그래서 어간을 명시한다: `authn`/`authz`(약어) · `authentic…` ·
 * `authoriz…`. `authoriz`/`credential` 은 앞 경계를 두지 않아 `unauthorized` ·
 * `credentials` 처럼 붙어 오는 꼴도 잡는다.
 */
const AUTH_FAILURE =
  /\bauth\b|\bauthn\b|\bauthz\b|authentic|authoriz|credential|\blogin\b|\blogged in\b/i;

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
    if (AUTH_FAILURE.test(output)) {
      return { ok: false, message: `${output}\n(먼저: gh auth login)` };
    }
    return { ok: false, message: output === '' ? 'gh issue create 실패' : output };
  }
  // 위치(마지막 줄)를 가정하지 않는다 — 뒤따르는 경고가 있어도 stdout 어디서든 URL 을 찾는다.
  const urlMatch = /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/\d+/.exec(result.stdout);
  if (!urlMatch) {
    return { ok: false, message: `gh 가 이슈 URL 을 돌려주지 않았다: ${output || '(빈 출력)'}` };
  }
  return { ok: true, url: urlMatch[0] };
}

/**
 * todo 에 이미 이슈 링크가 있어서 거절됐다 — 호출자가 **상태 코드로 구분**해야 하는 실패다.
 *
 * 문구 매칭이 아니라 타입으로 구분하는 이유: REST 라우트는 `gh` 의 출력에서 온 실패를
 * 전부 400 으로 내리는데(그 문구에 "not found" 가 섞여 404 로 새던 finding F 때문),
 * 그 규칙에 예외를 두려면 "우리가 던진 것"임이 확실해야 한다. 메시지로 골라내면 `gh`
 * 출력이 우연히 같은 말을 담을 때 잘못 분류된다.
 */
export class IssueAlreadyExistsError extends Error {
  constructor(readonly url: string) {
    super(`todo already has a GitHub issue: ${url}`);
    this.name = 'IssueAlreadyExistsError';
  }
}

/** repo 미설정 에러 문구 — 사전 검증(`assertBoardHasRepo`)과 오케스트레이터가 같은 말을 하도록. */
function noRepoMessage(boardKey: string): string {
  return `board has no GitHub repo: ${boardKey} — 먼저 설정한다 (rocky-todo board repo OWNER/NAME)`;
}

/**
 * 보드에 repo 가 설정돼 있는지 **todo 를 만들기 전에** 확인한다.
 *
 * `createIssueForTodo` 는 todo 가 이미 있어야 부를 수 있어, MCP `todo_write` 의 생성
 * 경로(`id` 없이 `createIssue: true`)에서는 todo 를 저장한 뒤에야 이 전제 위반을 알게
 * 된다 — 호출자는 에러만 받고 만들어진 todo 의 id 를 못 받으니, 같은 요청을 재시도하면
 * 중복 todo 가 쌓인다. 외부 호출 전에 알 수 있는 조건은 write 전에 끊는다.
 *
 * @throws 보드가 없거나 repo 가 설정되지 않았으면 — 메시지는 `createIssueForTodo` 와 같다.
 */
export function assertBoardHasRepo(store: TodoStore, boardKey: string): void {
  const boardId = store.boardIdOf(boardKey);
  const board = boardId ? store.boardById(boardId) : undefined;
  if (!board?.repo) {
    throw new Error(noRepoMessage(boardKey));
  }
}

/**
 * todo 하나를 GitHub 이슈로 만들고 그 URL 을 todo 의 `links` 에 덧붙인다.
 *
 * 링크 저장은 기존 `updateTodo` 를 거친다 — 새 저장 경로를 만들지 않으므로 히스토리·SSE·
 * `/api/changes` 훅 주입에 자동으로 실린다.
 *
 * `options.repo` 를 주면 보드에 이미 설정된 repo 보다 그 값을 우선한다 — REST 라우트가
 * 요청 본문의 `repo` 를 그대로 넘기는 경로다. **`gh` 가 성공한 뒤에만** 그 값을
 * `store.setBoardRepo` 로 보드에 영구 반영한다: 틀린 슬러그를 먼저 저장해두면(구
 * finding — 웹 UI 가 `gh` 응답 전에 `setBoardRepo` 를 불러 실패해도 되돌릴 수 없었다)
 * 실패해도 보드에 잘못된 repo 가 눌어붙는다. 실패하면 보드는 호출 전 상태 그대로다.
 *
 * @throws todo/보드를 못 찾거나, repo 를 알 수 없거나(옵션도 보드도 없음), 이미 이슈
 *   링크가 있거나, `gh` 가 실패하면. 메시지는 그대로 사용자에게 보여줄 수 있게 쓴다.
 */
export function createIssueForTodo(
  store: TodoStore,
  ref: string,
  options: { actor: string; currentBoardId?: string; run?: RunCommand; repo?: string },
): { url: string; todo: Todo } {
  const todo = store.getTodo(ref, options.currentBoardId);
  if (!todo) {
    throw new Error(`todo not found: ${ref}`);
  }
  const existing = findIssueLink(todo.links);
  if (existing) {
    throw new IssueAlreadyExistsError(existing);
  }
  const board = store.boardById(todo.boardId);
  if (!board) {
    throw new Error(`board not found for todo: ${ref}`);
  }
  const repo = options.repo ?? board.repo;
  if (!repo) {
    throw new Error(noRepoMessage(board.key));
  }
  const boardRef = `${board.key}#${todo.number}`;
  const result = createIssue(
    { repo, title: todo.title, body: issueBody(todo.description, boardRef) },
    options.run,
  );
  if (!result.ok) {
    throw new Error(result.message);
  }
  if (options.repo) {
    store.setBoardRepo(board.key, options.repo, options.actor);
  }
  const number = issueNumberFrom(result.url);
  const updated = store.updateTodo(
    todo.id,
    { links: [...todo.links, { url: result.url, title: number ? `#${number}` : 'issue' }] },
    options.actor,
  );
  return { url: result.url, todo: updated };
}
