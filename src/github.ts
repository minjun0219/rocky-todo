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
    if (/\bauth\b|\blogin\b|\bcredential/i.test(output)) {
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
