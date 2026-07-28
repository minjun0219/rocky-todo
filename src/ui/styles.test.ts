import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

/**
 * 웹 UI 팔레트의 회귀 가드 — **스냅샷(현상 고정)** 방식.
 *
 * 한때 WCAG 대비 기준(텍스트 4.5 / 비텍스트 3.0 / 구분선 밴드)을 계산해 잠갔지만,
 * 사용자 결정(2026-07-28)으로 디자인 기준을 main 팔레트로 되돌리며 그 기준 검사를
 * 폐기했다 — main 값 일부는 그 기준에 못 미치고, 그게 선택된 디자인이다. 대신 값
 * 자체를 고정한다: 색을 바꾸려면 이 스냅샷을 **의도적으로** 함께 고쳐야 하고,
 * 우연한 드리프트(한 테마만 수정, 토큰 누락)는 여기서 걸린다.
 *
 * `styles.css` 를 직접 파싱한다 — 값을 여기 복사만 해 두면 CSS 만 고쳤을 때
 * 테스트가 낡은 값을 검사하며 통과해 버리기 때문에, 파싱 결과와 스냅샷을 비교한다.
 */

const CSS = readFileSync(join(import.meta.dir, 'styles.css'), 'utf8');

/*
 * 다크 블록. `:root` 와 속성 선택자를 **둘 다** 요구한다 — index.html 의 인라인
 * 스크립트가 실행되지 못하면 data-theme 이 붙지 않는데, 속성 선택자만 두면 토큰이
 * 하나도 적용되지 않아 페이지가 무스타일로 뜬다. 한쪽만 남기면 블록을 못 찾고
 * 실패한다. (폰트 전용 `:root { --mono; --sans }` 블록 오매칭 방지도 겸한다.)
 */
const DARK_BLOCK_RE = /:root\s*,\s*:root\[data-theme=['"]dark['"]\]\s*\{([^}]*)\}/;

/** 라이트 토큰 블록. */
const LIGHT_BLOCK_RE = /:root\[data-theme=['"]light['"]\]\s*\{([^}]*)\}/;

/** 색이 아닌 토큰 — 스냅샷에는 포함하되 색 표기 검사(아래)에서만 예외다. */
const NON_COLOR_TOKENS = new Set(['--mono', '--sans', '--dim-archived', '--dim-stale']);

/** 토큰 이름 → 값. 블록을 못 찾으면 조용히 빈 결과를 주지 않고 던진다. */
function parseTokens(css: string, re: RegExp): Map<string, string> {
  const block = re.exec(css);
  const body = block?.[1];
  if (body === undefined) {
    throw new Error(`토큰 블록을 찾지 못했다: ${re}`);
  }
  const tokens = new Map<string, string>();
  for (const match of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    const [, name, value] = match;
    if (name !== undefined && value !== undefined) {
      tokens.set(name, value.trim());
    }
  }
  return tokens;
}

/**
 * 고정된 팔레트 — main 디자인 기준 (다크), 라이트는 그 톤의 라이트 대응.
 * 바꾸려면 사용자 승인과 함께 이 표를 갱신할 것.
 */
const SNAPSHOT: Record<'dark' | 'light', Record<string, string>> = {
  dark: {
    '--bg': '#16110c',
    '--surface': '#1f1811',
    '--surface-2': '#282017',
    '--text': '#e9dfd2',
    '--muted': '#9c8d7c',
    '--faint': '#6b5f51',
    '--warm': '#e8a33d',
    '--warm-dim': '#8a6526',
    '--cool': '#7ec8d8',
    '--cool-dim': '#47707a',
    '--p1': '#e2634f',
    '--p2': '#e8a33d',
    '--p3': '#c8b45a',
    '--ok': '#86b06c',
    '--handoff': '#93c5fd',
    '--handoff-dim': '#1e3a5f',
    '--line': '#382c1f',
    '--line-strong': '#382c1f',
    '--scrim': 'rgba(10, 7, 4, 0.55)',
    '--dim-archived': '0.45',
    '--dim-stale': '0.55',
  },
  light: {
    '--bg': '#faf6f0',
    '--surface': '#ffffff',
    '--surface-2': '#f2ebe1',
    '--text': '#241c14',
    '--muted': '#6b5c4a',
    '--faint': '#756753',
    '--warm': '#6b4600',
    '--warm-dim': '#8b6019',
    '--cool': '#195564',
    '--cool-dim': '#52828d',
    '--p1': '#b3311c',
    '--p2': '#6b4600',
    '--p3': '#6f6215',
    '--ok': '#3f6b26',
    '--handoff': '#1f5aa8',
    '--handoff-dim': '#d3e4fb',
    '--line': '#d6cab9',
    '--line-strong': '#d6cab9',
    '--scrim': 'rgba(36, 28, 20, 0.35)',
    '--dim-archived': '0.55',
    '--dim-stale': '0.65',
  },
};

describe('팔레트 스냅샷', () => {
  test.each([
    ['dark', DARK_BLOCK_RE],
    ['light', LIGHT_BLOCK_RE],
  ] as const)('%s 블록이 고정된 값과 일치한다', (theme, re) => {
    const actual = Object.fromEntries(parseTokens(CSS, re));
    expect(actual).toEqual(SNAPSHOT[theme]);
  });

  test('두 테마가 동일한 토큰 집합을 정의한다', () => {
    // 한쪽에만 토큰을 추가하면 그 테마에서 반대쪽 값이 상속돼 조용히 어긋난다.
    // (스냅샷 비교가 사실상 포함하지만, 실패 메시지가 "집합이 다르다"로 곧장 나온다.)
    const dark = [...parseTokens(CSS, DARK_BLOCK_RE).keys()].sort();
    const light = [...parseTokens(CSS, LIGHT_BLOCK_RE).keys()].sort();
    expect(light).toEqual(dark);
  });
});

describe('NON_COLOR_TOKENS 무검증 탈출구 가드', () => {
  test('NON_COLOR_TOKENS 로 등록된 토큰은 실제로 색이 아니다', () => {
    // 색 값을 실수로 여기 넣으면 "색이 아니라서 자유 형식" 이라는 전제가 무너진다.
    // 테마 블록만 훑으면 안 된다 — `--mono`/`--sans` 는 별도 `:root` 블록에 산다.
    // 선언 위치를 가리지 않고 CSS 전체에서 해당 이름의 모든 선언을 검사한다.
    const COLOR_LIKE = /^#|rgb\(|rgba\(|hsl\(|color-mix\(/;
    const violations = [...NON_COLOR_TOKENS].flatMap((name) =>
      [...CSS.matchAll(new RegExp(`${name}\\s*:\\s*([^;]+);`, 'g'))]
        .map((m) => (m[1] ?? '').trim())
        .filter((value) => COLOR_LIKE.test(value))
        .map((value) => `${name} = ${value}`),
    );
    expect(violations, 'NON_COLOR_TOKENS 에 등록된 이름이 색 값을 담고 있다').toEqual([]);
  });
});
