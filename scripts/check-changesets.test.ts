import { describe, expect, it } from 'bun:test';
import { mismatches, packageNamesOf } from './check-changesets';

const PKG = '@minjun0219/rocky-todo';

describe('packageNamesOf', () => {
  it('frontmatter 의 패키지 이름을 뽑는다', () => {
    expect(packageNamesOf(`---\n"${PKG}": minor\n---\n\n보드 메타\n`)).toEqual([PKG]);
  });

  it('따옴표 없는/작은따옴표 표기도 받는다', () => {
    expect(packageNamesOf(`---\n${PKG}: patch\n---\n본문\n`)).toEqual([PKG]);
    expect(packageNamesOf(`---\n'${PKG}': patch\n---\n본문\n`)).toEqual([PKG]);
  });

  it('본문의 콜론 줄은 보지 않는다 (frontmatter 안만 읽는다)', () => {
    expect(packageNamesOf(`---\n"${PKG}": minor\n---\n\n주의: 이건 본문이다\n`)).toEqual([PKG]);
  });

  it('frontmatter 가 없으면 빈 배열 — 빈 changeset(--empty)은 통과시킨다', () => {
    expect(packageNamesOf('본문만 있다\n')).toEqual([]);
    expect(packageNamesOf('---\n---\n')).toEqual([]);
  });
});

describe('mismatches', () => {
  it('이름이 맞으면 문제 없음', () => {
    const files = [{ name: 'lazy-pugs-repeat.md', text: `---\n"${PKG}": minor\n---\n본문\n` }];
    expect(mismatches(files, PKG)).toEqual([]);
  });

  it('스코프 빠진 옛 이름을 잡아낸다 — 릴리스를 멎게 했던 그 사고', () => {
    const files = [{ name: 'lazy-pugs-repeat.md', text: '---\n"rocky-todo": minor\n---\n본문\n' }];
    expect(mismatches(files, PKG)).toEqual([
      `.changeset/lazy-pugs-repeat.md: "rocky-todo" → "${PKG}" 이어야 한다`,
    ]);
  });

  it('여러 파일의 문제를 모두 모은다', () => {
    const files = [
      { name: 'a.md', text: '---\n"rocky-todo": minor\n---\n' },
      { name: 'b.md', text: `---\n"${PKG}": patch\n---\n` },
      { name: 'c.md', text: '---\n"rocky": patch\n---\n' },
    ];
    expect(mismatches(files, PKG)).toHaveLength(2);
  });
});
