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
const NON_COLOR_TOKENS = new Set(['--mono', '--sans', '--dim-archived', '--dim-stale']);

/**
 * 토큰 이름 → 값. 블록을 못 찾으면 조용히 빈 결과를 주지 않고 던진다.
 *
 * 두 용도로 쓰인다 — 기본(`includeNonColor: false`)은 대비 검사용으로 `NON_COLOR_TOKENS`
 * 를 걸러낸 색 토큰만 반환한다. `includeNonColor: true` 는 테마 대칭성 검사용으로, 색이
 * 아닌 토큰(`--dim-archived` 등)도 포함한 전체 토큰 집합을 반환한다 — 대칭성은 "두 테마가
 * 같은 이름의 토큰을 정의하는가"를 보는 것이라 색 여부와 무관하다. 필터링된 Map 의 키만
 * 비교하면 `NON_COLOR_TOKENS` 에 속한 토큰은 대칭성 가드 밖으로 빠져, 한쪽 테마에서만
 * 지워져도 테스트가 놓친다.
 */
function parseTokens(
  css: string,
  re: RegExp,
  options?: { includeNonColor?: boolean },
): Map<string, string> {
  const includeNonColor = options?.includeNonColor ?? false;
  const block = re.exec(css);
  const body = block?.[1];
  if (body === undefined) {
    throw new Error(`토큰 블록을 찾지 못했다: ${re}`);
  }
  const tokens = new Map<string, string>();
  for (const match of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    const [, name, value] = match;
    if (
      name !== undefined &&
      value !== undefined &&
      (includeNonColor || !NON_COLOR_TOKENS.has(name))
    ) {
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
    // NON_COLOR_TOKENS 도 포함한 전체 집합을 비교한다 — 색이 아니어도 대칭은 지켜야
    // 한다(예: --dim-stale 이 라이트에만 없으면 라이트가 :root 의 값을 조용히 상속한다).
    const dark = [...parseTokens(CSS, DARK_BLOCK_RE, { includeNonColor: true }).keys()].sort();
    const light = [...parseTokens(CSS, LIGHT_BLOCK_RE, { includeNonColor: true }).keys()].sort();
    expect(light).toEqual(dark);
  });
});

describe('NON_COLOR_TOKENS 무검증 탈출구 가드', () => {
  test('NON_COLOR_TOKENS 로 등록된 토큰은 실제로 색이 아니다', () => {
    // NON_COLOR_TOKENS 에 이름을 넣으면 대비 검사·커버리지 가드·대칭성 필터링을 한 번에
    // 면제받는다. 색 값을 실수로(혹은 커버리지 가드를 피하려고) 여기 넣으면 대비 회귀가
    // 조용히 통과해 버리므로, 값 자체가 색 표기가 아님을 단언한다.
    const COLOR_LIKE = /^#|rgb\(|rgba\(|hsl\(|color-mix\(/;
    const themes: ReadonlyArray<readonly [string, RegExp]> = [
      ['dark', DARK_BLOCK_RE],
      ['light', LIGHT_BLOCK_RE],
    ];
    const violations = themes.flatMap(([theme, re]) => {
      const tokens = parseTokens(CSS, re, { includeNonColor: true });
      return [...NON_COLOR_TOKENS]
        .filter((name) => {
          const value = tokens.get(name);
          return value !== undefined && COLOR_LIKE.test(value);
        })
        .map((name) => `[${theme}] ${name} = ${tokens.get(name)}`);
    });
    expect(violations).toEqual([]);
  });
});

describe('분류 드리프트 가드', () => {
  test('비텍스트/구분선 토큰이 color: 로 쓰이지 않는다', () => {
    // TEXT_TOKENS 는 4.5 기준으로 검사되지만, 비텍스트(3.0)/구분선(2.2) 토큰이 나중에
    // `color:` 자리에 쓰이면 더 낮은 기준으로 통과해 버리면서 실제로는 4.5 를 어긴다.
    // `(?<![\w-])` 로 `border-color:`/`outline-color:` 등 다른 프로퍼티의 접미어를
    // "color:" 로 오인하지 않게 막는다.
    const nonTextColorTokens = [...NON_TEXT_TOKENS, ...DIVIDER_TOKENS].filter((name) =>
      new RegExp(`(?<![\\w-])color:\\s*var\\(${name}(?:[,)]|\\s)`).test(CSS),
    );
    expect(
      nonTextColorTokens,
      `비텍스트/구분선 토큰이 color: 로 쓰였다 — 텍스트 기준(4.5)으로 재분류하거나 사용처를 바꿀 것`,
    ).toEqual([]);
  });
});
