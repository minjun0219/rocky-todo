# 모바일 사용성 — 작은 수정 다섯

- 날짜: 2026-07-26
- 상태: 설계 승인됨
- 보드 항목: `rocky-todo#1`
- 대상: `src/ui/styles.css` · `src/ui/main.tsx` · `src/ui/components/DetailDrawer.tsx` · `src/ui/components/TopBar.tsx` · `src/ui/components/Sidebar.tsx` · `src/ui/components/TodoPane.tsx`

## 문제

웹 UI 에 모바일 대응(`@media (max-width: 900px)`)이 이미 있다 — 세로 스택, 보드 칩 행,
`100dvh`, 입력 `font-size: 16px`. 그 위에 남은 갭이 실제 폰에서 확인됐다.

사용자가 보내온 iPhone Safari 스크린샷이 세 가지를 동시에 보여준다:

1. **`NO LINK`** — SSE 가 끊긴 채다. 모바일 브라우저는 탭이 백그라운드로 가면 `EventSource`
   와 타이머를 얼리고, 돌아와도 놓친 변경은 오지 않는다. 보드가 낡은 채 보인다.
2. **아카이브 토글이 화면에 없다** — 보드 칩 행이 가로로 밀려 `rocky-todo` 칩조차 잘렸고,
   그 뒤에 있는 토글은 아예 도달 불가다.
3. **메타 칩이 줄바꿈해 todo 하나가 2줄을 먹는다** — `p2`, PR 링크, `💬 1` 이 제목 아래로
   흐른다. (이번 범위 밖 — 백로그 항목으로 분리한다.)

여기에 손가락으로 누르기 어려운 컨트롤(`.todo-check` 15×15 등)과, 드로어 위에서 스크롤하면
배경이 함께 움직이는 문제, 스크롤하면 사라지는 quick-add 가 더해진다.

## 목표 / 비목표

**목표** — 폰에서 보드를 실제로 쓸 수 있게 만든다: 돌아왔을 때 최신이고, 누르려는 것이
눌리고, 필요한 컨트롤이 화면에 있다.

**비목표** — 드로어를 바텀시트로 바꾸는 재설계, 메모 레일의 탭 전환, 메타 칩 접기,
홈 화면 추가(PWA). 넷 다 별도 보드 항목으로 분리한다.

## 발견: 44px 방침이 이미 조각조각 적용돼 있다

`src/ui/styles.css` 에 `min-height: 44px` 가 세 군데 있고, 각각 "백로그 rocky-todo#1 과 같은
방침" 이라는 주석이 달려 있다 — `.todo-ref`, `.drawer-ref`, `.board-add-open`. 앞선 작업들이
자기가 건드리는 컨트롤만 그때그때 고쳐 온 것이다.

그 결과 `@media (max-width: 900px)` 블록이 **두 개**(708행·882행)로 갈라져 있다. 두 번째
블록은 규칙 하나(`.board-add-open`)만 담고 있다.

이번에 그 방침을 **끝내고 두 블록을 하나로 합친다.** 내가 손대는 코드의 정리이므로 범위 안이다.

## 설계

### 1. 터치 타깃 — 모바일 폭에서 44×44

남은 컨트롤에 히트 영역을 준다:

| 대상 | 현재 | 방식 |
| --- | --- | --- |
| `.todo-check` | 15×15 | **시각 크기 유지**, `<label>` 로 감싸 여백으로 히트 영역 확보 |
| `.note-action` | `padding: 2px 4px` | `min-height`/`min-width` |
| `.drawer-close` | 크기 지정 없음 | `min-height`/`min-width` |
| `.comment-tool` | `padding: 0` | `min-height` + 좌우 `padding` |
| `.comment-badge` | `padding: 0 2px` | `min-height` |
| `.archived-toggle` | 기본 체크박스 | 라벨 전체를 `min-height` 로 |
| `.drawer-btn` | `padding: 6px 12px` | 세로만 상향 |

체크박스는 **시각 크기를 키우지 않되, 히트 영역은 실제 공간을 차지하게 한다.**
`TodoItem` 의 `<input className="todo-check">` 를 `<label className="todo-check-hit">` 로 감싸고,
모바일 폭에서 그 라벨에 여백을 준다:

```css
  .todo-check-hit {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 44px;
    min-height: 44px;
    margin: -8px 0 -8px -8px; /* 늘어난 여백이 행 높이를 밀지 않게 상쇄 */
  }
```

**`::before` 로 히트 영역만 겹쳐 넓히는 방법은 쓰지 않는다.** 두 가지 이유가 있다:

1. `.todo-ref`(번호 복사 버튼)가 체크박스 **바로 옆**이고 이미 `min-width: 44px` 다. 음수
   `inset` 으로 넓힌 투명 영역은 그 위에 겹쳐 클릭을 가로챈다 — 44px 타깃 두 개가 서로를
   먹는다.
2. `<input>` 의 생성 콘텐츠(`::before`)는 브라우저마다 지원이 갈린다(`appearance: none` 이면
   대체로 동작하지만 보장이 아니다).

라벨은 공간을 실제로 차지하므로 겹침이 원천적으로 없고, `<label>` 이 입력을 감싸면 라벨
아무 데나 눌러도 토글된다 — 접근성 측면에서도 낫다.

`.todo-row` 는 `min-height` 를 올려 행 자체가 손가락에 맞게 한다.

### 2. 포그라운드 복귀 재동기화

`src/ui/main.tsx` 의 기존 `useEffect`(SSE 구독·`popstate` 와 같은 자리)에 리스너를 더한다:

```ts
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void refetch();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
```

정리 함수에서 `removeEventListener`.

**SSE 재연결을 기다리지 않는다.** `EventSource` 는 스스로 재연결하지만 끊겨 있던 동안의
변경은 전달되지 않는다. 즉시 `refetch()` 가 유일하게 확실한 복구다.

이 효과의 의존성은 `[refetch, setConnected]` 이고 둘 다 zustand 액션이라 참조가 안정적이다 —
리스너가 매 렌더마다 재등록되지 않는다.

### 3. 드로어 열렸을 때 배경 스크롤 잠금

모바일에서 `.layout` 이 `overflow-y: auto` 라, 드로어 위에서 스크롤하면 뒤 배경이 움직인다.

`DetailDrawer` 의 기존 `useEffect`(Esc 핸들러가 있는 자리)에서 `document.body` 에 클래스를
토글하고, CSS 가 `overflow: hidden` 을 건다.

```css
body.is-drawer-open {
  overflow: hidden;
}
```

**정리 함수에서 반드시 제거한다.** 남기면 드로어를 닫은 뒤 페이지 전체가 스크롤 불가가 된다 —
이 항목의 유일한 함정이고, 언마운트·조건부 렌더 어느 경로로 나가든 지워져야 한다.

데스크톱에도 적용된다. 드로어가 열린 동안 배경이 안 움직이는 건 데스크톱에서도 옳다.

### 4. 아카이브 토글을 topbar 로

`.sidebar-foot { margin-left: auto }` 가 `overflow-x: auto` 인 칩 행 안에 있어, 보드가 늘면
화면 밖으로 밀린다(스크린샷에서 확인).

`Sidebar` 의 `.sidebar-foot` 블록을 **`TopBar` 로 옮긴다.** 부모가 다르므로 CSS `order` 로는
해결되지 않는다. 데스크톱에서도 topbar 로 간다 — 모바일에서만 옮기려면 같은 컨트롤을 두 곳에
렌더하고 미디어쿼리로 하나를 숨겨야 해서 더 지저분하다. topbar 는 이미 actor 칩이 있는
"전역 설정" 자리라 성격도 맞다.

`TopBar` 는 이미 `flex-wrap: wrap` 이고 모바일에서 오른쪽에 여유가 있다(스크린샷).

### 5. quick-add 고정

`.quick-add` 에 `position: sticky; top: 0` 과 배경색을 준다. `.todo-pane` 이 모바일에서
`overflow-y: visible` 이라 sticky 기준이 `.layout` 이 되는데, 그게 의도한 동작이다.

FAB(하단 플로팅 버튼)는 새 컴포넌트와 위치 계산, safe-area 처리가 필요해 이번 범위에 과하다.

## 테스트

순수 로직이 거의 없다 — CSS 규칙과 이벤트 리스너 배선이다. 이 레포에는 React 컴포넌트
테스트 하네스가 없고 테스트용 dep 추가는 금지이므로, **이번 작업에는 새 자동 테스트가 붙을
자리가 없다.** 정직하게 그렇게 적는다.

검증은 세 층이다:

1. 게이트 — `bun run check` · `bun run typecheck` · `bun test`(기존 스위트가 회귀만 잡는다)
2. 격리 데몬 + 브라우저 창을 폰 폭으로 줄여 육안 확인:
   - 체크박스를 가장자리에서 눌러도 토글된다
   - 드로어를 열고 그 위에서 스크롤해도 배경이 안 움직인다. **닫은 뒤 배경 스크롤이 돌아온다**
   - 보드를 여러 개 만들어도 아카이브 토글이 보인다
   - 목록을 스크롤해도 quick-add 가 붙어 있다
3. 탭을 백그라운드로 보냈다 돌아왔을 때 보드가 갱신된다 (다른 경로로 todo 를 하나 만들어 두고 확인)

## 백로그로 분리

`rocky-todo#1` 의 설명에서 아래 넷을 빼고 새 항목으로 만든다. 설명에만 묻어 두면 다시
잊힌다.

| 항목 | 내용 |
| --- | --- |
| 드로어 바텀시트 | 아래에서 올라오는 시트 + 그랩바 + 스와이프 다운 닫기 |
| 메모 레일 접근성 | 세로 스택에서 메모가 맨 아래 — 탭 전환 또는 기본 접힘 |
| 메타 칩 접기 | 2개 초과를 `+N` 으로. **스크린샷 근거 첨부** — 지금 todo 하나가 2줄을 먹는다 |
| 홈 화면 추가 | manifest + `apple-mobile-web-app-*` + `viewport-fit=cover` + safe-area |

## 위험 / 판단 근거

- **body 스크롤 잠금이 남는 것** — 유일한 되돌리기 어려운 실수다. 정리 함수를 반드시 검증한다.
- **아카이브 토글 이동은 데스크톱 레이아웃도 바꾼다** — 의도된 것이고, 두 벌 렌더보다 낫다.
- **자동 테스트 없음** — 이 작업의 성격상 불가피하다. 육안 확인 항목을 구체적으로 적어
  "확인했다"가 검증 가능하도록 만든다.
