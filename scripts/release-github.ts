#!/usr/bin/env bun
/**
 * changesets Version PR 이 병합돼 main 의 package.json 버전이 오르면, 그 버전으로
 * `v<version>` GitHub Release(+태그)를 생성한다. 릴리스 노트는 CHANGELOG 해당 섹션.
 * npm publish 는 하지 않는다 — 태그 + GitHub Release 만.
 *
 * release.yml 의 스텝에서 매 main push 마다 실행되므로 멱등이어야 한다.
 * 멱등 기준은 **태그가 아니라 GitHub Release 존재**다 — 태그만 남고 release 생성이 실패한
 * 부분 실패에서도 다음 실행이 release 를 생성해 복구할 수 있다.
 *
 * 태그는 `gh release create` 가 직접 만든다(없으면 `--target` 커밋에 생성) → git user identity
 * 설정이 필요 없다. 전제: GitHub Actions 러너 (gh CLI + GH_TOKEN/GITHUB_TOKEN, contents:write).
 *
 * **이 스크립트는 push 된 커밋을 그대로 체크아웃한 별도 job 에서 돌려야 한다.** `changesets/action`
 * 과 같은 job 에 두면 그 액션이 워킹 트리를 Version PR 브랜치로 옮긴 뒤라, 아직 머지되지도 않은
 * 커밋에 태그가 박힌다 (실제로 v0.5.0~v0.8.0 이 그렇게 만들어졌다). `resolveTargetSha` 가 그
 * 어긋남을 감지해 실패시킨다 — 자세한 경위는 `./release-target` 참고.
 */
import { readFileSync } from 'node:fs';
import { extractChangelogSection } from './changelog';
import { resolveTargetSha } from './release-target';

const version = (JSON.parse(readFileSync('package.json', 'utf8')) as { version?: string }).version;
if (!version) {
  throw new Error('package.json 에 version 이 없다');
}
const tag = `v${version}`;

// 이미 GitHub Release 가 있으면 완전 완료 → skip (멱등)
if (Bun.spawnSync(['gh', 'release', 'view', tag]).success) {
  console.log(`${tag} GitHub Release 이미 존재 — skip (멱등)`);
  process.exit(0);
}

let changelog = '';
try {
  changelog = readFileSync('CHANGELOG.md', 'utf8');
} catch {
  // CHANGELOG 가 없으면 노트는 태그명으로 대체
}
const notes = extractChangelogSection(changelog, version) || tag;

const sha = resolveTargetSha({
  githubSha: process.env.GITHUB_SHA,
  headSha: Bun.spawnSync(['git', 'rev-parse', 'HEAD']).stdout.toString(),
});
const created = Bun.spawnSync(
  ['gh', 'release', 'create', tag, '--target', sha, '--title', tag, '--notes', notes],
  { stdout: 'inherit', stderr: 'inherit' },
);
if (!created.success) {
  throw new Error(`gh release create 실패: ${tag}`);
}
console.log(`released ${tag}`);
