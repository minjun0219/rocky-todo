#!/usr/bin/env bun
/**
 * .changeset/*.md 의 frontmatter 패키지 이름이 package.json 의 name 과 일치하는지 검사한다.
 *
 * 어긋나면 `changeset version` 이 "Found changeset X for package Y which is not in the workspace"
 * 로 죽는데, 그 자리는 main 머지 뒤 Release 워크플로다 — PR CI 에서 먼저 잡으려고 둔다.
 * 실제로 패키지를 스코프 이름으로 바꾼 PR 과 옛 이름으로 changeset 을 적은 PR 이 나란히
 * 머지되면서, 둘 다 CI 를 통과하고 main 의 릴리스만 멎은 적이 있다.
 *
 * `changeset status` 를 그냥 쓰지 않는 이유: 그쪽은 "변경은 있는데 changeset 이 없다" 도
 * 실패로 보아 docs/chore PR 을 막고, baseBranch 를 git 으로 조회해 shallow checkout 에서
 * 흔들린다. 여기서 보는 건 이름 하나뿐이고, bump 타입·본문은 changesets 자신이 본다.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * changeset frontmatter 에서 패키지 이름들을 뽑는다.
 * `"pkg": minor` 형태의 줄만 보며, 따옴표는 있어도 없어도 받는다 (changesets 자신이 그렇다).
 */
export function packageNamesOf(text: string): string[] {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
  if (frontmatter === undefined) {
    return [];
  }
  return [...frontmatter.matchAll(/^\s*(?:"(.+?)"|'(.+?)'|(\S+?))\s*:\s*\S+\s*$/gm)].map(
    (m) => m[1] ?? m[2] ?? m[3] ?? '',
  );
}

/** 기대 이름과 다른 항목을 사람이 읽을 수 있는 한 줄씩으로 돌려준다. 비어 있으면 통과. */
export function mismatches(files: { name: string; text: string }[], expected: string): string[] {
  return files.flatMap(({ name, text }) =>
    packageNamesOf(text)
      .filter((found) => found !== expected)
      .map((found) => `.changeset/${name}: "${found}" → "${expected}" 이어야 한다`),
  );
}

if (import.meta.main) {
  const repoRoot = join(import.meta.dir, '..');
  const changesetDir = join(repoRoot, '.changeset');

  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { name?: string };
  const pkgName = pkg.name;
  if (!pkgName) {
    throw new Error('package.json 에 name 이 없다');
  }

  const files = readdirSync(changesetDir)
    .filter((name) => name.endsWith('.md') && name !== 'README.md')
    .map((name) => ({ name, text: readFileSync(join(changesetDir, name), 'utf8') }));

  const problems = mismatches(files, pkgName);
  if (problems.length > 0) {
    console.error('changeset 의 패키지 이름이 workspace 와 어긋난다:');
    for (const problem of problems) {
      console.error(`  - ${problem}`);
    }
    process.exit(1);
  }

  console.log(`changeset 패키지 이름 OK — ${files.length}개 (${pkgName})`);
}
