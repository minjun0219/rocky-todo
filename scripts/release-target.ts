/**
 * 릴리스 태그를 붙일 커밋(target sha)을 정한다.
 *
 * 이 함수가 존재하는 이유는 실제로 났던 사고 때문이다. `release.yml` 이 `changesets/action`
 * 과 릴리스 스텝을 **같은 job** 에서 돌리던 시절, changesets 가 워킹 트리의 `package.json` 을
 * 미리 범프하고 Version PR 브랜치로 커밋해버렸다. 뒤이어 실행된 릴리스 스크립트는 그 브랜치
 * 커밋을 `HEAD` 로 읽어 태그를 박았고, 그 브랜치는 스쿼시 머지 후 삭제돼 커밋이 고아가 됐다.
 * 결과적으로 v0.5.0~v0.8.0 의 모든 태그가 main 에 없는 커밋을 가리켰고, 릴리스는 PR 머지보다
 * 2시간 먼저 생성됐다.
 *
 * 그래서 CI 에서는 `GITHUB_SHA`(= push 된 main 커밋)를 진실로 삼고, 워킹 트리의 `HEAD` 가
 * 거기서 벗어나 있으면 **조용히 다른 커밋에 태그를 박는 대신 실패**한다.
 */
export type ResolveTargetInput = {
  /** CI 가 넘겨주는 push 대상 커밋. 로컬 실행 등으로 없을 수 있다. */
  githubSha?: string;
  /** 현재 워킹 트리의 `git rev-parse HEAD`. */
  headSha: string;
};

/**
 * @throws 워킹 트리 HEAD 가 `GITHUB_SHA` 와 다를 때 — 이전 스텝이 트리를 옮겼다는 신호다.
 */
export function resolveTargetSha({ githubSha, headSha }: ResolveTargetInput): string {
  const head = headSha.trim();
  if (!head) {
    throw new Error('HEAD sha 를 읽지 못했다');
  }

  const target = githubSha?.trim();
  if (!target) {
    // 로컬/수동 실행 — 검증할 기준이 없으니 HEAD 를 그대로 쓴다.
    return head;
  }

  if (target !== head) {
    throw new Error(
      `릴리스 대상 커밋이 어긋났다 — GITHUB_SHA=${target} 인데 워킹 트리 HEAD=${head} 다. ` +
        '이전 스텝이 트리를 옮겼을 수 있다(예: changesets 의 Version PR 커밋). ' +
        '릴리스 스텝은 push 된 커밋을 그대로 체크아웃한 별도 job 에서 실행해야 한다.',
    );
  }
  return target;
}

/**
 * 이미 존재하는 태그가 우리가 릴리스하려는 커밋을 가리키는지 확인한다.
 *
 * `gh release create <tag> --target <sha>` 의 `--target` 은 **태그가 없을 때만** 쓰인다
 * (`gh release create --help`: "If a matching git tag does not yet exist, one will automatically
 * get created... Use --target to point to a different branch or commit for the automatic tag
 * creation"). 태그가 이미 있으면 조용히 그 태그의 커밋에 릴리스가 붙는다.
 *
 * 그래서 과거의 잘못된 태그(v0.5.0~v0.8.0 처럼 main 밖 커밋을 가리키는)를 지우고 릴리스만
 * 다시 만들면, 잘못된 연결이 그대로 되살아난다. 어긋나면 멈추고 사람이 판단하게 한다.
 *
 * @param tagSha 원격에 이미 있는 태그가 가리키는 커밋. 태그가 없으면 `undefined`.
 * @throws 태그가 존재하는데 target 과 다른 커밋을 가리킬 때.
 */
export function assertTagMatchesTarget({
  tag,
  tagSha,
  targetSha,
}: {
  tag: string;
  tagSha?: string;
  targetSha: string;
}): void {
  const existing = tagSha?.trim();
  if (!existing || existing === targetSha.trim()) {
    return;
  }
  throw new Error(
    `${tag} 태그가 이미 다른 커밋을 가리킨다 — 태그=${existing}, 릴리스 대상=${targetSha.trim()}. ` +
      'gh 는 태그가 이미 있으면 --target 을 무시하므로, 이대로 두면 잘못된 커밋에 릴리스가 붙는다. ' +
      `의도한 커밋이 맞다면 태그를 먼저 지우고(git push origin :refs/tags/${tag}) 다시 실행하라.`,
  );
}

/**
 * semver 프리릴리즈 판정 — `-` 이 붙은 버전(`0.15.0-next.0`). changesets pre 모드가 내는
 * 형태가 이것이고, GitHub Release 의 `--prerelease` 와 "latest" 표시가 여기서 갈린다.
 * 빌드 메타(`+sha`)만 붙은 버전은 정식이다.
 */
export function isPrerelease(version: string): boolean {
  const core = version.trim().split('+')[0] ?? '';
  return core.includes('-');
}
