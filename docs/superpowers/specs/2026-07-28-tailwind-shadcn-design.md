# Tailwind 마이그레이션 — 시각 동결

- 날짜: 2026-07-28 (같은 날 개정 — 아래 "개정 이력")
- 상태: 방향 승인됨 (구현 계획 미작성)
- 기준 화면: PR #19 브랜치 `57f468d` 시점의 웹 UI — **이 화면이 정답이고, 바꾸지 않는다**
- 상위 규칙: `DESIGN.md` (시각 계약)

## 목표

**시각 결과물을 동결한 채, 스타일링 구현만 손으로 쓴 CSS 1278줄에서 Tailwind 로 옮긴다.**
shadcn/Radix 는 시각을 바꾸지 않으면서 동작을 개선하는 자리에만 선별 투입한다.

성공 기준이 명확하다 — **마이그레이션 전후 화면이 같다.** 다르면 버그다. 이 기준이
성립하려면 시각 변경이 하나도 섞이면 안 되므로, 이전 spec 에 있던 시각 작업(온도 띠,
lucide 아이콘, 번들 mono 폰트)은 전부 별도로 미룬다(사용자 결정, 아래 "미룬 것").

## 왜 하나

- 직전 여백 수정에서 iframe 을 띄워 픽셀을 재고 음수 마진을 계산했다 — Tailwind 였다면
  유틸리티 한 줄이었다. 이 비용이 UI 를 만질 때마다 반복된다
- `DetailDrawer.tsx` 가 768줄+ 로 컸고 spawn(#20)으로 더 커졌다. Escape 는 손구현이지만
  **포커스 트랩이 없다** — 키보드 사용자가 드로어 밖으로 샌다. Radix Dialog 가 이걸 준다
- 스타일이 컴포넌트와 분리된 1278줄 CSS 라, 컴포넌트를 고칠 때마다 두 파일을 오간다

## 결정

### 1. Tailwind v4, 토큰은 기존 CSS 커스텀 프로퍼티 그대로

- 팔레트 토큰(`--bg` `--warm` … 21개 × 2테마)과 `data-theme` 구조는 **바꾸지 않는다.**
  Tailwind 유틸리티가 `var(--warm)` 를 참조하는 방향(v4 `@theme` 매핑)으로 간다
- **`src/ui/styles.test.ts` 는 계속 산다** — CSS 를 파싱해 대비를 잠그는 유일한 장치다.
  토큰 블록의 위치·형태가 바뀌면 파싱 경로만 따라 고친다
- 인라인 테마 스크립트(`index.html`)와 `resolveTheme` 배선은 손대지 않는다

### 2. shadcn/Radix 는 Dialog 계열 하나만

시각 동결 원칙으로 후보를 다시 심사한 결과:

| 후보 | 판정 | 이유 |
| --- | --- | --- |
| 드로어 → Radix Dialog | **도입** | unstyled 프리미티브라 시각은 기존 CSS 그대로. 얻는 것: 포커스 트랩 · aria 배선 · 스크롤 락 · Escape (손구현 3가지 대체 + 없던 트랩 추가). `DetailDrawer` 분해의 축 |
| `<select>` → shadcn Select | 제외 | 팝업 리스트 렌더가 native 와 달라 **시각이 바뀐다** |
| 체크박스 → shadcn Checkbox | 제외 | native + `appearance:none` 현행이 이미 원하는 모양·동작 |
| Tooltip | 제외 | 현행 `title` 속성 유지 |

shadcn CLI 로 컴포넌트를 통째로 가져오지 않는다 — Dialog 하나에 CLI·cva·tailwind-merge
전부는 과하다. `@radix-ui/react-dialog` 를 직접 쓰고 클래스는 기존 것을 얹는다.
나중에 컴포넌트가 늘어나 shadcn 패턴이 필요해지면 그때 CLI 를 들인다 (YAGNI).

### 3. 마이그레이션 단위 — 컴포넌트별 점진

한 번에 하면 "화면이 같다"를 검증할 수 없다. 컴포넌트 하나씩:

1. 해당 컴포넌트의 클래스를 Tailwind 유틸리티로 치환
2. `styles.css` 에서 그 컴포넌트 절 삭제
3. 화면 동등 확인 (아래 "검증")
4. 커밋

순서는 작은 것부터 — `TopBar` → `Sidebar` → `TodoItem`/`TodoPane` → `NotesRail` →
`DetailDrawer`(+Radix Dialog 전환). `styles.css` 가 0 을 향해 줄어드는 것이 진행률이다.
끝까지 CSS 로 남는 것: 토큰 블록, `@keyframes`, 인라인 테마 관련 — 유틸리티로 표현이
안 되거나 테스트가 파싱하는 부분.

### 4. 검증 — "같다"를 어떻게 재나

- 컴포넌트마다 마이그레이션 전/후 **computed style 스냅샷 비교** — 오르카 브라우저의
  iframe 측정(이 세션에서 쓴 방식)으로 주요 요소의 색·폰트·간격·좌표를 덤프해 diff
- 두 테마 × 두 폭(390px/1280px) 에서 확인
- 기존 게이트: `bun run check` · `typecheck` · `bun run test` (DOM 테스트 16개 포함 —
  클래스명이 바뀌므로 테스트 셀렉터 갱신이 따라간다)
- 대비 회귀 테스트가 토큰을 계속 잠근다

## 의존성 (실측 기반)

| 패키지 | 무게 | 비고 |
| --- | --- | --- |
| `tailwindcss` | 852K | prod (런타임 번들 — 빌드 스텝 없음) |
| `bun-plugin-tailwind` | 26M | prod, oxide 네이티브 |
| `@radix-ui/react-dialog` | ~1M | prod |

prod dep 5 → 8. `lucide-react` 는 이번 범위 밖(미룬 것 참고).

## 알려진 함정

- **`bunfig.toml [serve.static]` 경로는 쓸 수 없다 (스파이크 실증, 2026-07-28)** —
  런타임 HTML import 자동 번들에서 bun-plugin-tailwind 의 클래스 스캔이 돌지 않아
  **유틸리티가 0개** 생성된다 (Bun 1.3.14 + plugin 0.0.15, `development` true/false 모두).
  `Bun.build()` API 에 `plugins` 를 명시하면 전부 동작한다(유틸·`var()` 참조·`color-mix`
  임의값). 따라서 데몬 서빙을 **시작 시 `Bun.build` 번들 + 정적 서빙**으로 바꾼다 —
  "설치 후 빌드 스텝 없음"은 유지된다(지금도 시작 시 번들하며, 방식만 바뀐다).
  부수 효과: `process.chdir(src/ui)` 와 그 이유였던 public path 문제가 사라진다
- **preflight 금지** — `@import "tailwindcss"` 전체는 요소 리셋을 끌고 와 화면을 바꾼다.
  `@layer` + `theme.css`/`utilities.css` 레이어 임포트만 쓴다 (스파이크로 검증 — 유틸은
  다 나오고 요소 리셋은 안 들어온다)
- **클래스 치환 시 시맨틱 클래스명이 사라진다** — DOM 테스트와 `main.tsx` 등에서
  `.todo-row` 같은 셀렉터를 쓰는 곳이 있다. `querySelector` 의존을 함께 정리하거나
  식별용 클래스만 남긴다 (계획 단계에서 전수 조사)
- **stretched-link(`.todo-title::after`)와 z-index 층** — 유틸리티로 옮길 때 이 관계가
  깨지기 쉽다. elementFromPoint 검증을 마이그레이션 후에도 반복한다
- Tailwind 의 `color-mix()` 표현 — 칩/뱃지 틴트가 `color-mix(in srgb, currentColor 10%, …)`
  다. v4 임의값 문법으로 표현 가능한지 먼저 확인하고, 안 되면 그 부분은 CSS 로 남긴다

## 미룬 것 (별도 작업 — 사용자 결정 2026-07-28)

이전 버전의 이 spec 에 있던 시각 변경 전부:

1. **온도 띠(thermal strip)** — `/api/history` 기반 시그니처. 데이터·설계 검토는 이
   문서의 git 히스토리에 남아 있다
2. **lucide-react 아이콘** — 이모지/글리프 교체 (번들 gzip 1.4KB 실측 완료)
3. **번들 가변 mono 폰트** — 구조 계층의 서체 투자
4. DESIGN.md Known Gaps 의 굵기 스케일 · 반경 수렴 — 마이그레이션 중 자연 해소되는
   부분(반경)은 예외적으로 함께 정리될 수 있으나, 시각이 변하면 안 된다는 원칙이 우선

## 개정 이력

- **2026-07-28 (v2, 현재)** — 시각 동결 마이그레이션으로 스코프 축소. 사용자 결정:
  "이전에 적용했던 디자인을 최대한 유지하면서 Tailwind 로 변경하고 필요한 컴포넌트만
  shadcn 활용". Select 는 시각이 바뀌어 제외, Radix 는 Dialog 만
- 2026-07-28 (v1) — Tailwind + Radix + 온도 띠 + lucide + mono 폰트를 묶은 디자인 spec
  (git 히스토리 참고)
