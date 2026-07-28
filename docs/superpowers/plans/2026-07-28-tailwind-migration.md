# Tailwind 마이그레이션 (시각 동결) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 웹 UI 의 시각 결과물을 동결한 채, 스타일링 구현을 손 CSS 1278줄에서 Tailwind v4 유틸리티로 옮기고, 드로어에만 Radix Dialog 를 도입한다.

**Architecture:** 데몬의 UI 서빙을 런타임 HTML import 에서 **시작 시 `Bun.build()` 번들 + 정적 서빙**으로 바꾼다 — 스파이크로 확인한 결과 `bunfig.toml [serve.static]` 경로에서는 Tailwind 플러그인의 클래스 스캔이 동작하지 않고(유틸 0개), `Bun.build()` 에 plugins 를 명시하면 전부 동작한다. Tailwind 는 preflight 없이(theme+utilities 레이어만) 들어와 기존 수제 리셋과 토큰 블록을 보존한다. 컴포넌트별로 클래스를 치환하며 `styles.css` 를 줄여 간다.

**Tech Stack:** Bun 1.3.11+ · Tailwind CSS v4 · bun-plugin-tailwind · @radix-ui/react-dialog · React 19

## Global Constraints

- **기준 화면**: 이 브랜치(`feat/ui-contrast-light-mode`) 현재 시점의 웹 UI. **마이그레이션 전후 화면이 다르면 버그다**
- **게이트**: 매 커밋 전 `bun run check` · `bun run typecheck` · **`bun run test`** (맨 `bun test` 아님 — `.test.tsx` 가 preload 없이 터진다)
- **커밋 메시지**: Conventional Commits — `type(scope): 한국어 요약` (50자 내외)
- **신규 prod deps 는 정확히 셋**: `tailwindcss@^4` · `bun-plugin-tailwind@^0.0.15` · `@radix-ui/react-dialog@^1`. 그 외(cva, tailwind-merge, clsx, lucide 등) 추가 금지
- **`src/ui/styles.test.ts` 는 끝까지 산다** — 토큰 블록·대비 기준을 파싱한다. 토큰 블록(`:root, :root[data-theme="dark"]` / `:root[data-theme="light"]`)의 형태를 바꾸지 말 것
- **preflight 금지** — `@import "tailwindcss"` 전체를 쓰지 않는다. 아래 검증된 헤더만:
  ```css
  @layer theme, base, components, utilities;
  @import "tailwindcss/theme.css" layer(theme);
  @import "tailwindcss/utilities.css" layer(utilities);
  ```
  (스파이크 검증: 이 형태에서 유틸·`var()` 참조·`color-mix` 임의값 전부 생성되고 요소 리셋은 안 들어온다)
- **시맨틱 마커 클래스는 남긴다** — 컴포넌트 루트와 상태 클래스(`todo-row`, `is-done`, `is-archived`, `tone-warm` …)는 유틸과 병기한다 (`className="todo-row relative flex …"`). 테스트·상태 스타일링·가독성의 앵커다
- **인라인 테마 스크립트(`index.html`)와 `resolveTheme` 배선은 손대지 않는다**
- **한국어 주석 OK**, 코드 식별자·경로·명령은 영어 원형

### 유틸 변환 레시피 (스파이크 검증된 문법)

| 기존 CSS | Tailwind v4 |
| --- | --- |
| `color: var(--warm)` | `text-(--warm)` |
| `background: var(--surface)` | `bg-(--surface)` |
| `border: 1px solid var(--line)` | `border border-(--line)` |
| `background: color-mix(in srgb, currentColor 10%, transparent)` | `bg-[color-mix(in_srgb,currentColor_10%,transparent)]` |
| `font-family: var(--mono)` | `font-(family-name:--mono)` |
| `font-size: 11px` | `text-[11px]` |
| `letter-spacing: 0.22em` | `tracking-[0.22em]` |
| `border-radius: 999px` | `rounded-full` |
| `min-height: 32px` | `min-h-8` (4px 그리드 배수) / 아니면 `min-h-[32px]` |
| `@media (max-width: 900px)` | `max-[900px]:` variant |
| hover | `hover:` |
| `:root[data-theme=…]` 토큰 오버라이드 | CSS 에 그대로 남긴다 (토큰이 값을 바꾸므로 유틸은 한 벌) |

**끝까지 CSS 로 남는 것**: 토큰 블록 2개, `--mono`/`--sans` 정의, 수제 리셋(`*`, `button`, `input`), `:focus-visible`, `@keyframes pulse`, `.todo-title::after`(stretched-link — 유틸로 표현하면 임의값 지옥이라 CSS 유지), `.todo-check` 의 `appearance:none` 체크 표시(`::after content`), `.md-line` 마크다운 렌더 스타일. 이들은 마지막에 `styles.css` 에 정리된 형태로 존치한다.

### 태스크 공통 검증 절차 (치환 태스크 3~7)

1. 대상 컴포넌트의 CSS 규칙을 전부 유틸로 옮기고 `styles.css` 에서 해당 절 삭제
2. 규칙 하나라도 표현 불가면 **그 규칙만 CSS 에 남기고 이유를 주석으로** (임의 삭제 금지)
3. `bun run check && bun run typecheck && bun run test`
4. 리포트에 **변환 매핑표**(기존 셀렉터 → 적용한 유틸 문자열)를 남긴다 — 컨트롤러가 이 표로 시각 diff 를 돌린다
5. 커밋

시각 diff 자체(두 테마 × 390px/1280px computed style 비교)는 **컨트롤러가 태스크 리뷰 시점에 오르카 브라우저로 수행**한다 — 서브에이전트는 브라우저가 없다.

---

## File Structure

| 파일 | 변화 |
| --- | --- |
| `src/daemon.ts` | HTML import 제거 → `buildUi()` 호출 + 정적 서빙 |
| `src/ui/build.ts` (신규) | `Bun.build` 래퍼 — 번들 생성, 출력 경로 반환 |
| `src/ui/build.test.ts` (신규) | 번들 산출물 검증 (유틸 생성 포함) |
| `src/ui/styles.css` | 헤더에 layer import 추가 → 태스크마다 절 삭제 → 최종 ~200줄 |
| `src/ui/components/*.tsx` | 클래스 치환 (마커 + 유틸 병기) |
| `src/ui/components/DetailDrawer.tsx` | Radix Dialog 전환 + 파일 분해 |
| `package.json` | deps 3종 |

---

### Task 1: 데몬 서빙 전환 — 시작 시 번들 + 정적 서빙

**Files:**
- Create: `src/ui/build.ts`, `src/ui/build.test.ts`
- Modify: `src/daemon.ts` (HTML import·chdir 제거, 라우팅 교체)

**Interfaces:**
- Produces: `buildUi(outdir: string): Promise<void>` — `src/ui/index.html` 을 `outdir` 로 번들. Task 2 가 이 함수에 Tailwind 플러그인을 더한다
- Produces: daemon 의 정적 서빙 — `/` 및 미지정 경로는 `outdir/index.html`, `/chunk-*` 등 자산은 파일 그대로

- [ ] **Step 1: 실패하는 테스트**

`src/ui/build.test.ts`:

```ts
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'bun:test';
import { buildUi } from './build';

describe('buildUi', () => {
  const out = mkdtempSync(join(tmpdir(), 'rocky-ui-build-'));
  afterAll(() => rmSync(out, { recursive: true, force: true }));

  test('index.html 과 js/css 청크를 outdir 에 만든다', async () => {
    await buildUi(out);
    expect(existsSync(join(out, 'index.html'))).toBe(true);
    const files = readdirSync(out);
    expect(files.some((f) => f.endsWith('.js'))).toBe(true);
    expect(files.some((f) => f.endsWith('.css'))).toBe(true);
  });

  test('index.html 이 청크를 절대 경로로 참조한다', async () => {
    // 정적 서빙에서 퍼머링크(`/rocky/12`) 로 새로고침해도 자산 경로가 깨지지 않아야 한다.
    const html = await Bun.file(join(out, 'index.html')).text();
    expect(html).toMatch(/(href|src)="\//);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `bun test src/ui/build.test.ts` → FAIL (`build` 모듈 없음)

- [ ] **Step 3: `src/ui/build.ts` 구현**

```ts
import { join } from 'node:path';

/**
 * 웹 UI 를 outdir 로 번들한다 — 데몬이 시작할 때 한 번 부른다.
 *
 * 런타임 HTML import(`routes: { '/': ui }`) 대신 명시적 Bun.build 를 쓰는 이유:
 * bun-plugin-tailwind 의 클래스 스캔이 `[serve.static]` 플러그인 경로에서는 동작하지
 * 않는다(유틸리티 0개 생성 — Bun 1.3.14 + plugin 0.0.15 실측). Bun.build 에 plugins 를
 * 직접 넘기면 전부 동작한다. Tailwind 플러그인 자체는 Task 2 에서 여기에 더해진다.
 */
export async function buildUi(outdir: string): Promise<void> {
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, 'index.html')],
    outdir,
    minify: true,
    // 자산 참조를 루트 절대 경로로 — 퍼머링크(`/rocky/12`) 새로고침에서도 청크가 로드된다.
    publicPath: '/',
  });
  if (!result.success) {
    throw new AggregateError(result.logs, 'UI bundle failed');
  }
}
```

> `publicPath: '/'` 가 Step 1 의 절대 경로 테스트를 만족시키는지 실행으로 확인하고, Bun 버전에 따라 옵션이 다르게 동작하면(상대 경로가 나오면) `naming` 조정이 아니라 **테스트를 기준으로** 옵션을 맞출 것.

- [ ] **Step 4: 통과 확인** — `bun test src/ui/build.test.ts` → PASS

- [ ] **Step 5: `src/daemon.ts` 교체**

제거: `import ui from './ui/index.html';` · `process.chdir(...)` 절과 그 주석.

추가 (store 생성 뒤, `Bun.serve` 전):

```ts
import { buildUi } from './ui/build';
// …
const uiDist = join(runtime.dir, 'ui-dist');
rmSync(uiDist, { recursive: true, force: true });
await buildUi(uiDist);
const indexHtml = Bun.file(join(uiDist, 'index.html'));
```

`Bun.serve` 라우팅 교체 — routes 에서 `'/': ui` 와 `'/*': ui` 를 빼고, fetch 를:

```ts
    routes: {
      '/mcp': (req, server) => mcp(req, server.requestIP(req)?.address),
      '/api/*': (req, server) => api.fetch(req, server.requestIP(req)?.address),
    },
    // routes 미매칭 = 정적 자산 또는 클라이언트 라우팅 퍼머링크.
    // 자산(chunk-*.js/css 등)은 파일로, 나머지는 전부 index.html — 기존 `'/*': ui`
    // fallback 과 같은 의미다 (`/rocky/12` 새로고침이 REST 404 로 떨어지면 안 된다).
    fetch: async (req) => {
      const pathname = new URL(req.url).pathname;
      const asset = Bun.file(join(uiDist, pathname.slice(1)));
      if (pathname !== '/' && (await asset.exists())) {
        return new Response(asset);
      }
      return new Response(indexHtml);
    },
```

주의: 기존 `fetch: (req, server) => api.fetch(...)` 는 삭제된다 — API 는 `'/api/*'` 라우트가 전부 받는다.

- [ ] **Step 6: 전체 게이트 + 수동 확인**

Run: `bun run check && bun run typecheck && bun run test`

격리 데몬으로 눈 확인 (⚠️ `pkill` 금지, pid 파일로만 종료):

```bash
ROCKY_TODO_PORT=8995 ROCKY_TODO_DIR=/tmp/rt-t1 ROCKY_TODO_EXPOSE= bun run src/daemon.ts &
sleep 3
curl -s http://127.0.0.1:8995/ | head -3          # index.html
curl -s http://127.0.0.1:8995/rocky/12 | head -3  # 같은 index.html (퍼머링크 fallback)
curl -sI "http://127.0.0.1:8995$(curl -s http://127.0.0.1:8995/ | grep -oE '(href|src)="[^"]+\.css"' | head -1 | cut -d'"' -f2)" | head -1  # 200
kill $(cat /tmp/rt-t1/daemon.pid); rm -rf /tmp/rt-t1
```

- [ ] **Step 7: 커밋** — `refactor(daemon): UI 서빙을 시작 시 번들 + 정적 서빙으로`

---

### Task 2: Tailwind 파이프라인 연결 (유틸 사용 전)

**Files:**
- Modify: `package.json` (deps 2종) · `src/ui/build.ts` (플러그인) · `src/ui/styles.css` (레이어 헤더) · `src/ui/build.test.ts` (유틸 생성 테스트)

**Interfaces:**
- Consumes: Task 1 의 `buildUi`
- Produces: 이후 태스크의 `.tsx` 클래스가 자동으로 CSS 유틸이 되는 파이프라인

- [ ] **Step 1: deps**

```bash
bun add tailwindcss@^4 bun-plugin-tailwind@^0.0.15
```

- [ ] **Step 2: 실패하는 테스트 추가** (`src/ui/build.test.ts` 의 describe 안에)

```ts
  test('Tailwind 유틸리티가 소스 클래스에서 생성된다', async () => {
    // main.tsx 의 컴포넌트들이 쓰는 클래스가 스캔되는지 — 파이프라인의 근거다.
    // Task 3 이후 실제 유틸이 쓰이면 이 테스트가 그것으로 통과하고, 그 전에는
    // TopBar 치환(Task 3)과 함께 그린이 된다. 지금은 파이프라인 배선만 확인:
    const css = await bundledCss(out);
    // preflight 가 안 들어왔는지 (시각 동결 — 요소 리셋 금지)
    expect(css).not.toMatch(/^\s*(html|body|button)\s*[,{]/m);
    // 토큰 블록 보존
    expect(css).toContain('#16110c');
    expect(css).toContain('#faf6f0');
  });
```

파일 상단에 헬퍼:

```ts
async function bundledCss(outdir: string): Promise<string> {
  const cssFile = readdirSync(outdir).find((f) => f.endsWith('.css'));
  if (!cssFile) throw new Error('css chunk not found');
  return Bun.file(join(outdir, cssFile)).text();
}
```

- [ ] **Step 3: `build.ts` 에 플러그인**

```ts
import tailwind from 'bun-plugin-tailwind';
// Bun.build 옵션에:
    plugins: [tailwind],
```

- [ ] **Step 4: `styles.css` 헤더** — 파일 맨 위(첫 주석 블록 아래)에 Global Constraints 의 검증된 3줄을 추가. `@import "tailwindcss"` 전체 금지 이유를 주석으로:

```css
/*
 * Tailwind 는 preflight 없이 들어온다 — theme + utilities 레이어만. 전체
 * `@import "tailwindcss"` 는 요소 리셋(preflight)을 끌고 와 아래 수제 리셋과
 * 겹치며 화면을 바꾼다. 시각 동결이 이 마이그레이션의 성공 기준이다.
 */
@layer theme, base, components, utilities;
@import "tailwindcss/theme.css" layer(theme);
@import "tailwindcss/utilities.css" layer(utilities);
```

- [ ] **Step 5: 게이트 + `styles.test.ts` 생존 확인**

Run: `bun run check && bun run typecheck && bun run test`

`styles.test.ts` 는 소스 `styles.css` 를 파싱하므로 layer import 추가에 영향받지 않아야 한다 — 5개 테스트 그대로 통과 확인.

- [ ] **Step 6: 커밋** — `feat(ui): Tailwind v4 파이프라인 (preflight 없이)`

---

### Task 3: TopBar 치환

**Files:**
- Modify: `src/ui/components/TopBar.tsx` · `src/ui/styles.css` (topbar 절 삭제)

**Interfaces:**
- Consumes: Task 2 의 파이프라인
- Produces: 치환 패턴의 본보기 — 이후 태스크가 이 태스크의 매핑표 형식을 따른다

대상 CSS 절: `.topbar` `.wordmark` `.wordmark-dot` `.link-status`(+`.is-on`/`.is-off`) `.link-pulse` `.topbar-spacer` `.actor-chip` `.actor-input` `.theme-toggle` `.archived-toggle` + 모바일 블록의 topbar 관련 규칙.

- [ ] **Step 1: 치환**

예시 (전체 패턴 — 나머지는 레시피 적용):

```tsx
// 기존: <header className="topbar">
<header className="topbar flex items-center gap-4 border-b border-(--line) bg-(--surface) px-5 py-2.5 max-[900px]:flex-wrap max-[900px]:gap-2.5 max-[900px]:px-3.5">
// 기존: <span className="wordmark">
<span className="wordmark font-(family-name:--mono) text-[13px] font-bold tracking-[0.22em]">
// 기존: <span className="wordmark-dot">
<span className="text-(--warm)">
```

`.link-pulse` 의 `animation: pulse …` 는 `@keyframes` 가 CSS 에 남으므로 `[animation:pulse_2.4s_ease-in-out_infinite]` 임의값으로. `is-on`/`is-off` 상태 분기는 JSX 의 조건 클래스로 이미 갈리고 있으니 각 가지에 `text-(--warm)` / `text-(--faint)` 를 준다.

- [ ] **Step 2: styles.css 에서 해당 절 삭제** — `/* ── topbar ── */` 부터 `.archived-toggle` 까지 + 모바일 블록 내 `.topbar`/`.theme-toggle` 규칙. `@keyframes pulse` 는 **남긴다**.

- [ ] **Step 3: 게이트** — `bun run check && bun run typecheck && bun run test` (TopBar 관련 DOM 테스트 셀렉터가 마커 클래스를 쓰면 통과, 아니면 role/텍스트 기준으로 조정)

- [ ] **Step 4: 리포트에 매핑표** — `셀렉터 → 유틸 문자열` 전체. 컨트롤러가 시각 diff.

- [ ] **Step 5: 커밋** — `refactor(ui): TopBar 를 Tailwind 유틸로`

---

### Task 4: Sidebar 치환

대상: `.sidebar` `.sidebar-label` `.board-item`(+`.is-active`) `.doing-dot` `.board-add-open` `.board-add` `.board-add-input` `.board-add-error` + 모바일 블록의 사이드바 규칙(가로 스크롤 칩 행 — `max-[900px]:flex-row max-[900px]:overflow-x-auto …`).

절차는 Task 3 과 동일 (치환 → CSS 절 삭제 → 게이트 → 매핑표 → 커밋 `refactor(ui): Sidebar 를 Tailwind 유틸로`).

주의: `.board-item.is-active` 의 `font-weight:600` — 마커 `is-active` 를 남기고 JSX 조건 클래스로 `bg-(--surface-2) font-semibold` 를 준다.

---

### Task 5: TodoPane + TodoItem 치환

대상: `.todo-pane` `.quick-add` `.quick-add-input` `.todo-group` `.group-eyebrow` `.todo-row` `.todo-meta` `.todo-check-hit` `.todo-check` `.todo-ref` `.todo-title` `.chip` 계열 전부 `.comment-badge` `.doing-badge` 계열 `.empty-state` + 모바일 블록의 해당 규칙(44px 히트 영역, `.todo-meta` 인덴트 70px 포함).

**CSS 로 남길 것 (삭제 금지, 주석과 함께 존치):**
- `.todo-title::after` stretched-link + z-index 층 (`todo-check-hit`/`todo-ref`/`chip-link`/`comment-badge` 의 `position:relative;z-index:1` — 유틸 `relative z-[1]` 로 옮겨도 되지만 ::after 는 CSS)
- `.todo-check:checked::after` 체크 표시(content)
- `.quick-add` 의 sticky 배경 주석 블록 — 유틸로 옮기되 왜 그런지 주석은 컴포넌트로 이사

핵심 보존 확인: 치환 후에도 `todo-meta` 모바일 `margin-left` 가 70px, 칩 틴트가 `color-mix(in_srgb,currentColor_10%,transparent)`, doing 뱃지 테두리 유지.

절차 동일. 커밋 `refactor(ui): TodoPane·TodoItem 을 Tailwind 유틸로`.

---

### Task 6: NotesRail 치환

대상: `.notes-rail` `.notes-head` `.notes-add` `.note-card` `.note-card-head` `.note-title` `.note-action` `.note-content` `.note-meta` `.empty-state`(공유 시 존치 판단) + 모바일 규칙.

절차 동일. 커밋 `refactor(ui): NotesRail 을 Tailwind 유틸로`.

---

### Task 7: DetailDrawer — Radix Dialog 전환 + 치환 + 분해

**Files:**
- Modify: `package.json` (`bun add @radix-ui/react-dialog@^1`)
- Modify: `src/ui/components/DetailDrawer.tsx` → 분해: `DetailDrawer.tsx`(셸) + `TodoDetail.tsx` + `NoteDetail.tsx` + `Timeline.tsx` (모두 `src/ui/components/`)
- Modify: `src/ui/main.tsx` (드로어 열림 시 body 클래스 처리 — Radix 가 스크롤 락을 맡으면 `is-drawer-open` 로직 제거)

**Interfaces:**
- Consumes: 파이프라인 + 기존 store 액션들
- Produces: 없음 (마지막 컴포넌트)

핵심:
- `Dialog.Root open={detail !== null} onOpenChange={(o) => !o && closeDetail()}` + `Dialog.Portal` + `Dialog.Overlay`(기존 `.drawer-backdrop` 스타일) + `Dialog.Content`(기존 `.drawer` 스타일)
- **Radix 가 대체하는 손구현 3가지를 지운다**: window keydown Escape 리스너, backdrop 클릭 닫기, `body.is-drawer-open` 스크롤 락. **얻는 것**: 포커스 트랩(현재 없음) + aria 배선
- 제목 편집 input 의 Escape(편집 취소)는 Radix 의 Escape 닫기와 충돌한다 — input `onKeyDown` 에서 `e.stopPropagation()` 유지 (기존 코드에 이미 같은 취지의 처리가 있다 — 보존)
- `Dialog.Title` 은 접근성 필수 — 기존 `.drawer-title` h2 를 `Dialog.Title asChild` 로 감싼다
- 시각: Overlay/Content 에 기존 클래스의 유틸 치환을 얹는다. 슬라이드 애니메이션은 원래 없으므로 **추가하지 않는다** (시각 동결)
- 분해는 렌더 절 단위로 잘라 옮기기만 — 로직 변경 금지

절차 동일 + 드로어 상호작용 수동 확인(열기/✕/배경/Escape/편집 중 Escape/열림 중 배경 스크롤 잠김). 커밋은 둘로: `refactor(ui): 드로어를 Radix Dialog 로` → `refactor(ui): DetailDrawer 분해`.

---

### Task 8: 잔여 정리 + 문서 + changeset

- [ ] **Step 1: `styles.css` 최종 상태 검사** — 남은 것이 "끝까지 CSS" 목록뿐인지. 죽은 셀렉터 grep:

```bash
for c in $(grep -oE '^\.[a-z-]+' src/ui/styles.css | tr -d '.' | sort -u); do
  grep -rq "$c" src/ui/components src/ui/main.tsx || echo "죽은 셀렉터: .$c"
done
```

- [ ] **Step 2: `DESIGN.md` 갱신** — Known Gaps 4번(손 CSS 1100줄) 해소 기록, 반경 항목은 마이그레이션 중 자연 수렴됐으면 함께 지움
- [ ] **Step 3: `AGENTS.md` 소폭 갱신** — Layout 의 `ui/` 설명에 `build.ts` 추가, 게이트 명령 `bun test` → `bun run test` 정정 (이미 낡아 있던 표기)
- [ ] **Step 4: `FEATURES.md`/`docs/rocky-todo.md`** — 사용자 표면 변화 없음(시각 동결)이므로 **갱신 없음**. deps 변화는 changeset 에만
- [ ] **Step 5: changeset** — patch. 요약: `웹 UI 스타일링을 Tailwind 로 이관 (화면 변화 없음) + 드로어 접근성(포커스 트랩) 개선`
- [ ] **Step 6: 게이트 + 커밋** — `docs(ui): Tailwind 마이그레이션 마무리`

---

## 완료 확인

```bash
bun run check && bun run typecheck && bun run test
wc -l src/ui/styles.css   # ~200줄 예상 (1278 → )
git log --oneline | head -12
```

컨트롤러 최종 시각 diff: 두 테마 × 390/1280px 에서 마이그레이션 전(이 계획 직전 커밋)과 후의 computed style 스냅샷 비교 + 사용자 실물 확인.
