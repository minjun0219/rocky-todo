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
 * changeset frontmatter 를 잘라내는 정규식. `@changesets/parse` 의 `mdRegex` 와 같은 모양이다
 * — 앞의 공백을 허용하고 첫 `---` 쌍만 본다. 손으로 줄을 훑는 대신 이걸 쓰는 이유는,
 * 추출 범위가 changesets 와 어긋나면 여기서 통과한 파일이 릴리스에서 죽기 때문이다.
 */
const FRONTMATTER_RE = /\s*---([\s\S]*?)\n\s*---(?:\s*(?:\n|$))/;

/**
 * changeset frontmatter 에서 패키지 이름들을 뽑는다.
 *
 * 파싱은 **YAML 로** 한다 — changesets 자신이 `js-yaml` 로 읽으므로 인라인 주석
 * (`"pkg": minor # 이유`)이나 따옴표 없는 표기가 전부 정상 문법이다. 이걸 정규식으로
 * 흉내내면 못 읽은 줄이 조용히 빠져 **검사가 fail-open** 한다 (이름이 어긋나도 통과).
 * `Bun.YAML` 은 내장이라 dep 이 늘지 않는다.
 *
 * @throws frontmatter 가 없거나 YAML 이 깨졌거나 객체가 아닐 때 — 못 읽었으면 통과가 아니라
 * 실패다(fail-closed). changesets 도 같은 입력에서 죽으므로 여기서 먼저 죽는 게 낫다.
 */
export function packageNamesOf(text: string): string[] {
  const frontmatter = FRONTMATTER_RE.exec(text)?.[1];
  if (frontmatter === undefined) {
    throw new Error('frontmatter 를 찾지 못했다 (--- 로 감싼 블록이 필요하다)');
  }

  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(frontmatter);
  } catch (error) {
    throw new Error(`frontmatter 가 올바른 YAML 이 아니다: ${(error as Error).message}`);
  }

  // 빈 frontmatter 는 `changeset add --empty` 의 정상 형태다 — 이름이 없을 뿐 오류가 아니다.
  if (parsed === null || parsed === undefined) {
    return [];
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('frontmatter 는 "패키지 이름: bump" 매핑이어야 한다');
  }
  return Object.keys(parsed);
}

/** 기대 이름과 다른 항목을 사람이 읽을 수 있는 한 줄씩으로 돌려준다. 비어 있으면 통과. */
export function mismatches(files: { name: string; text: string }[], expected: string): string[] {
  return files.flatMap(({ name, text }) => {
    let found: string[];
    try {
      found = packageNamesOf(text);
    } catch (error) {
      return [`.changeset/${name}: ${(error as Error).message}`];
    }
    return found
      .filter((actual) => actual !== expected)
      .map((actual) => `.changeset/${name}: "${actual}" → "${expected}" 이어야 한다`);
  });
}

if (import.meta.main) {
  const repoRoot = join(import.meta.dir, '..');
  const changesetDir = join(repoRoot, '.changeset');

  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { name?: string };
  const pkgName = pkg.name;
  if (!pkgName) {
    throw new Error('package.json 에 name 이 없다');
  }

  // readdirSync 순서는 파일시스템에 달렸다 — 실패 목록이 실행마다 뒤바뀌지 않게 정렬한다.
  const files = readdirSync(changesetDir)
    .filter((name) => name.endsWith('.md') && name !== 'README.md')
    .sort()
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
