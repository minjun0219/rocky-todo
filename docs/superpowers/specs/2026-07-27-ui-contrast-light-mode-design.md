# 웹 UI 대비 리튠 + 라이트 모드

- 날짜: 2026-07-27
- 상태: 설계 승인됨
- 보드 항목: `rocky-todo#21`
- 대상: `src/ui/styles.css` · `src/ui/index.html` · `src/ui/store.ts` · `src/ui/lib.ts` ·
  `src/ui/components/TopBar.tsx` (+ `src/ui/lib.test.ts` · `src/ui/styles.test.ts` 신규)

## 문제

웹 UI 의 가시성이 떨어진다. 원인을 측정했다 — 현재 팔레트의 WCAG 대비비(최악 배경
`--surface-2` #282017 기준):

| 토큰 | 값 | vs `--bg` | vs `--surface-2` | 판정 | 사용처 |
| --- | --- | --- | --- | --- | --- |
| `--line` | `#382c1f` | 1.38 | 1.18 | ✗ | 경계선 17곳 |
| `--cool-dim` | `#47707a` | 3.45 | 2.95 | ✗ | 사람 톤 뱃지 |
| `--faint` | `#6b5f51` | 3.02 | 2.58 | ✗ | 마이크로라벨 14곳 |
| `--warm-dim` | `#8a6526` | 3.55 | 3.03 | △ | 큰 글씨만 통과 |

나머지 토큰(`--text` 14.25, `--warm` 8.70, `--cool` 9.95 등)은 넉넉히 통과한다. 문제는
**어두운 쪽 네 개**에 몰려 있다.

여기에 두 번째 원인이 겹친다: **10px 이하 폰트가 11곳**이고, 그 대부분이 위 표의 미달색을
쓰는 마이크로라벨이다. 작은 글씨 × 최저 대비색이 같은 자리에서 만나 가시성 불만을 만든다.

`--line` 이 특히 나쁘다. 1.38 은 배경과 사실상 구별되지 않아, 패널·행 구분이 있는데도 안
보인다. 레이아웃이 뭉개져 보이는 인상의 주범이다.

## 목표 / 비목표

**목표** — "두 대기(Two Atmospheres)" 정체성(앰버 = 에이전트가 한 일, 쿨블루 = 사람이 한 일)을
그대로 둔 채 읽히게 만든다. 사용자는 톤 자체는 마음에 든다고 명시했다. 색상(hue)과 채도는
고정하고 **명도만** 움직인다. 여기에 라이트 모드를 더해 밝은 환경/모바일 사용성을 확보한다.

**비목표 (명시적 범위 밖)**

- Tailwind CSS · shadcn/ui 도입. 검토했고 이번엔 안 한다 — 아래 "왜 Tailwind/shadcn 이
  아닌가" 참고
- `DetailDrawer.tsx`(768줄) 분해
- 레이아웃·정보구조 변경, 컴포넌트 재배치

## 왜 Tailwind/shadcn 이 아닌가

이 작업은 Tailwind + shadcn 도입 논의에서 출발했다. 두 가지가 이번 범위를 가른다.

**1. shadcn 은 이 문제를 안 고친다.** shadcn 은 토큰 *구조*(`--background`/`--primary`/…)를
주지 토큰 *값*은 여전히 우리가 정한다. 지금 팔레트를 그대로 옮기면 대비 미달도 그대로
따라온다. 즉 팔레트 리튠은 Tailwind 도입 여부와 무관하게 **선행되어야 하는 작업**이다.

**2. 런타임 번들 구조라 의존성이 전량 사용자에게 배포된다.** `src/daemon.ts:3` 의
`import ui from './ui/index.html'` 이 서빙 시점에 번들하므로 빌드 스텝이 없다. 그래서
Tailwind 는 devDependency 가 아니라 **prod dependency** 여야 하고, 모든 사용자의 플러그인
캐시에 설치된다. 실측(`bun add`):

- `bun-plugin-tailwind` **26M** (oxide 네이티브 바이너리) — 필수
- `lucide-react` **40M** — 선택 (현재 이모지 사용 중이라 없어도 됨)
- `@radix-ui/*` 6종 2.8M + `class-variance-authority`/`clsx`/`tailwind-merge` — 가벼움

`AGENTS.md` 의 "신규 런타임 dep 은 별도 논의" 방침상, 이 비용은 리튠 결과를 확인한 뒤
독립적으로 판단한다.

**도입 시 알려진 함정 (다음 spec 을 위해 기록)** — `src/daemon.ts:63` 이
`process.chdir(join(import.meta.dir, 'ui'))` 를 `Bun.serve` 전에 실행한다. Bun 은 `bunfig.toml`
을 cwd 기준으로 찾으므로, Tailwind 플러그인 등록용 `bunfig.toml` 은 레포 루트가 아니라
**`src/ui/`** 에 놓아야 한다.

## 발견: CSS 가 이미 토큰화돼 있다

`styles.css` 1113줄 / 클래스 100개인데, `:root` 블록 **밖의 하드코딩 색은 단 1곳**이다 —
571행 드로어 스크림 `rgba(10, 7, 4, 0.55)`. `box-shadow` 도 1곳뿐.

덕분에 라이트 모드 추가가 예상보다 싸다. 토큰 블록 하나를 더하고, 저 1곳을 토큰으로
승격하면 끝난다. 컴포넌트 6개는 색 때문에 손댈 일이 없다 (테마 토글 UI 를 붙이는
`TopBar.tsx` 만 예외).

## 설계

### 1. 토큰 구조 — `--line` 을 둘로 쪼갠다

현재 `--line` 하나가 17곳을 담당하는데, 두 종류의 쓰임이 섞여 있다. 요구 대비가 다르다.

| 토큰 | 용도 | 기준 |
| --- | --- | --- |
| `--line` | 패널·행 구분선 (장식적 구분) | ≥ 2.2 |
| `--line-strong` | input · checkbox · 버튼 테두리 | ≥ 3.0 (WCAG 1.4.11 비텍스트 대비) |

`--line` 에 3.0 을 강요하면 구분선이 사나워진다. 장식적 구분선은 WCAG 1.4.11 적용 대상이
아니므로 2.2 로 두어 "보이되 튀지 않게" 한다. 반면 사용자가 조작하는 컨트롤의 경계는
1.4.11 대상이라 3.0 을 지킨다.

**신규 토큰**

- `--line-strong` — 위 표
- `--scrim` — 571행 하드코딩을 승격. 라이트에서 값이 달라야 한다

`--scrim` 값: 다크 `rgba(10, 7, 4, 0.55)` (현행 유지) / 라이트 `rgba(36, 28, 20, 0.35)`.
라이트에서는 배경이 밝아 스크림이 덜 진해도 드로어가 충분히 분리된다.

### 2. 다크 팔레트 (리튠)

hue·채도 고정, 명도만 이분탐색으로 조정해 기준을 만족하는 **최소 변화** 값을 취했다.

선택자가 `:root` 와 `:root[data-theme='dark']` **둘 다**인 점이 중요하다. 인라인 스크립트가
어떤 이유로든 실행되지 못하면 `data-theme` 이 안 붙는데, `[data-theme='dark']` 만 있으면
토큰이 하나도 적용되지 않아 페이지가 무스타일로 뜬다. 다크를 `:root` 기본값으로도 두어
막는다 — 라이트는 속성이 명시될 때만 이긴다.

폰트 토큰 `--mono` / `--sans` 는 테마와 무관하므로 별도 `:root` 블록에 그대로 남긴다.

```css
:root,
:root[data-theme='dark'] {
  --bg: #16110c;          /* 유지 */
  --surface: #211a13;     /* ← #1f1811 */
  --surface-2: #2c2419;   /* ← #282017 */
  --text: #f0e7db;        /* ← #e9dfd2 */
  --muted: #b5a695;       /* ← #9c8d7c */
  --faint: #958a7a;       /* ← #6b5f51  대비 3.02 → 4.50 */
  --warm: #f0b455;        /* ← #e8a33d */
  --warm-dim: #c08a34;    /* ← #8a6526  대비 3.55 → 5.04 */
  --cool: #8fd4e4;        /* ← #7ec8d8 */
  --cool-dim: #6ba3b2;    /* ← #47707a  대비 3.45 → 5.47 */
  --p1: #f0806b;          /* ← #e2634f */
  --p2: #f0b455;          /* ← #e8a33d */
  --p3: #d4c268;          /* ← #c8b45a */
  --ok: #95c079;          /* ← #86b06c */
  --handoff: #a8cfff;     /* ← #93c5fd */
  --handoff-dim: #1e3a5f; /* 유지 — 배경 전용, 텍스트 아님 */
  --line: #6c563d;        /* ← #382c1f  대비 1.38 → 2.20 */
  --line-strong: #886d4e; /* 신규 — 3.00 */
  --scrim: rgba(10, 7, 4, 0.55);
}
```

### 3. 라이트 팔레트 (신규)

배경은 순백이 아니라 **웜 아이보리**다. 순백 위에서는 앰버가 탁해지고 두 대기의 온도
대비가 죽는다. `#faf6f0` 은 앰버 계열을 살리면서 눈부심을 줄인다.

```css
:root[data-theme='light'] {
  --bg: #faf6f0;
  --surface: #ffffff;
  --surface-2: #f2ebe1;
  --text: #241c14;
  --muted: #6b5c4a;
  --faint: #776954;
  --warm: #8a5a00;
  --warm-dim: #8b6019;
  --cool: #1f6b7d;
  --cool-dim: #377382;
  --p1: #b3311c;
  --p2: #8a5a00;
  --p3: #6f6215;
  --ok: #3f6b26;
  --handoff: #1f5aa8;
  --handoff-dim: #d3e4fb; /* .chip-handoff 배경 — 다크의 대응값을 반전 */
  --line: #b49d7e;
  --line-strong: #a0835c;
  --scrim: rgba(36, 28, 20, 0.35);
}
```

**검증 결과** — 두 테마 전 토큰이 기준을 통과한다. 텍스트 토큰 ≥ 4.5, `--line` ≥ 2.2,
`--line-strong` ≥ 3.0, 각 테마의 세 배경(`--bg` / `--surface` / `--surface-2`) 중
**최악값** 기준.

**세 배경 말고도 검사해야 하는 쌍이 둘 있다.** `styles.css` 를 훑어 배경 토큰 위에 전경
토큰이 직접 얹히는 자리를 찾았다:

| 자리 | 전경 on 배경 | 다크 | 라이트 |
| --- | --- | --- | --- |
| `.chip-handoff` (396–397행) | `--handoff` on `--handoff-dim` | 7.14 ✓ | 5.27 ✓ |
| `.todo-check:checked::after` ✓ (301·307행) | `--bg` on `--ok` | 9.02 ✓ | 5.84 ✓ |

즉 `--handoff-dim` 은 "배경 전용이라 검사 제외" 가 아니라 **`--handoff` 와의 쌍으로**
검사한다. `--ok` 도 배경으로 쓰일 때는 `--bg` 와 쌍을 이룬다. 아래 회귀 테스트가 이 두
쌍을 명시적으로 포함한다.

구현 중 `--line` 이 탁해 보이면 채도만 낮추되, 회귀 테스트가 2.2 하한을 지켜준다.

### 4. 테마 전환 — `auto` 해석은 JS 가 맡는다

CSS 만으로 "OS 자동 + 수동 토글" 을 하려면 라이트 토큰 블록을
`@media (prefers-color-scheme: light) :root:not([data-theme='dark'])` 와
`:root[data-theme='light']` 두 곳에 **복제**해야 한다. 20줄짜리 팔레트가 두 벌이 되면
한쪽만 고치는 사고가 난다.

대신 `auto` 를 JS 가 해석해 `<html>` 에 항상 구체적인 값을 찍는다. CSS 에는 토큰 블록이
정확히 두 개만 존재한다.

**`src/ui/index.html` `<head>` 인라인 블로킹 스크립트** — 첫 페인트 전에 실행되어 FOUC 이
없다. 번들러가 인라인 스크립트를 그대로 통과시키므로 별도 설정이 필요 없다.

```js
// localStorage 를 못 읽는 환경(프라이빗 모드 등)에서도 화면은 떠야 한다 → try/catch, 기본 dark
try {
  var stored = localStorage.getItem('rocky-todo:theme'); // 'auto' | 'dark' | 'light' | null
  var resolved =
    stored === 'dark' || stored === 'light'
      ? stored
      : matchMedia('(prefers-color-scheme: light)').matches
        ? 'light'
        : 'dark';
  document.documentElement.dataset.theme = resolved;
} catch (_) {
  document.documentElement.dataset.theme = 'dark';
}
```

**`color-scheme`** — 각 토큰 블록에 `color-scheme: dark` / `light` 를 함께 선언한다.
스크롤바·기본 폼 컨트롤·`::selection` 이 테마를 따라간다.

**OS 테마 변경 추종** — 저장값이 `auto` 일 때만, `matchMedia('(prefers-color-scheme: light)')`
의 `change` 리스너가 `data-theme` 을 갱신한다. `main.tsx` 의 `useEffect` 에서 구독하고
언마운트 시 해제.

**store** — 기존 `actor` 의 localStorage 패턴을 그대로 따른다.

```ts
type ThemePref = 'auto' | 'dark' | 'light';
// 상태: themePref (사용자 의도) + resolvedTheme ('dark' | 'light', 실제 적용값)
// setThemePref(pref) → localStorage 저장 + resolvedTheme 재계산 + <html data-theme> 갱신
```

`themePref` 와 `resolvedTheme` 을 분리하는 이유: 토글 UI 는 사용자 의도(`auto` 포함)를
보여줘야 하고, 렌더링은 해석된 값을 써야 한다. 하나로 합치면 `auto` 선택 상태가 사라진다.

**TopBar 토글** — 3상 순환 `auto → dark → light → auto`. 현재 `themePref` 에 따라
아이콘(`◐` / `●` / `○`)과 `aria-label` 이 바뀐다. 기존 `.link-status` 옆, 마이크로라벨과
같은 톤으로 배치한다.

### 5. 타이포 하한 11px

10px 이하 11곳을 **11px 로 올린다**. 마이크로라벨의 `letter-spacing: 0.18em` 은 유지한다 —
대문자 mono 에서는 자간이 넓을수록 글자 구분이 쉬워 가독성에 도움이 된다.

이것이 가시성 불만의 나머지 절반이다. 색만 고치고 크기를 두면 체감이 절반만 온다.

### 6. 검증

**단위 테스트 — `src/ui/lib.ts` 의 순수 함수**

```ts
/** 저장된 테마 선호와 OS 설정으로부터 실제 적용할 테마를 해석한다. */
export function resolveTheme(stored: string | null, prefersLight: boolean): 'dark' | 'light';
```

`lib.test.ts` 에 케이스 추가: `'dark'`/`'light'` 는 OS 무시하고 그대로, `'auto'`·`null`·
알 수 없는 값은 `prefersLight` 를 따름.

인라인 스크립트는 이 함수와 같은 규칙을 손으로 복제한 것이다 (번들 전에 실행돼야 해서
import 할 수 없다). 두 곳이 어긋나지 않도록 양쪽에 서로를 가리키는 주석을 단다.

**대비 회귀 테스트 — `src/ui/styles.test.ts` (신규)**

`styles.css` 를 읽어 다크 블록(`:root, :root[data-theme='dark']`) / 라이트 블록
(`:root[data-theme='light']`) 의 토큰을 파싱하고, 각 테마의 세 배경 대비 최악값을 계산해
기준 미달이면 실패한다.

- 텍스트 토큰(`--text` `--muted` `--faint` `--warm` `--warm-dim` `--cool` `--cool-dim`
  `--p1` `--p2` `--p3` `--ok` `--handoff`) ≥ 4.5
- `--line` ≥ 2.2 / `--line-strong` ≥ 3.0
- **명시 쌍** ≥ 4.5 — `--handoff` on `--handoff-dim`, `--bg` on `--ok`
- 제외: `--scrim`(알파 있어 합성 결과가 배경에 의존) · 배경 토큰 자신
- 두 테마가 **동일한 토큰 집합**을 정의하는지도 확인 — 한쪽에만 추가하는 사고를 막는다

이 테스트가 이번 작업의 결과를 잠근다. 앞으로 누가 색을 만지든 대비는 깨지지 않는다.

**게이트** — `bun run check` · `bun run typecheck` · `bun test` 전부 통과.

**수동 확인** — 데몬을 띄워 다크/라이트/auto 세 상태를 눈으로 본다. 특히 드로어 스크림,
`doing-badge` 의 warm/cool 구분, 아카이브된 행의 흐림 처리.

## 변경 파일

| 파일 | 변경 |
| --- | --- |
| `src/ui/styles.css` | `:root` → `[data-theme='dark']`/`[data-theme='light']` 두 블록. 571행 스크림 토큰화. `--line-strong` 도입처 분류(input·checkbox·버튼). 10px 이하 11곳 → 11px |
| `src/ui/index.html` | `<head>` 인라인 테마 스크립트 |
| `src/ui/lib.ts` | `resolveTheme` 추가 |
| `src/ui/store.ts` | `themePref` / `resolvedTheme` 상태 + `setThemePref` |
| `src/ui/main.tsx` | `auto` 일 때 `matchMedia` change 구독 |
| `src/ui/components/TopBar.tsx` | 3상 테마 토글 |
| `src/ui/lib.test.ts` | `resolveTheme` 테스트 |
| `src/ui/styles.test.ts` | 신규 — 대비 회귀 테스트 |

## 문서 동기화

사용자 표면(웹 UI 에 테마 토글 추가)이 바뀌므로 `AGENTS.md` 체크리스트 4·8 에 따라:

- `FEATURES.md` — 웹 UI 설명에 테마 토글 한 줄
- `docs/rocky-todo.md` — 동일
- `bunx changeset` — patch (버그 수정 성격의 대비 개선 + 작은 기능 추가)

`AGENTS.md` 자체는 레이아웃·규칙이 안 바뀌므로 수정 없음.
