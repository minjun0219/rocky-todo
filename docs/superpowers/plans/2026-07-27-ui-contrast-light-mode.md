# 웹 UI 대비 리튠 + 라이트 모드 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** rocky-todo 웹 UI 의 WCAG 미달 색 4개와 10px 마이크로라벨을 고쳐 읽히게 만들고, `data-theme` 기반 라이트 모드를 추가한다.

**Architecture:** `src/ui/styles.css` 의 CSS 커스텀 프로퍼티만 손대고 컴포넌트 색은 건드리지 않는다 — 하드코딩 색이 1곳뿐이라 가능하다. 다크 토큰 블록은 `:root, :root[data-theme='dark']` 두 선택자에 걸어 JS 실패 시에도 스타일이 살아 있게 하고, 라이트는 `:root[data-theme='light']` 에만 건다. `auto` 해석은 `index.html` 의 인라인 블로킹 스크립트가 맡아 CSS 토큰 블록 중복을 없앤다. 새로 만드는 `src/ui/styles.test.ts` 가 CSS 를 파싱해 대비를 계산하고 회귀를 잠근다.

**Tech Stack:** Bun · TypeScript · React 19 · zustand · `bun:test` · Biome

## Global Constraints

- **설계 문서**: `docs/superpowers/specs/2026-07-27-ui-contrast-light-mode-design.md` · 보드 항목 `rocky-todo#21`
- **런타임 의존성 추가 금지** — Tailwind·shadcn·아이콘 라이브러리 전부 이번 범위 밖이다
- **Import 규칙**: 전부 상대경로, 확장자 없음 (`moduleResolution: Bundler`)
- **ESM**: `__dirname` 금지 — `import.meta.dir` / `import.meta.url` 사용
- **JSDoc**: exported 함수에 작성. 한국어 주석 OK, 코드 식별자·경로·명령·URL 은 영어 원형
- **게이트**: 매 커밋 전 `bun run check` · `bun run typecheck` · `bun test` 전부 통과
- **커밋 메시지**: Conventional Commits — `type(scope): 한국어 요약` (50자 내외)
- **대비 기준** (각 테마의 `--bg`/`--surface`/`--surface-2` 중 **최악값** 기준):
  - 텍스트(`color:` 로 쓰이는 토큰) ≥ **4.5**
  - 비텍스트(`border:`/`background:` 전용) ≥ **3.0**
  - 장식적 구분선(`--line`) ≥ **2.2**
  - 명시 쌍 ≥ **4.5**
- **최종 토큰 값** (아래 모든 태스크가 이 표를 따른다 — 임의로 바꾸지 말 것):

  | 토큰 | DARK | LIGHT |
  | --- | --- | --- |
  | `--bg` | `#16110c` | `#faf6f0` |
  | `--surface` | `#1f1811` | `#ffffff` |
  | `--surface-2` | `#282017` | `#f2ebe1` |
  | `--text` | `#e9dfd2` | `#241c14` |
  | `--muted` | `#9c8d7c` | `#6b5c4a` |
  | `--faint` | `#978775` | `#756753` |
  | `--warm` | `#e8a33d` | `#6b4600` |
  | `--warm-dim` | `#b08130` | `#8b6019` |
  | `--cool` | `#7ec8d8` | `#195564` |
  | `--cool-dim` | `#4b7680` | `#52828d` |
  | `--p1` | `#e2634f` | `#b3311c` |
  | `--p2` | `#e8a33d` | `#6b4600` |
  | `--p3` | `#c8b45a` | `#6f6215` |
  | `--ok` | `#86b06c` | `#3f6b26` |
  | `--handoff` | `#93c5fd` | `#1f5aa8` |
  | `--handoff-dim` | `#1e3a5f` | `#d3e4fb` |
  | `--line` | `#6d563c` | `#b19979` |
  | `--line-strong` | `#876a4b` | `#9a7e59` |
  | `--scrim` | `rgba(10, 7, 4, 0.55)` | `rgba(36, 28, 20, 0.35)` |
  | `--dim-archived` | `0.45` | `0.55` |
  | `--dim-stale` | `0.55` | `0.65` |

- **localStorage 키**: `rocky-todo:theme` — 값은 `'auto' | 'dark' | 'light'`

---

## File Structure

| 파일 | 책임 | 태스크 |
| --- | --- | --- |
| `src/ui/styles.test.ts` (신규) | CSS 토큰 파싱 + 대비 계산 + 회귀 가드. 런타임 코드 아님 | 1·3 |
| `src/ui/styles.css` | 토큰 정의(두 테마) · `--line`/`--line-strong` 사용처 분류 · 폰트 하한 | 2·3·7 |
| `src/ui/lib.ts` | `resolveTheme` 순수 함수 — 저장값 + OS 설정 → 적용 테마 | 4 |
| `src/ui/lib.test.ts` | `resolveTheme` 단위 테스트 | 4 |
| `src/ui/index.html` | 첫 페인트 전 `data-theme` 확정 (인라인 블로킹 스크립트) | 5 |
| `src/ui/store.ts` | `themePref` 상태 + `setThemePref` | 5 |
| `src/ui/main.tsx` | `auto` 일 때 OS 테마 변경 구독 | 5 |
| `src/ui/components/TopBar.tsx` | 3상 테마 토글 UI | 6 |

대비 계산 함수는 `styles.test.ts` **안에** 둔다. 테스트 전용이라 런타임 번들에 들어갈 이유가 없고, 별도 모듈로 빼면 그 모듈을 위한 테스트가 또 필요해진다 (YAGNI).

---

### Task 1: 대비 회귀 테스트 — 현행 팔레트의 실패를 드러낸다

**Files:**
- Create: `src/ui/styles.test.ts`
- Read-only: `src/ui/styles.css` (이 태스크에서 수정하지 않는다)

**Interfaces:**
- Consumes: 없음 (첫 태스크)
- Produces: `styles.test.ts` 내부의 `DARK_BLOCK_RE` · `parseTokens(css, re)` · `contrast(a, b)` · `tokenValue(tokens, name, theme)` · `expectThemePasses(theme, tokens)` · 분류 상수 `BACKGROUNDS` / `TEXT_TOKENS` / `NON_TEXT_TOKENS` / `DIVIDER_TOKENS` / `PAIR_BACKGROUNDS` / `EXEMPT_TOKENS` / `PAIRS`. Task 3 이 라이트 블록 검증과 대칭성 테스트를 여기에 덧붙인다.

- [ ] **Step 1: 실패하는 테스트를 작성한다**

`src/ui/styles.test.ts` 를 아래 내용 그대로 만든다. 이 시점의 `styles.css` 는 아직 `:root { ... }` 하나뿐이므로 다크 블록 정규식이 그것을 잡는다 — Task 3 에서 선택자 구조가 바뀔 때 이 정규식도 함께 조인다.

> 아래 코드는 `bun run check` · `bun run typecheck` · `bun test` 를 통과하는 것이 확인된 형태다. 특히 `tsconfig.json` 의 `noUncheckedIndexedAccess: true` 때문에 배열·Map 인덱싱 결과가 전부 `| undefined` 다 — `tokenValue` 로 좁히는 구조를 유지할 것. 그리고 헬퍼 이름을 `valueOf` 로 쓰면 Biome 의 `lint/suspicious/noShadowRestrictedNames` 에 걸린다.

```ts
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

/** 다크 토큰 블록. Task 3 이 `:root, :root[data-theme="dark"]` 형태로 조인다. */
const DARK_BLOCK_RE = /:root\s*\{([^}]*)\}/;

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
```

- [ ] **Step 2: 테스트를 실행해 "팔레트 때문에" 실패하는지 확인한다**

Run: `bun test src/ui/styles.test.ts`

Expected: **FAIL**, 그리고 첫 실패 메시지가 정확히 이것이어야 한다:

```
error: [dark] 텍스트 --faint(#6b5f51) 대비 2.58 — 4.5 이상이어야 한다
```

`--faint` 를 고치면 `--warm-dim`(#8a6526, 3.03) → `--cool-dim`(#47707a, 2.95) → `--line`(#382c1f, 1.18) 순으로 드러나고, `--line-strong` 과 `--scrim` 은 아직 없어 `토큰이 정의돼 있지 않다` 로 걸린다. **전부 Task 2 가 해결한다.**

> 다른 이유로 실패하면 (예: `토큰 블록을 찾지 못했다`) 코드를 잘못 옮긴 것이다. 계속 진행하지 말 것.

- [ ] **Step 3: Biome 과 타입 체크를 통과하는지 확인한다**

Run: `bun run check && bun run typecheck`

Expected: 둘 다 통과. (`bun test` 는 아직 레드인 것이 정상이다.)

- [ ] **Step 4: 레드 상태로 커밋한다**

다음 태스크가 이 테스트를 그린으로 만드는 것이 계약이다.

```bash
git add src/ui/styles.test.ts
git commit -m "test(ui): 팔레트 대비 회귀 가드 추가 (현재 실패)"
```

> `.husky` 의 lint-staged 가 Biome 을 돌린다 — 포맷이 조정돼 커밋에 반영될 수 있는데 정상이다.

---

### Task 2: 다크 팔레트 리튠 — 미달 4개 수정 + 토큰 2개 신설

**Files:**
- Modify: `src/ui/styles.css:7-28` (`:root` 토큰 블록) · `:571` (스크림) · `--line` 사용처 6곳
- Test: `src/ui/styles.test.ts` (Task 1 에서 만든 것 — 수정하지 않는다)

**Interfaces:**
- Consumes: Task 1 의 `styles.test.ts`
- Produces: `--line-strong` · `--scrim` 토큰. Task 3 이 이 두 개를 라이트 블록에도 정의한다.

- [ ] **Step 1: 토큰 블록을 리튠한다**

`src/ui/styles.css` 의 `:root { ... }` 블록(7–28행)을 아래로 교체한다. 선택자는 아직 `:root` 그대로다 — Task 3 이 바꾼다.

```css
:root {
  --bg: #16110c;
  --surface: #1f1811;
  --surface-2: #282017;
  --text: #e9dfd2;
  --muted: #9c8d7c;
  /* 마이크로라벨 14곳의 색 — 옛 #6b5f51 은 최악 배경에서 대비 2.58 로 읽히지 않았다. */
  --faint: #978775;
  --warm: #e8a33d; /* 에이전트 / 에리디언 */
  /* .group-eyebrow 의 텍스트색이자 뱃지 테두리 — 텍스트로 쓰이므로 4.5 기준이다. */
  --warm-dim: #b08130;
  --cool: #7ec8d8; /* 사람 / 지구 */
  /* 테두리로만 쓰인다 — 기준 3.0. 여기에 4.5 를 강요하면 쿨 톤이 필요 이상 밝아진다. */
  --cool-dim: #4b7680;
  --p1: #e2634f;
  --p2: #e8a33d;
  --p3: #c8b45a;
  --ok: #86b06c;
  --handoff: #93c5fd; /* 핸드오프 — "보냈다"(파랑), doing 앰버(--warm)와 구분 */
  --handoff-dim: #1e3a5f;
  /* 구분선(장식)과 컨트롤 테두리(WCAG 1.4.11)는 요구 대비가 다르다 — 토큰을 나눈다. */
  --line: #6d563c;
  --line-strong: #876a4b;
  --scrim: rgba(10, 7, 4, 0.55);
  --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, monospace;
  --sans:
    -apple-system, BlinkMacSystemFont, "Segoe UI", "Apple SD Gothic Neo", "Pretendard", sans-serif;
}
```

- [ ] **Step 2: 스크림 하드코딩을 토큰으로 승격한다**

`styles.css` 의 `.drawer-backdrop` 규칙에서:

```css
  background: rgba(10, 7, 4, 0.55);
```

를 아래로 바꾼다.

```css
  background: var(--scrim);
```

- [ ] **Step 3: 컨트롤 테두리를 `--line-strong` 으로 옮긴다**

`border: 1px solid var(--line)` 를 쓰는 17곳 중 **사용자가 조작하는 컨트롤 7곳**만 `--line-strong` 으로 바꾼다. 선택자로 찾을 것 (행 번호는 Step 1 이후 밀린다):

| 선택자 | 이유 |
| --- | --- |
| `.quick-add-input` | 텍스트 입력 |
| `.chip` | `.chip-link` 가 `<a>` — 작고 조작 가능 |
| `.drawer-desc` | textarea |
| `.drawer-btn` | 버튼 |
| `.drawer-select` | select |
| `.comment-input` | 텍스트 입력 |
| `.issue-repo-input` | 텍스트 입력 |

각 규칙의 `var(--line)` 을 `var(--line-strong)` 으로 바꾼다. 예:

```css
.quick-add-input {
  /* ... */
  border: 1px solid var(--line-strong);
}
```

**`--line` 으로 남겨둘 것** (구조적 구분선 — 바꾸지 말 것): `.topbar` · `.sidebar`(두 곳) · `.group-eyebrow` · `.notes-rail`(두 곳) · `.note-card` · `.drawer` · `.drawer-history` · `.comment-card`

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `bun test src/ui/styles.test.ts`

Expected: **PASS.** 다크 팔레트 대비 검사 통과.

- [ ] **Step 5: 사용처 분류가 빠짐없는지 확인한다**

Run:

```bash
grep -n "var(--line)" src/ui/styles.css | wc -l && grep -n "var(--line-strong)" src/ui/styles.css | wc -l
```

Expected: `--line` 10, `--line-strong` 7 (합 17 — Step 3 이전 총계와 같아야 한다).

`rgba(` 잔여도 확인:

```bash
grep -nE "rgba?\(" src/ui/styles.css | grep -v -- "--scrim"
```

Expected: 출력 없음 (`--scrim` 정의 한 줄 외에는 남지 않아야 한다).

- [ ] **Step 6: 게이트 실행 후 커밋**

```bash
bun run check && bun run typecheck && bun test
```

Expected: 셋 다 통과.

```bash
git add src/ui/styles.css
git commit -m "fix(ui): 다크 팔레트 대비 미달 4개 수정 + 토큰 분리"
```

---

### Task 3: 라이트 팔레트 + `data-theme` 구조

**Files:**
- Modify: `src/ui/styles.css` (토큰 블록 선택자 + 라이트 블록 신설)
- Modify: `src/ui/styles.test.ts` (라이트 블록 검증 + 대칭성)

**Interfaces:**
- Consumes: Task 2 의 `--line-strong` · `--scrim`
- Produces: `:root[data-theme='light']` 블록. Task 5 의 인라인 스크립트가 이 선택자를 활성화한다.

- [ ] **Step 1: 실패하는 테스트를 먼저 추가한다**

`src/ui/styles.test.ts` 의 `DARK_BLOCK_RE` 선언을 **조인다**. Task 1 에서는 현행 `:root {` 를 잡으려고 느슨하게 뒀지만, 이제 두 선택자 형태를 강제해야 한다.

```ts
/*
 * 다크 블록. `:root` 와 속성 선택자를 **둘 다** 요구한다 — index.html 의 인라인
 * 스크립트가 실행되지 못하면 data-theme 이 안 붙는데, 속성 선택자만 두면 토큰이 하나도
 * 적용되지 않아 페이지가 무스타일로 뜬다. 한쪽만 남기면 여기서 블록을 못 찾고 실패한다.
 * (폰트 전용 `:root { --mono; --sans }` 블록을 잘못 잡지 않으려는 목적도 겸한다.)
 */
const DARK_BLOCK_RE = /:root\s*,\s*:root\[data-theme=['"]dark['"]\]\s*\{([^}]*)\}/;

/** 라이트 토큰 블록. */
const LIGHT_BLOCK_RE = /:root\[data-theme=['"]light['"]\]\s*\{([^}]*)\}/;
```

> **느슨한 정규식을 그대로 두면 안 되는 이유** — Step 3 이 `:root { --mono; --sans }` 폰트 전용 블록을 파일 앞쪽에 만든다. `/:root\s*\{/` 는 그 블록을 먼저 잡아, 색 토큰이 하나도 없는 빈 결과로 통과해 버린다. 실제로 이 순서로 검증하다 걸린 함정이다.

파일 맨 아래 `describe('dark 팔레트 대비', ...)` 다음에 두 블록을 덧붙인다.

```ts
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
```

- [ ] **Step 2: 테스트를 실행해 실패를 확인한다**

Run: `bun test src/ui/styles.test.ts`

Expected: **FAIL** — 세 테스트 전부 `토큰 블록을 찾지 못했다` 로 걸린다. 다크는 아직 `:root {` 한 줄짜리라 조인 정규식에 안 맞고, 라이트 블록은 존재하지 않는다.

- [ ] **Step 3: 다크 블록 선택자를 바꾸고 라이트 블록을 추가한다**

`styles.css` 에서 Task 2 가 만든 블록의 선택자를 바꾼다. 색 토큰과 폰트 토큰을 분리하는 것이 핵심이다 — 폰트는 테마와 무관하므로 `:root` 에 그대로 둔다.

```css
/* 테마와 무관한 토큰 — 두 팔레트가 공유한다. */
:root {
  --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, monospace;
  --sans:
    -apple-system, BlinkMacSystemFont, "Segoe UI", "Apple SD Gothic Neo", "Pretendard", sans-serif;
}

/*
 * 다크가 기본이다. `:root` 를 함께 거는 이유: index.html 의 인라인 스크립트가 어떤
 * 이유로든(스크립트 차단 등) 실행되지 못하면 data-theme 이 붙지 않는데, 속성 선택자만
 * 두면 토큰이 하나도 적용되지 않아 페이지가 무스타일로 뜬다.
 */
:root,
:root[data-theme="dark"] {
  color-scheme: dark;
  --bg: #16110c;
  --surface: #1f1811;
  --surface-2: #282017;
  --text: #e9dfd2;
  --muted: #9c8d7c;
  /* 마이크로라벨 14곳의 색 — 옛 #6b5f51 은 최악 배경에서 대비 2.58 로 읽히지 않았다. */
  --faint: #978775;
  --warm: #e8a33d; /* 에이전트 / 에리디언 */
  /* .group-eyebrow 의 텍스트색이자 뱃지 테두리 — 텍스트로 쓰이므로 4.5 기준이다. */
  --warm-dim: #b08130;
  --cool: #7ec8d8; /* 사람 / 지구 */
  /* 테두리로만 쓰인다 — 기준 3.0. 여기에 4.5 를 강요하면 쿨 톤이 필요 이상 밝아진다. */
  --cool-dim: #4b7680;
  --p1: #e2634f;
  --p2: #e8a33d;
  --p3: #c8b45a;
  --ok: #86b06c;
  --handoff: #93c5fd; /* 핸드오프 — "보냈다"(파랑), doing 앰버(--warm)와 구분 */
  --handoff-dim: #1e3a5f;
  /* 구분선(장식)과 컨트롤 테두리(WCAG 1.4.11)는 요구 대비가 다르다 — 토큰을 나눈다. */
  --line: #6d563c;
  --line-strong: #876a4b;
  --scrim: rgba(10, 7, 4, 0.55);
}

/*
 * 라이트 — 배경이 순백이 아니라 웜 아이보리다. 순백 위에서는 앰버가 탁해져
 * "두 대기"(warm=에이전트 / cool=사람)의 온도 대비가 죽는다.
 */
:root[data-theme="light"] {
  color-scheme: light;
  --bg: #faf6f0;
  --surface: #ffffff;
  --surface-2: #f2ebe1;
  --text: #241c14;
  --muted: #6b5c4a;
  --faint: #756753;
  --warm: #6b4600;
  --warm-dim: #8b6019;
  --cool: #195564;
  --cool-dim: #52828d;
  --p1: #b3311c;
  --p2: #6b4600;
  --p3: #6f6215;
  --ok: #3f6b26;
  --handoff: #1f5aa8;
  --handoff-dim: #d3e4fb;
  --line: #b19979;
  --line-strong: #9a7e59;
  /* 배경이 밝아 스크림이 덜 진해도 드로어가 충분히 분리된다. */
  --scrim: rgba(36, 28, 20, 0.35);
}
```

> `color-scheme` 은 커스텀 프로퍼티가 아니라 일반 프로퍼티다 — `parseTokens` 의 `--` 접두사 정규식이 걸러내므로 테스트에는 영향이 없다.

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `bun test src/ui/styles.test.ts`

Expected: **PASS** — `3 pass, 0 fail` (다크 대비 · 라이트 대비 · 대칭성).

- [ ] **Step 5: 게이트 실행 후 커밋**

```bash
bun run check && bun run typecheck && bun test
```

```bash
git add src/ui/styles.css src/ui/styles.test.ts
git commit -m "feat(ui): 라이트 팔레트 + data-theme 토큰 구조"
```

---

### Task 4: `resolveTheme` 순수 함수

**Files:**
- Modify: `src/ui/lib.ts` (파일 끝에 추가)
- Test: `src/ui/lib.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces:
  - `export type ThemePref = 'auto' | 'dark' | 'light'`
  - `export type ResolvedTheme = 'dark' | 'light'`
  - `export const THEME_KEY = 'rocky-todo:theme'`
  - `export function readThemePref(stored: string | null): ThemePref`
  - `export function resolveTheme(pref: ThemePref, prefersLight: boolean): ResolvedTheme`

  Task 5 의 store 와 Task 6 의 TopBar 가 이 네 가지를 쓴다.

- [ ] **Step 1: 실패하는 테스트를 작성한다**

`src/ui/lib.test.ts` 맨 아래에 추가한다. 상단 `import { ... } from './lib'` 블록에 `readThemePref`, `resolveTheme`, `THEME_KEY` 를 알파벳 순서에 맞게 끼워 넣는다 (Biome 이 정렬을 강제한다).

```ts
describe('theme 해석', () => {
  test('명시 선택은 OS 설정을 무시한다', () => {
    expect(resolveTheme('dark', true)).toBe('dark');
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('light', false)).toBe('light');
  });

  test('auto 는 OS 설정을 따른다', () => {
    expect(resolveTheme('auto', true)).toBe('light');
    expect(resolveTheme('auto', false)).toBe('dark');
  });

  test('저장값이 없거나 알 수 없으면 auto 로 읽는다', () => {
    expect(readThemePref(null)).toBe('auto');
    expect(readThemePref('')).toBe('auto');
    expect(readThemePref('solarized')).toBe('auto');
    // 예전 버전이 남긴 값이나 손으로 고친 값이 화면을 깨뜨리면 안 된다.
    expect(readThemePref('DARK')).toBe('auto');
  });

  test('저장값이 유효하면 그대로 읽는다', () => {
    expect(readThemePref('auto')).toBe('auto');
    expect(readThemePref('dark')).toBe('dark');
    expect(readThemePref('light')).toBe('light');
  });

  test('THEME_KEY 는 actor 키와 충돌하지 않는다', () => {
    expect(THEME_KEY).toBe('rocky-todo:theme');
  });
});
```

- [ ] **Step 2: 테스트를 실행해 실패를 확인한다**

Run: `bun test src/ui/lib.test.ts`

Expected: **FAIL** — `resolveTheme`, `readThemePref`, `THEME_KEY` 를 `./lib` 에서 export 하지 않아 타입/런타임 에러.

- [ ] **Step 3: 최소 구현을 작성한다**

`src/ui/lib.ts` 파일 끝에 추가한다.

```ts
/** 사용자가 고른 테마 의도. `auto` 는 OS 설정을 따른다는 뜻이다. */
export type ThemePref = 'auto' | 'dark' | 'light';

/** 실제로 화면에 적용되는 테마 — `auto` 가 해석된 결과. */
export type ResolvedTheme = 'dark' | 'light';

/** 테마 선호를 담는 localStorage 키. */
export const THEME_KEY = 'rocky-todo:theme';

/**
 * localStorage 에서 읽은 원문을 테마 선호로 해석한다.
 * 알 수 없는 값은 전부 `auto` 다 — 손으로 고쳤거나 옛 버전이 남긴 값이 화면을 깨뜨리면
 * 안 된다.
 */
export function readThemePref(stored: string | null): ThemePref {
  return stored === 'dark' || stored === 'light' || stored === 'auto' ? stored : 'auto';
}

/**
 * 테마 선호와 OS 설정으로부터 실제 적용할 테마를 해석한다.
 *
 * **`src/ui/index.html` 의 인라인 스크립트가 같은 규칙을 손으로 복제하고 있다** — 그쪽은
 * 번들 전에 첫 페인트를 막고 실행돼야 해서 이 모듈을 import 할 수 없다. 한쪽을 고치면
 * 반드시 다른 쪽도 고쳐야 한다.
 */
export function resolveTheme(pref: ThemePref, prefersLight: boolean): ResolvedTheme {
  if (pref === 'auto') {
    return prefersLight ? 'light' : 'dark';
  }
  return pref;
}
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `bun test src/ui/lib.test.ts`

Expected: **PASS.**

- [ ] **Step 5: 게이트 실행 후 커밋**

```bash
bun run check && bun run typecheck && bun test
```

```bash
git add src/ui/lib.ts src/ui/lib.test.ts
git commit -m "feat(ui): resolveTheme — 테마 선호 해석 순수 함수"
```

---

### Task 5: 테마 적용 배선 — 인라인 스크립트 · store · OS 변경 구독

**Files:**
- Modify: `src/ui/index.html`
- Modify: `src/ui/store.ts` (`UiState` 인터페이스 + 초기 상태 + `setThemePref`)
- Modify: `src/ui/main.tsx` (`App` 의 `useEffect`)

**Interfaces:**
- Consumes: Task 4 의 `readThemePref` · `resolveTheme` · `THEME_KEY` · `ThemePref`, Task 3 의 `[data-theme]` 선택자
- Produces: store 의 `themePref: ThemePref` 와 `setThemePref(pref: ThemePref): void`. Task 6 의 TopBar 가 둘 다 쓴다.

- [ ] **Step 1: 인라인 블로킹 스크립트를 넣는다**

`src/ui/index.html` 의 `<link rel="icon" ... />` 다음, `</head>` 앞에 추가한다.

```html
    <script>
      // 첫 페인트 전에 data-theme 을 확정해 FOUC 를 막는다. 번들 전에 실행돼야 해서
      // src/ui/lib.ts 의 resolveTheme 을 import 할 수 없다 — 같은 규칙을 복제한 것이니
      // 한쪽을 고치면 반드시 다른 쪽도 고쳐야 한다.
      // localStorage 는 프라이빗 모드/차단 설정에서 던질 수 있다. 테마를 못 읽는 것이
      // 화면이 안 뜨는 것보다 낫다 — 기본 dark 로 떨어진다.
      try {
        var stored = localStorage.getItem("rocky-todo:theme");
        var pref = stored === "dark" || stored === "light" || stored === "auto" ? stored : "auto";
        document.documentElement.dataset.theme =
          pref === "auto"
            ? window.matchMedia("(prefers-color-scheme: light)").matches
              ? "light"
              : "dark"
            : pref;
      } catch (_) {
        document.documentElement.dataset.theme = "dark";
      }
    </script>
```

- [ ] **Step 2: store 에 테마 상태를 추가한다**

`src/ui/store.ts` 의 `import { markSeen, readSeen } from './lib';` 에 네 개를 더한다.

```ts
import {
  markSeen,
  readSeen,
  readThemePref,
  resolveTheme,
  THEME_KEY,
  type ThemePref,
} from './lib';
```

> 지정자 순서는 Biome 이 강제한다 — 위 순서가 맞지 않다고 나오면 `bun run fix` 를 돌려 정렬을 맡기면 된다.

`UiState` 인터페이스에서 `actor: string;` 아래에 추가한다.

```ts
  /**
   * 사용자가 고른 테마 의도 — 토글 UI 가 보여주는 값이다.
   *
   * 해석된 결과(`dark`/`light`)는 상태로 들고 있지 않다. 그 값을 필요로 하는 건 CSS 뿐이고
   * CSS 는 `<html data-theme>` 에서 직접 읽는다 — 스토어에 사본을 두면 DOM 과 어긋날 수
   * 있는 두 번째 진실 공급원만 생긴다.
   */
  themePref: ThemePref;
```

같은 인터페이스의 `setActor: (actor: string) => void;` 아래에 추가한다.

```ts
  /** 테마 선호를 저장하고 `<html data-theme>` 까지 갱신한다. */
  setThemePref: (pref: ThemePref) => void;
```

`create<UiState>` 초기 상태에서 `actor: localStorage.getItem(ACTOR_KEY) ?? 'logan',` 아래에 추가한다. 인라인 스크립트가 이미 `data-theme` 을 찍어뒀으므로 여기서 다시 해석하지 않는다.

```ts
  themePref: readThemePref(localStorage.getItem(THEME_KEY)),
```

`setActor` 구현 아래에 추가한다.

```ts
  setThemePref: (pref) => {
    localStorage.setItem(THEME_KEY, pref);
    // 해석은 여기서 한 번만 한다 — 이 값을 상태로 복제하지 않고 DOM 에만 반영한다.
    const prefersLight = window.matchMedia('(prefers-color-scheme: light)').matches;
    document.documentElement.dataset.theme = resolveTheme(pref, prefersLight);
    set({ themePref: pref });
  },
```

- [ ] **Step 3: OS 테마 변경을 구독한다**

`src/ui/main.tsx` 의 `App` 안, 기존 `useEffect` **다음에** 별도 effect 를 추가한다. 기존 effect 는 `[refetch, setConnected]` 에 의존하는데 테마는 그것과 수명이 다르므로 섞지 않는다.

컴포넌트 상단 훅 호출부(`const debounce = useRef(...)` 아래)에 추가:

```ts
  const themePref = useUiStore((s) => s.themePref);
  const setThemePref = useUiStore((s) => s.setThemePref);
```

기존 `useEffect(...)` 블록이 끝난 뒤(`}, [refetch, setConnected]);` 다음 줄)에 추가:

```ts
  useEffect(() => {
    // 저장값이 auto 일 때만 OS 를 따라간다 — 명시 선택은 OS 가 바뀌어도 유지돼야 한다.
    if (themePref !== 'auto') {
      return;
    }
    const query = window.matchMedia('(prefers-color-scheme: light)');
    // setThemePref('auto') 를 다시 부르면 해석이 새 OS 값으로 다시 돌아 data-theme 이
    // 갱신된다 — 해석 규칙이 store 한 곳에만 있게 된다.
    const onChange = () => setThemePref('auto');
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [themePref, setThemePref]);
```

- [ ] **Step 4: 게이트를 실행한다**

Run: `bun run check && bun run typecheck && bun test`

Expected: 셋 다 통과. 이 태스크는 DOM 배선이라 단위 테스트가 없다 — 검증은 Step 5 의 수동 확인이다.

- [ ] **Step 5: 브라우저에서 확인한다**

데몬을 띄운다:

```bash
bun run src/daemon.ts
```

> 이미 다른 데몬이 8636 을 잡고 있으면 `already running` 을 찍고 종료한다. 그때는 `bun bin/rocky-todo daemon stop` 후 다시 실행한다.

`http://127.0.0.1:8636` 을 열고 확인한다:

1. 페이지가 정상 렌더된다 (무스타일 아님)
2. DevTools 콘솔에서 `document.documentElement.dataset.theme` → `'dark'` 또는 `'light'` (OS 설정에 따라)
3. 콘솔에서 아래를 실행하면 **새로고침 없이** 즉시 라이트로 바뀐다:

```js
document.documentElement.dataset.theme = 'light'
```

4. 라이트 상태에서 확인 — 드로어를 열었을 때 스크림이 뒤를 덮는지, `doing` 뱃지의 warm/cool 테두리가 구분되는지, 아카이브 행의 흐림 처리가 남아 있는지
5. 다시 `'dark'` 로 돌려 원래대로 보이는지

확인 후 데몬을 종료한다 (`Ctrl-C`).

- [ ] **Step 6: 커밋**

```bash
git add src/ui/index.html src/ui/store.ts src/ui/main.tsx
git commit -m "feat(ui): data-theme 배선 — 인라인 해석 + store + OS 변경 추종"
```

---

### Task 6: TopBar 3상 테마 토글

**Files:**
- Modify: `src/ui/components/TopBar.tsx`
- Modify: `src/ui/styles.css` (`.theme-toggle` 규칙 추가)

**Interfaces:**
- Consumes: Task 5 의 store `themePref` · `setThemePref`, Task 4 의 `ThemePref`
- Produces: 없음 (마지막 UI 태스크)

- [ ] **Step 1: 토글을 추가한다**

`src/ui/components/TopBar.tsx` 의 import 를 바꾼다.

```ts
import { useState } from 'react';
import type { ThemePref } from '../lib';
import { useUiStore } from '../store';
```

`TopBar` 함수 안, `const [draft, setDraft] = useState(actor);` 위에 추가한다.

```ts
  const themePref = useUiStore((s) => s.themePref);
  const setThemePref = useUiStore((s) => s.setThemePref);
```

컴포넌트 **바깥**(파일 상단, `export function TopBar` 위)에 순환 표와 라벨을 둔다. 렌더마다 새로 만들 이유가 없다.

```ts
/** 토글 순환 — auto 에서 시작해 명시 선택을 거쳐 다시 auto 로 돌아온다. */
const THEME_CYCLE: Record<ThemePref, ThemePref> = {
  auto: 'dark',
  dark: 'light',
  light: 'auto',
};

const THEME_GLYPH: Record<ThemePref, string> = {
  auto: '◐',
  dark: '●',
  light: '○',
};

const THEME_LABEL: Record<ThemePref, string> = {
  auto: '시스템 설정 따름',
  dark: '어두운 테마',
  light: '밝은 테마',
};
```

`<div className="topbar-spacer" />` 다음, `<label className="archived-toggle">` **앞에** 버튼을 넣는다.

```tsx
      <button
        type="button"
        className="theme-toggle"
        title={`테마 — ${THEME_LABEL[themePref]} (눌러서 ${THEME_LABEL[THEME_CYCLE[themePref]]})`}
        aria-label={`테마 — 현재 ${THEME_LABEL[themePref]}. 눌러서 ${THEME_LABEL[THEME_CYCLE[themePref]]}`}
        onClick={() => setThemePref(THEME_CYCLE[themePref])}
      >
        {THEME_GLYPH[themePref]}
      </button>
```

- [ ] **Step 2: 스타일을 추가한다**

`src/ui/styles.css` 의 `.archived-toggle` 규칙 **앞에** 추가한다.

```css
.theme-toggle {
  font-family: var(--mono);
  font-size: 13px;
  color: var(--muted);
  /* 모바일 터치 타깃 — 백로그 rocky-todo#1 과 같은 44px 방침. */
  min-width: 44px;
  min-height: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.theme-toggle:hover {
  color: var(--text);
}
```

- [ ] **Step 3: 게이트를 실행한다**

Run: `bun run check && bun run typecheck && bun test`

Expected: 셋 다 통과.

- [ ] **Step 4: 브라우저에서 확인한다**

```bash
bun run src/daemon.ts
```

`http://127.0.0.1:8636` 에서:

1. 상단 바에 글리프가 보인다 (`◐` / `●` / `○` 중 하나)
2. 세 번 누르면 `auto → dark → light → auto` 로 돌아온다
3. **라이트 상태에서 새로고침** — 라이트로 남아 있어야 한다 (localStorage 저장 확인). 새로고침 순간 어두운 화면이 번쩍이면 안 된다 (FOUC 없음)
4. `auto` 로 되돌린 뒤 OS 테마를 바꾸면 새로고침 없이 따라온다
5. 키보드 `Tab` 으로 버튼에 포커스가 가고 포커스 링이 보인다

데몬을 종료한다 (`Ctrl-C`).

- [ ] **Step 5: 커밋**

```bash
git add src/ui/components/TopBar.tsx src/ui/styles.css
git commit -m "feat(ui): 상단 바 테마 토글 (auto/dark/light)"
```

---

### Task 7: 마이크로라벨 폰트 하한 11px

**Files:**
- Modify: `src/ui/styles.css` (9곳)

**Interfaces:**
- Consumes: 없음
- Produces: 없음

- [ ] **Step 1: 대상을 확인한다**

Run:

```bash
grep -n "font-size: 10px" src/ui/styles.css
```

Expected: 9줄. 각각 아래 선택자에 속한다 — `.link-status` · `.sidebar-label` · `.group-eyebrow` · `.chip` · `.doing-badge` · `.note-meta` · `.drawer-id` · `.drawer-section-label` · `.history-at`

> 이미 11px 인 두 곳(`.todo-check:checked::after` 의 `✓`, `.handoff-*`)은 대상이 아니다.

- [ ] **Step 2: 일괄 치환한다**

`styles.css` 에서 `font-size: 10px;` 아홉 곳을 전부 `font-size: 11px;` 로 바꾼다. `10px` 이 폰트 크기 아닌 곳(padding 등)에 쓰였을 수 있으므로 `font-size: 10px` 전체를 매칭해야 한다.

```bash
grep -c "font-size: 10px" src/ui/styles.css
```

치환 후 이 값이 `0` 이어야 한다.

- [ ] **Step 3: 마이크로라벨 자간은 그대로 두는지 확인한다**

Run:

```bash
grep -n "letter-spacing" src/ui/styles.css
```

Expected: 값이 하나도 바뀌지 않았다. 대문자 mono 라벨에서 넓은 자간은 글자 구분을 도우므로 유지한다 — 크기만 올린다.

- [ ] **Step 4: 게이트를 실행한다**

Run: `bun run check && bun run typecheck && bun test`

Expected: 셋 다 통과. 대비 테스트는 폰트 크기와 무관하므로 계속 그린이다.

- [ ] **Step 5: 브라우저에서 레이아웃이 깨지지 않았는지 확인한다**

```bash
bun run src/daemon.ts
```

`http://127.0.0.1:8636` 에서 확인 — 상단 바의 `LINK ♪` 가 잘리지 않는지, todo 행의 메타 칩이 한 줄에 남는지, 드로어의 섹션 라벨이 겹치지 않는지. DevTools 반응형 모드에서 폭 390px(iPhone)로도 본다.

데몬을 종료한다 (`Ctrl-C`).

- [ ] **Step 6: 커밋**

```bash
git add src/ui/styles.css
git commit -m "fix(ui): 마이크로라벨 폰트 하한 11px"
```

---

### Task 8: 문서 동기화 + changeset

**Files:**
- Modify: `FEATURES.md`
- Modify: `docs/rocky-todo.md`
- Create: `.changeset/<자동 생성 이름>.md`

**Interfaces:**
- Consumes: Task 1–7 의 전체 결과
- Produces: 없음

> `AGENTS.md` 는 수정하지 않는다 — 레이아웃·코딩 규칙·데몬 모델이 바뀌지 않았고, 새 env var 도 없다. 변경 체크리스트 4·5·6·7 중 해당하는 것은 4(사용자 표면)와 8(changeset)뿐이다.

- [ ] **Step 1: 웹 UI 설명 위치를 찾는다**

Run:

```bash
grep -n "웹 UI" FEATURES.md docs/rocky-todo.md | head -20
```

- [ ] **Step 2: `FEATURES.md` 에 테마 토글을 적는다**

찾은 웹 UI 절에 한 줄 추가한다. 주변 문서의 서술 톤과 목록 스타일을 따를 것.

```markdown
- **테마** — 상단 바 토글로 `auto`(시스템 설정) / 어두움 / 밝음 순환. 선택은 브라우저에
  저장된다. 팔레트는 두 테마 모두 WCAG AA 대비를 만족한다.
```

- [ ] **Step 3: `docs/rocky-todo.md` 에도 같은 내용을 적는다**

운영 문서의 웹 UI 절에 같은 취지를 그 문서의 톤으로 넣는다. 두 문서가 서로를 베낀 문장이 되지 않게, `docs/rocky-todo.md` 는 사용자가 실제로 뭘 누르는지를 쓴다.

```markdown
### 테마

상단 바 오른쪽의 글리프(`◐` / `●` / `○`)를 누르면 테마가 `auto → 어두움 → 밝음 → auto`
순으로 바뀐다. `auto` 는 OS 설정을 따르고, OS 설정이 바뀌면 새로고침 없이 따라온다.
명시적으로 고른 테마는 OS 설정과 무관하게 유지된다.
```

- [ ] **Step 4: changeset 을 만든다**

Run: `bunx changeset`

- 패키지: `@minjun0219/rocky-todo`
- 범프: **patch** — 대비 수정이 주된 내용이고 테마 토글은 작은 부가 기능이다
- 요약:

```
웹 UI 가시성 개선 — WCAG 미달 색 4개 리튠, 마이크로라벨 11px 하한, 라이트 모드 추가
```

- [ ] **Step 5: 게이트를 실행한다**

Run: `bun run check && bun run typecheck && bun test`

Expected: 셋 다 통과.

- [ ] **Step 6: 커밋**

```bash
git add FEATURES.md docs/rocky-todo.md .changeset
git commit -m "docs(ui): 테마 토글 문서화 + changeset"
```

---

## 완료 확인

전체 작업 후 아래를 실행해 최종 상태를 확인한다.

```bash
bun run check && bun run typecheck && bun test
```

Expected: 전부 통과. `bun test` 출력에 `src/ui/styles.test.ts` 의 3개 테스트(다크 대비 · 라이트 대비 · 대칭성)와 `src/ui/lib.test.ts` 의 theme 해석 5개가 포함돼야 한다.

```bash
git log --oneline -8
```

Expected: Task 1–8 의 커밋 8개.

보드 항목을 닫는다 — `rocky-todo#21`.
