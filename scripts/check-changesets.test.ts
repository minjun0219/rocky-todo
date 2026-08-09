import { describe, expect, it } from 'bun:test';
import { mismatches, packageNamesOf } from './check-changesets';

const PKG = '@minjun0219/rocky-todo';

describe('packageNamesOf', () => {
  it('frontmatter 의 패키지 이름을 뽑는다', () => {
    expect(packageNamesOf(`---\n"${PKG}": minor\n---\n\n보드 메타\n`)).toEqual([PKG]);
  });

  it('작은따옴표 표기도 받는다', () => {
    expect(packageNamesOf(`---\n'${PKG}': patch\n---\n본문\n`)).toEqual([PKG]);
  });

  it('따옴표 없는 이름도 받는다 (스코프 없는 이름)', () => {
    expect(packageNamesOf('---\nrocky-todo: patch\n---\n본문\n')).toEqual(['rocky-todo']);
  });

  it('따옴표 없는 스코프 이름은 던진다 — YAML 에서 @ 는 예약 문자라 changesets 도 죽는다', () => {
    expect(() => packageNamesOf(`---\n${PKG}: patch\n---\n본문\n`)).toThrow(
      /올바른 YAML 이 아니다/,
    );
  });

  it('인라인 YAML 주석이 있어도 이름을 읽는다 — 정규식이면 줄째로 놓쳤다', () => {
    expect(packageNamesOf(`---\n"${PKG}": minor # 보드 메타 때문\n---\n본문\n`)).toEqual([PKG]);
  });

  it('주석 줄은 이름으로 세지 않는다', () => {
    expect(packageNamesOf(`---\n# 이건 주석\n"${PKG}": minor\n---\n본문\n`)).toEqual([PKG]);
  });

  it('본문의 콜론 줄은 보지 않는다 (첫 --- 쌍 안만 읽는다)', () => {
    expect(packageNamesOf(`---\n"${PKG}": minor\n---\n\n주의: 이건 본문이다\n`)).toEqual([PKG]);
  });

  it('빈 frontmatter 는 통과 — `changeset add --empty` 의 정상 형태다', () => {
    expect(packageNamesOf('---\n---\n')).toEqual([]);
  });

  it('frontmatter 가 없으면 던진다 (fail-closed)', () => {
    expect(() => packageNamesOf('본문만 있다\n')).toThrow(/frontmatter 를 찾지 못했다/);
  });

  it('frontmatter 가 매핑이 아니면 던진다', () => {
    expect(() => packageNamesOf('---\n- 리스트다\n---\n본문\n')).toThrow(/매핑이어야 한다/);
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

  it('인라인 주석 뒤에 숨은 어긋남도 잡아낸다', () => {
    const files = [{ name: 'a.md', text: '---\n"rocky-todo": minor # 이유\n---\n본문\n' }];
    expect(mismatches(files, PKG)).toHaveLength(1);
  });

  it('읽지 못한 파일은 통과가 아니라 문제로 보고한다', () => {
    const files = [{ name: 'broken.md', text: '프론트매터가 없다\n' }];
    expect(mismatches(files, PKG)).toEqual([
      '.changeset/broken.md: frontmatter 를 찾지 못했다 (--- 로 감싼 블록이 필요하다)',
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
