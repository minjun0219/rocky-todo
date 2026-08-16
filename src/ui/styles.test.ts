import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

/**
 * `styles.css` 진입점의 **@import 순서 불변식**을 고정한다.
 *
 * CSS 는 같은 특이도면 뒤에 온 규칙이 이긴다. `responsive.css` 는 베이스 규칙을
 * `!important` 없이 덮는 것이 존재 이유라, 목록의 마지막이 아니면 조용히 무력화된다.
 * 실제로 분할 이전 단일 파일에서 미디어 쿼리 뒤에 세 섹션이 덧붙는 바람에 모바일
 * `.comment-tool` 의 좌우 패딩이 죽어 있었다 — 화면에 티가 안 나서 오래 살아남았다.
 * 파일을 새로 추가할 때 목록 끝에 붙이는 것이 자연스러워서 재발하기 쉽다.
 */
// `new URL(...).pathname` 은 쓰지 않는다 — 경로에 공백이나 유니코드가 있으면 `%20` 처럼
// 퍼센트 인코딩된 문자열이 나와 읽기가 실패한다. 레포 관행대로 `import.meta.dir` 를 쓴다.
const ENTRY = join(import.meta.dir, 'styles.css');
const PARTIALS_DIR = join(import.meta.dir, 'styles');

const entryText = readFileSync(ENTRY, 'utf8');

/** 진입점이 부르는 파티션 이름을 선언 순서대로 뽑는다. */
function importedNames(): string[] {
  return [...entryText.matchAll(/@import\s+["']\.\/styles\/([\w-]+)\.css["']/g)].map(
    (match) => match[1] as string,
  );
}

describe('styles.css @import 순서', () => {
  test('진입점은 규칙을 직접 두지 않는다 — 허용은 @import 와 @layer 선언뿐', () => {
    const rest = entryText
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/@import[^;]+;/g, '')
      .replace(/@layer[^;{]+;/g, '');
    expect(rest.trim()).toBe('');
  });

  test('Tailwind 는 preflight 없이 들어온다 — 요소 리셋이 딸려오면 화면이 바뀐다', () => {
    // 주석을 걷어내고 본다 — 금지 문구를 설명하는 주석 자체가 걸리면 안 된다.
    const code = entryText.replace(/\/\*[\s\S]*?\*\//g, '');
    // 전체 임포트(`@import "tailwindcss"`)나 preflight 직접 임포트 둘 다 금지.
    expect(code).not.toMatch(/@import\s+["']tailwindcss["']/);
    expect(code).not.toContain('preflight');
    // theme / utilities 레이어 임포트는 있어야 한다 — 이게 빠지면 유틸리티가 안 나온다.
    expect(code).toContain('"tailwindcss/theme.css"');
    expect(code).toContain('"tailwindcss/utilities.css"');
  });

  test('tokens.css 가 첫 번째다 — 변수는 쓰이기 전에 정의돼야 한다', () => {
    expect(importedNames()[0]).toBe('tokens');
  });

  test('responsive.css 가 마지막이다', () => {
    expect(importedNames().at(-1)).toBe('responsive');
  });

  test('디스크의 파티션과 목록이 정확히 일치한다', () => {
    const onDisk = readdirSync(PARTIALS_DIR)
      .filter((name) => name.endsWith('.css'))
      .map((name) => name.replace(/\.css$/, ''))
      .sort();
    expect(importedNames().sort()).toEqual(onDisk);
  });
});
