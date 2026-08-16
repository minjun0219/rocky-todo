# Tailwind 이관 + shadcn 검토 (2026-08-16)

목표: 에이전트와 사람이 **함께** 유지보수 가능한 UI 구조. 판단 기준은 셋 —
디자인(두 대기 정체성 유지), 사용성(모바일 우선), 읽기 쉬운 코드.

## 현재 컴포넌트 인벤토리

| 컴포넌트 | 줄수 | 쓰는 프리미티브 | 상태 |
| --- | ---: | --- | --- |
| DetailDrawer | 904 | dialog(수제)·select×2·input·textarea·button | a11y 는 role/aria/Esc/백드롭까지 수제로 확보. **포커스 트랩·복원만 없음** |
| BoardHeader | 187 | input·button | 인라인 편집 폼 |
| TodoItem | 137 | checkbox(수제 `appearance:none`)·button | #43 에서 `.todo-meta` grid 정리됨 |
| NotesRail | 116 | input·textarea·button | |
| TodoPane | 116 | input(quick-add) | |
| Sidebar | 98 | button | |
| TopBar | 68 | input(actor)·button | |

CSS 는 #41 에서 14개 파티션으로 분할, #45 에서 Tailwind v4 배선(시각 무변경).
토큰은 `@theme inline` 다리로 유틸리티화 — `text-warm` 처럼 **의미 이름만** 존재한다.

## shadcn 검토 — 결론: 통째로는 아니오, Radix 는 한 곳만

shadcn 을 그대로 들이면 딸려 오는 것: Radix 패키지들 + `class-variance-authority` +
`clsx` + `tailwind-merge` (+ 관례상 `lucide-react`). 이 레포 기준 평가:

**받아들이지 않는 이유 (전면 도입):**

1. **디자인이 이미 있다.** shadcn 의 가치 절반은 "괜찮은 기본 디자인"인데, 이 앱은
   두 대기(warm/cool) 정체성이 토큰에 박혀 있고 그걸 유지하는 게 목표다. 들여와서
   전부 재스킨하면 남는 건 Radix 래퍼뿐이다.
2. **폼 프리미티브가 단순하다.** input/textarea/button 은 전부 native 요소 + 토큰
   스타일이면 충분하고 이미 그렇게 되어 있다. cva 로 variant 를 관리할 만큼 변형이
   많지 않다 (버튼 변형이 사실상 `.drawer-btn` 하나).
3. **의존성 규율.** AGENTS.md 는 런타임 dep 추가를 개별 정당화 사안으로 둔다.
   cva/clsx/tailwind-merge 는 "shadcn 이 쓰니까" 외의 독립 근거가 없다.
4. **닫힌 PR #19 의 교훈.** 일괄 치환은 리뷰 불가능한 PR 을 만든다. 성공 패턴은
   #41→#45 처럼 한 단계 = 한 관심사다.

**받아들이는 것 (선별):**

- **`@radix-ui/react-dialog` — DetailDrawer 한 곳.** 수제 dialog 의 유일한 실결함이
  포커스 트랩·복원인데, 이건 손으로 옳게 만들기 어렵고 라이브러리가 정확히 잘하는
  부분이다. 닫힌 브랜치(`feat/ui-contrast-light-mode`)에 Radix Dialog 전환 + 드로어
  분해(888→70줄 셸 + 4파일) 경험이 있어 참고 자료도 있다. 904줄 분해와 함께 간다.
- **shadcn 의 "복사해 소유" 모델 자체.** 컴포넌트를 dep 이 아니라 레포 코드로 두는
  방식은 에이전트 유지보수에 유리하다(코드가 눈앞에 있다). 단, 복사 원본이 shadcn 일
  필요가 없다 — 우리 토큰으로 직접 쓴다.

## 이관 컨벤션 (후속 PR 공통)

1. **파티션 단위** — PR 하나 = styles/ 파일 1~2개를 유틸리티로 치환 + 해당 컴포넌트.
2. **의미 유틸리티만** — `text-warm`/`bg-surface`/`border-line`. 원색 팔레트는
   `--color-*: initial` 로 이미 비활성이라 쓰면 그냥 안 나온다 (구조적 강제).
3. **시각 동결 검증** — 치환 PR 은 computed 스타일 스팟 체크를 PR 본문에 남긴다.
   디자인 변경은 치환과 같은 PR 에 싣지 않는다.
4. **@apply 금지** — 유틸리티를 CSS 로 되말면 두 시스템이 뒤섞인다. 반복이 아프면
   컴포넌트 추출이 답이다 (React 가 그 역할).
   4-1. **템플릿 리터럴에서 유틸리티와 `${` 사이에 공백** — `py-2${cond}` 는 스캐너가
   `py-2` 를 클래스 후보로 못 뽑아 유틸리티가 조용히 안 나온다(실측). 항상
   `py-2 ${cond ? 'x' : ''}` 꼴로 쓴다.
5. **responsive 파티션은 마지막까지 남긴다** — `styles.test.ts` 의 순서 불변식이
   지키는 캐스케이드 규칙은 유틸리티 이관 중에도 유효하다. 그 파일이 비면 불변식
   테스트와 함께 제거한다.

## 순서 제안

1. #45 (배선) 머지
2. 작은 파티션부터: `layout`(9줄) → `topbar` → `sidebar` — 패턴 정착
3. `DetailDrawer` 분해 + Radix Dialog (독립 PR, 위 경험 참고)
4. 나머지 파티션 → `responsive` 정리
5. 그 뒤에야 시각 *변경* 작업 (라이트 모드 = 보드 21, 시각 2차 = 보드 23)
