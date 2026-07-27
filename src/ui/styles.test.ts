import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

/**
 * 웹 UI 팔레트의 대비 회귀 가드.
 *
 * `styles.css` 에서 토큰을 직접 파싱한다 — 값을 테스트에 복사해 두면 CSS 만 고쳤을 때
 * 테스트가 낡은 값을 검사하며 통과해 버린다. 기준은 토큰이 실제로 쓰이는 CSS 속성에서
 * 온다: `color:` 로 쓰이면 텍스트(4.5), `border:`/`background:` 전용이면 비텍스트(3.0),
 * 장식적 구분선은 2.2. 근거는 설계 문서 §6 참고.
 */

const CSS = readFileSync(join(import.meta.dir, 'styles.css'), 'utf8');

/*
 * 다크 블록. `:root` 와 속성 선택자를 **둘 다** 요구한다 — index.html 의 인라인
 * 스크립트가 실행되지 못하면 data-theme 이 안 붙는데, 속성 선택자만 두면 토큰이 하나도
 * 적용되지 않아 페이지가 무스타일로 뜬다. 한쪽만 남기면 여기서 블록을 못 찾고 실패한다.
 * (폰트 전용 `:root { --mono; --sans }` 블록을 잘못 잡지 않으려는 목적도 겸한다.)
 */
const DARK_BLOCK_RE = /:root\s*,\s*:root\[data-theme=['"]dark['"]\]\s*\{([^}]*)\}/;

/** 라이트 토큰 블록. */
const LIGHT_BLOCK_RE = /:root\[data-theme=['"]light['"]\]\s*\{([^}]*)\}/;

/** 색이 아닌 토큰 — 대비 검사 대상이 아니다. */
const NON_COLOR_TOKENS = new Set(['--mono', '--sans']);

/** 토큰 이름 → 값 (색 토큰만). 블록을 못 찾으면 조용히 빈 결과를 주지 않고 던진다. */
function parseTokens(css: string, re: RegExp): Map<string, string> {
  const block = re.exec(css);
  const body = block?.[1];
  if (body === undefined) {
    throw new Error(`토큰 블록을 찾지 못했다: ${re}`);
  }
  const tokens = new Map<string, string>();
  for (const match of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    const [, name, value] = match;
    if (name !== undefined && value !== undefined && !NON_COLOR_TOKENS.has(name)) {
      tokens.set(name, value.trim());
    }
  }
  return tokens;
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.1 대비비 (1 ~ 21). 인자 순서는 무관하다. */
function contrast(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

const BACKGROUNDS = ['--bg', '--surface', '--surface-2'];

/** `color:` 로 쓰이는 토큰 — 본문 대비 4.5 */
const TEXT_TOKENS = [
  '--text',
  '--muted',
  '--faint',
  '--warm',
  '--warm-dim',
  '--cool',
  '--p1',
  '--p2',
  '--p3',
  '--handoff',
];

/** `border:` / `background:` 전용 — WCAG 1.4.11 비텍스트 대비 3.0 */
const NON_TEXT_TOKENS = ['--cool-dim', '--ok', '--line-strong'];

/** 장식적 구분선 — 1.4.11 대상이 아니라 "보이되 튀지 않는" 2.2 */
const DIVIDER_TOKENS = ['--line'];

/** 전경이 얹히는 배경 토큰. 세 배경 대비가 아니라 아래 PAIRS 로 검사한다. */
const PAIR_BACKGROUNDS = ['--handoff-dim'];

/** 알파가 있어 합성 결과가 뒤에 깔린 것에 의존한다 — 정적 계산 대상이 아니다. */
const EXEMPT_TOKENS = ['--scrim'];

/** 배경 토큰 위에 전경 토큰이 직접 얹히는 자리. [전경, 배경] */
const PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['--handoff', '--handoff-dim'], // .chip-handoff
  ['--bg', '--ok'], // .todo-check:checked::after 의 ✓
];

function tokenValue(tokens: Map<string, string>, name: string, theme: string): string {
  const value = tokens.get(name);
  if (value === undefined) {
    throw new Error(`[${theme}] ${name} 토큰이 정의돼 있지 않다`);
  }
  return value;
}

/** 세 배경 중 가장 대비가 나쁜 값 — 최악의 자리를 기준으로 판정한다. */
function worstAgainstBackgrounds(tokens: Map<string, string>, name: string, theme: string): number {
  const value = tokenValue(tokens, name, theme);
  return Math.min(...BACKGROUNDS.map((bg) => contrast(value, tokenValue(tokens, bg, theme))));
}

/** 한 테마 블록 전체를 검사한다 — Task 3 이 라이트 테마에도 그대로 재사용한다. */
function expectThemePasses(theme: string, tokens: Map<string, string>): void {
  const groups = [
    { names: TEXT_TOKENS, min: 4.5, kind: '텍스트' },
    { names: NON_TEXT_TOKENS, min: 3.0, kind: '비텍스트' },
    { names: DIVIDER_TOKENS, min: 2.2, kind: '구분선' },
  ];
  for (const { names, min, kind } of groups) {
    for (const name of names) {
      const ratio = worstAgainstBackgrounds(tokens, name, theme);
      expect(
        ratio,
        `[${theme}] ${kind} ${name}(${tokenValue(tokens, name, theme)}) 대비 ${ratio.toFixed(2)} — ${min} 이상이어야 한다`,
      ).toBeGreaterThanOrEqual(min);
    }
  }
  for (const [fg, bg] of PAIRS) {
    const ratio = contrast(tokenValue(tokens, fg, theme), tokenValue(tokens, bg, theme));
    expect(
      ratio,
      `[${theme}] ${fg} on ${bg} 대비 ${ratio.toFixed(2)} — 4.5 이상이어야 한다`,
    ).toBeGreaterThanOrEqual(4.5);
  }
  // 커버리지 가드 — 새 색 토큰을 추가하면 "텍스트인가 테두리인가"를 반드시 정하게 만든다.
  const classified = new Set([
    ...BACKGROUNDS,
    ...TEXT_TOKENS,
    ...NON_TEXT_TOKENS,
    ...DIVIDER_TOKENS,
    ...PAIR_BACKGROUNDS,
    ...EXEMPT_TOKENS,
  ]);
  const unclassified = [...tokens.keys()].filter((name) => !classified.has(name));
  expect(
    unclassified,
    `[${theme}] 분류되지 않은 토큰 — styles.test.ts 의 분류 상수에 추가할 것`,
  ).toEqual([]);
}

describe('dark 팔레트 대비', () => {
  test('모든 토큰이 쓰임에 맞는 대비 기준을 만족한다', () => {
    expectThemePasses('dark', parseTokens(CSS, DARK_BLOCK_RE));
  });
});

describe('light 팔레트 대비', () => {
  test('모든 토큰이 쓰임에 맞는 대비 기준을 만족한다', () => {
    expectThemePasses('light', parseTokens(CSS, LIGHT_BLOCK_RE));
  });
});

describe('테마 대칭성', () => {
  test('두 테마가 동일한 토큰 집합을 정의한다', () => {
    // 한쪽에만 토큰을 추가하면 그 테마에서 반대쪽 값이 상속돼 조용히 어긋난다.
    const dark = [...parseTokens(CSS, DARK_BLOCK_RE).keys()].sort();
    const light = [...parseTokens(CSS, LIGHT_BLOCK_RE).keys()].sort();
    expect(light).toEqual(dark);
  });
});
