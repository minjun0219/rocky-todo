# 모바일 사용성 — 작은 수정 다섯 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 폰에서 rocky-todo 보드를 실제로 쓸 수 있게 만든다 — 돌아왔을 때 최신이고, 누르려는 것이 눌리고, 필요한 컨트롤이 화면에 있다.

**Architecture:** 재설계 없이 다섯 지점만 고친다. 대부분 `@media (max-width: 900px)` 블록 안의 CSS 이고, 둘(포그라운드 재동기화·배경 스크롤 잠금)은 기존 `useEffect` 에 리스너를 얹는 배선이다. 44px 방침이 그동안 조각조각 적용돼 미디어 블록이 둘로 갈라져 있으므로, 방침을 끝내면서 블록도 하나로 합친다.

**Tech Stack:** React 19 + zustand(웹 UI) · Bun · Biome. 새 의존성 없음.

## Global Constraints

- 설계 문서: `docs/superpowers/specs/2026-07-26-mobile-usability-design.md` (승인됨). 이탈 시 문서를 먼저 고친다.
- import 는 전부 상대경로, 확장자 없음. `__dirname` 금지.
- **새 런타임 의존성 추가 금지.** 테스트용 dep 도 금지 — 이 레포에는 React 컴포넌트 테스트 하네스가 없다.
- **새 CSS 변수를 만들지 않는다.** 기존 것만 쓴다(`--bg` `--surface` `--line` `--text` `--muted` `--faint` `--warm` `--cool` `--p1`~`--p3` `--ok` 등).
- **삭제는 없다**(제품 동작). 아카이브만 존재한다.
- 한국어 주석 OK, 코드 식별자·경로·명령·URL 은 영어 원형. exported 함수/컴포넌트에 JSDoc.
- 게이트: `bun run check` · `bun run typecheck` · `bun test` 세 개가 모두 통과해야 태스크 완료다.
- 커밋 메시지는 Conventional Commits + 한국어 요약.
- 작업 브랜치는 `feat/mobile-usability` (main 기반, 이미 생성됨).
- **이번 작업에는 새 자동 테스트가 붙을 자리가 없다** — CSS 규칙과 이벤트 리스너 배선이고, React 컴포넌트 테스트 하네스가 없다. 기존 스위트는 회귀만 잡는다. 검증은 게이트 + 격리 데몬 + 좁은 폭 브라우저 육안 확인이다. 없는 테스트를 지어내지 말 것.
- 범위 밖: 드로어 바텀시트, 메모 레일 탭, 메타 칩 접기, 홈 화면 추가(PWA).

## File Structure

| 파일 | 역할 | 태스크 |
| --- | --- | --- |
| `src/ui/styles.css` | 모바일 미디어 블록 통합 + 터치 타깃 + 스크롤 잠금 + sticky | 1, 3, 4, 5 |
| `src/ui/components/TodoItem.tsx` | 체크박스를 라벨로 감싼다 | 1 |
| `src/ui/main.tsx` | `visibilitychange` 재동기화 | 2 |
| `src/ui/components/DetailDrawer.tsx` | body 스크롤 잠금 토글 | 3 |
| `src/ui/components/Sidebar.tsx` | 아카이브 토글 제거 | 4 |
| `src/ui/components/TopBar.tsx` | 아카이브 토글 수용 | 4 |
| `.changeset/<이름>.md` | patch changeset | 6 |

---

### Task 1: 터치 타깃 44×44 + 미디어 블록 통합

**Files:**
- Modify: `src/ui/styles.css`
- Modify: `src/ui/components/TodoItem.tsx`

**Interfaces:**
- Consumes: 없음
- Produces: `.todo-check-hit` 클래스(모바일에서 44×44 히트 영역). 뒤 태스크가 이 클래스를 건드리지 않는다.

- [ ] **Step 1: 두 개로 갈라진 미디어 블록을 합친다**

`src/ui/styles.css` 에 `@media (max-width: 900px)` 가 **두 곳**(708행 부근, 882행 부근)에 있다. 두 번째 블록은 규칙 하나만 담고 있다:

```css
@media (max-width: 900px) {
  /* 터치 타깃 — 백로그 rocky-todo#1 과 같은 방침 */
  .board-add-open {
    min-height: 44px;
  }
}
```

이 두 번째 블록을 **통째로 삭제**하고, 그 안의 `.board-add-open` 규칙을 첫 번째 블록의 터치 타깃 구역으로 옮긴다. 첫 블록에는 이미 다음이 있다:

```css
  /* 터치 타깃 44×44 — 백로그 mxndnikm 1번과 같은 방침 */
  .todo-ref {
    min-height: 44px;
    min-width: 44px;
  }
  .drawer-ref {
    display: inline-flex;
    align-items: center;
    min-height: 44px;
    min-width: 44px;
  }
```

그 주석을 다음으로 바꾼다 — 이제 조각이 아니라 완결된 방침이다:

```css
  /* 터치 타깃 44×44 — 손가락으로 누르는 컨트롤은 시각 크기와 무관하게 히트 영역을 확보한다.
     rocky-todo#1 에서 마무리했다(그 전에는 건드리는 컨트롤마다 그때그때 더해 왔다). */
```

- [ ] **Step 2: 체크박스를 라벨로 감싼다**

`src/ui/components/TodoItem.tsx` 의 `<input type="checkbox" className="todo-check" …>` 를 라벨로 감싼다. 기존 input 의 속성은 하나도 바꾸지 않는다:

```tsx
      <label className="todo-check-hit">
        <input
          type="checkbox"
          className="todo-check"
          checked={done}
          title={done ? '다시 열기' : '완료'}
          onChange={() => void setTodoStatus(todo.id, done ? 'reopen' : 'done')}
        />
      </label>
```

> **왜 `::before` 로 히트 영역만 겹쳐 넓히지 않는가:** `.todo-ref`(번호 복사 버튼)가 체크박스 **바로 옆**이고 이미 `min-width: 44px` 다. 음수 `inset` 으로 넓힌 투명 영역은 그 위에 겹쳐 클릭을 가로챈다 — 44px 타깃 두 개가 서로를 먹는다. 게다가 `<input>` 의 생성 콘텐츠는 브라우저 지원이 보장되지 않는다. 라벨은 공간을 실제로 차지하므로 겹침이 원천적으로 없고, `<label>` 이 입력을 감싸면 라벨 아무 데나 눌러도 토글돼 접근성도 낫다.

- [ ] **Step 3: 모바일 터치 타깃 규칙을 더한다**

`src/ui/styles.css` 의 (통합된) `@media (max-width: 900px)` 블록 안, 터치 타깃 구역에 더한다:

```css
  .todo-check-hit {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 44px;
    min-height: 44px;
    /* 늘어난 히트 영역이 행 높이와 좌측 정렬을 밀지 않게 상쇄한다 — 시각 밀도는 그대로. */
    margin: -8px 0 -8px -8px;
  }
  .todo-row {
    min-height: 44px;
  }
  .note-action {
    min-height: 44px;
    min-width: 44px;
  }
  .drawer-close {
    min-height: 44px;
    min-width: 44px;
  }
  .comment-tool {
    min-height: 44px;
    padding: 0 8px;
  }
  .comment-badge {
    min-height: 44px;
  }
  .archived-toggle {
    min-height: 44px;
  }
  /* `.drawer-btn` 은 버튼뿐 아니라 `<a>`("이슈 열기 ↗")에도 쓰인다. `<a>` 는 인라인이라
     min-height 가 먹지 않으므로 display 를 함께 준다. */
  .drawer-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 44px;
  }
  .board-add-open {
    min-height: 44px;
  }
```

데스크톱 규칙은 건드리지 않는다 — 이 규칙들은 전부 모바일 블록 안에만 있다.

> 나머지 대상은 전부 `<button>`(`.note-action` `.drawer-close` `.comment-tool` `.comment-badge` `.board-add-open`)이거나 이미 `display: flex` 인 `<label>`(`.archived-toggle`)이라 `min-height` 만으로 충분하다 — 버튼은 내용을 세로 가운데 정렬한다. 확인하고 넣은 값이니 임의로 `display` 를 더 붙이지 말 것.

- [ ] **Step 4: 게이트를 돌린다**

Run: `bun run check && bun run typecheck && bun test`
Expected: 세 명령 모두 성공 종료

- [ ] **Step 5: 미디어 블록이 하나인지 확인한다**

Run: `grep -c "@media (max-width: 900px)" src/ui/styles.css`
Expected: `1`

- [ ] **Step 6: 커밋**

```bash
git add src/ui/styles.css src/ui/components/TodoItem.tsx
git commit -m "fix(ui): 모바일 터치 타깃 44px 마무리와 미디어 블록 통합"
```

---

### Task 2: 포그라운드 복귀 재동기화

**Files:**
- Modify: `src/ui/main.tsx`

**Interfaces:**
- Consumes: 없음
- Produces: 없음 (배선만)

- [ ] **Step 1: `visibilitychange` 리스너를 더한다**

`src/ui/main.tsx` 의 기존 `useEffect` 안, `popstate` 리스너 등록 **뒤**에 넣는다:

```ts
    // 모바일 브라우저는 탭이 백그라운드로 가면 EventSource 와 타이머를 얼린다. 돌아와도
    // 끊겨 있던 동안의 변경은 오지 않으므로, SSE 재연결을 기다리지 않고 즉시 다시 읽는다.
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void refetch();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
```

같은 `useEffect` 의 정리 함수에 해제를 더한다 — `popstate` 해제 바로 뒤:

```ts
      document.removeEventListener('visibilitychange', onVisible);
```

의존성 배열 `[refetch, setConnected]` 은 그대로 둔다. 둘 다 zustand 액션이라 참조가 안정적이라 리스너가 매 렌더마다 재등록되지 않는다.

- [ ] **Step 2: 게이트를 돌린다**

Run: `bun run check && bun run typecheck && bun test`
Expected: 전부 성공

- [ ] **Step 3: 커밋**

```bash
git add src/ui/main.tsx
git commit -m "fix(ui): 포그라운드 복귀 시 보드를 다시 읽는다"
```

---

### Task 3: 드로어 열렸을 때 배경 스크롤 잠금

**Files:**
- Modify: `src/ui/components/DetailDrawer.tsx`
- Modify: `src/ui/styles.css`

**Interfaces:**
- Consumes: 없음
- Produces: `body.is-drawer-open` 클래스 규약

- [ ] **Step 1: CSS 규칙을 더한다**

`src/ui/styles.css` 에서 `.drawer-backdrop` 규칙 **바로 앞**에 넣는다(미디어 블록 밖 — 데스크톱에도 적용된다):

```css
/* 드로어가 열린 동안 뒤 배경이 스크롤되지 않게 한다. 모바일에서 `.layout` 이
   `overflow-y: auto` 라 드로어 위에서 스크롤하면 배경이 함께 움직인다. */
body.is-drawer-open {
  overflow: hidden;
}
```

- [ ] **Step 2: 드로어가 클래스를 토글하게 한다**

`src/ui/components/DetailDrawer.tsx` 의 Escape 처리 `useEffect` **바로 뒤**에 별도 효과를 더한다. 기존 효과에 얹지 않는 이유: 그쪽은 `if (!detail) return;` 로 **일찍 빠져나가므로** 거기에 정리 로직을 넣으면 `detail` 이 없어질 때 클래스가 남는다.

```tsx
  // 드로어가 열린 동안 배경 스크롤을 잠근다. 정리 함수에서 **반드시** 지운다 —
  // 남기면 드로어를 닫은 뒤 페이지 전체가 스크롤 불가가 된다.
  useEffect(() => {
    if (!detail) {
      return;
    }
    document.body.classList.add('is-drawer-open');
    return () => document.body.classList.remove('is-drawer-open');
  }, [detail]);
```

- [ ] **Step 3: 게이트를 돌린다**

Run: `bun run check && bun run typecheck && bun test`
Expected: 전부 성공

- [ ] **Step 4: 클래스가 남지 않는지 확인한다**

이 태스크의 유일한 함정이다. 격리 데몬을 띄워 브라우저에서 확인한다 — **사용자의 실제 보드(포트 8636)를 건드리지 않는다**:

```bash
export ROCKY_TODO_DIR=$(mktemp -d)
export ROCKY_TODO_PORT=8993
export ROCKY_TODO_EXPOSE=""
bun src/daemon.ts &
sleep 4
curl -s -X POST -H 'content-type: application/json' -H 'x-rocky-actor: t' \
  -d '{"key":"demo"}' "http://127.0.0.1:8993/api/boards" >/dev/null
curl -s -X POST -H 'content-type: application/json' -H 'x-rocky-actor: t' \
  -d '{"board":"demo","title":"스크롤 잠금 확인"}' "http://127.0.0.1:8993/api/todos" >/dev/null
```

브라우저에서 `http://127.0.0.1:8993/` 를 열고 확인한다(직접 못 하면 보고서에 컨트롤러용 체크리스트로 남긴다 — 없는 확인을 했다고 쓰지 말 것):

1. 드로어를 연다 → `document.body.classList.contains('is-drawer-open')` 가 `true`
2. `✕` 로 닫는다 → `false`
3. 배경 클릭으로 닫는다 → `false`
4. Escape 로 닫는다 → `false`
5. 닫은 뒤 페이지가 정상 스크롤된다

끝나면 **반드시** 데몬을 내리고 임시 디렉터리를 지운다:

```bash
kill %1
rm -rf "$ROCKY_TODO_DIR"
```

- [ ] **Step 5: 커밋**

```bash
git add src/ui/styles.css src/ui/components/DetailDrawer.tsx
git commit -m "fix(ui): 드로어가 열린 동안 배경 스크롤을 잠근다"
```

---

### Task 4: 아카이브 토글을 topbar 로

**Files:**
- Modify: `src/ui/components/Sidebar.tsx`
- Modify: `src/ui/components/TopBar.tsx`
- Modify: `src/ui/styles.css`

**Interfaces:**
- Consumes: 없음
- Produces: `.archived-toggle` 이 `.topbar` 안에 있다. `.sidebar-foot` 은 사라진다.

- [ ] **Step 1: Sidebar 에서 토글을 뺀다**

`src/ui/components/Sidebar.tsx` 에서 `.sidebar-foot` 블록을 통째로 삭제한다:

```tsx
      <div className="sidebar-foot">
        <label className="archived-toggle">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />
          보관됨 표시
        </label>
      </div>
```

쓰이지 않게 된 셀렉터 두 줄도 지운다:

```tsx
  const showArchived = useUiStore((s) => s.showArchived);
  const setShowArchived = useUiStore((s) => s.setShowArchived);
```

컴포넌트 JSDoc(`/** 좌측 보드 목록 — 전체 뷰 + 보드별 뷰 전환, 보드 생성, 아카이브 토글. */`)에서 "아카이브 토글" 을 뺀다.

- [ ] **Step 2: TopBar 로 옮긴다**

`src/ui/components/TopBar.tsx` 상단에 셀렉터를 더한다:

```tsx
  const showArchived = useUiStore((s) => s.showArchived);
  const setShowArchived = useUiStore((s) => s.setShowArchived);
```

`<div className="topbar-spacer" />` **바로 뒤**, actor 편집 블록 **앞**에 넣는다:

```tsx
      <label className="archived-toggle">
        <input
          type="checkbox"
          checked={showArchived}
          onChange={(e) => setShowArchived(e.target.checked)}
        />
        보관됨 표시
      </label>
```

컴포넌트 JSDoc 을 바꾼다:

```tsx
/** 상단 바 — 워드마크 + 링크(SSE) 상태 + 보관됨 표시 토글 + 호출자(actor) 설정. */
```

- [ ] **Step 3: CSS 를 정리한다**

`src/ui/styles.css` 에서 `.sidebar-foot` 규칙을 **둘 다** 지운다 — 데스크톱(214행 부근)과 모바일 블록 안(746행 부근):

```css
.sidebar-foot {
  margin-top: auto;
  padding: 12px 10px 0;
}
```

```css
  .sidebar-foot {
    margin-top: 0;
    margin-left: auto;
    padding: 0 0 0 12px;
    flex-shrink: 0;
  }
```

모바일 블록의 `.archived-toggle { white-space: nowrap }` 은 **남긴다** — topbar 가 `flex-wrap: wrap` 이라 이 라벨이 중간에 끊기면 보기 나쁘다.

- [ ] **Step 4: 게이트를 돌린다**

Run: `bun run check && bun run typecheck && bun test`
Expected: 전부 성공. `typecheck` 가 `Sidebar.tsx` 에서 쓰이지 않는 변수를 지적하면 Step 1 의 셀렉터 삭제가 빠진 것이다.

- [ ] **Step 5: `.sidebar-foot` 이 남지 않았는지 확인한다**

Run: `grep -rn "sidebar-foot" src/`
Expected: 출력 없음

- [ ] **Step 6: 커밋**

```bash
git add src/ui/components/Sidebar.tsx src/ui/components/TopBar.tsx src/ui/styles.css
git commit -m "fix(ui): 보관됨 표시 토글을 topbar 로 옮긴다"
```

---

### Task 5: quick-add 고정

**Files:**
- Modify: `src/ui/styles.css`

**Interfaces:**
- Consumes: 없음
- Produces: 없음

- [ ] **Step 1: `.quick-add` 규칙을 더한다**

`src/ui/components/TodoPane.tsx` 의 form 은 `className="quick-add"` 인데 그 클래스의 CSS 규칙이 **아직 없다**(`.quick-add-input` 만 있다). `src/ui/styles.css` 의 `.quick-add-input` 규칙 **바로 앞**에 더한다:

```css
/* 목록을 스크롤해도 새 작업 입력이 따라온다. `.todo-pane` 은 배경색이 없어 body 의
   `--bg` 위에 있으므로 같은 색을 깔아 아래 항목이 비쳐 보이지 않게 한다. */
.quick-add {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--bg);
}
```

모바일에서 `.todo-pane` 이 `overflow-y: visible` 이라 sticky 기준은 `.layout` 이 된다 — 의도한 동작이다. 데스크톱에서는 `.todo-pane` 이 `overflow-y: auto` 라 그 안에서 붙는다. 둘 다 옳다.

- [ ] **Step 2: 게이트를 돌린다**

Run: `bun run check && bun run typecheck && bun test`
Expected: 전부 성공

- [ ] **Step 3: 커밋**

```bash
git add src/ui/styles.css
git commit -m "fix(ui): 스크롤해도 새 작업 입력이 붙어 있게 한다"
```

---

### Task 6: 백로그 분리와 changeset

**Files:**
- Create: `.changeset/<이름>.md`
- 보드 작업(레포 변경 아님): `rocky-todo#1` 의 설명 정리 + 새 todo 넷

- [ ] **Step 1: 백로그 항목 넷을 보드에 만든다**

`rocky-todo` 보드에 다음을 만든다. `todo_write` MCP 도구(없으면 `rocky-todo add`)를 쓰고 `actor` 는 `claude-code`. **`createIssue` 는 쓰지 않는다.**

| 제목 | 설명에 담을 것 |
| --- | --- |
| `todo(web-ui) - 모바일 드로어를 바텀시트로` | 지금은 전폭 오버레이 + 우상단 `✕` 라 엄지 도달 범위 밖. 아래에서 올라오는 시트 + 상단 그랩바(스와이프 다운 닫기), 최소한 닫기 버튼을 하단으로. |
| `todo(web-ui) - 모바일 메모 레일 접근성` | 세로 스택에서 메모가 todo 리스트 맨 아래라 항목이 늘면 도달에 긴 스크롤이 필요하다. 작업/메모 탭 전환 또는 기본 접힘 + 개수 표시. |
| `todo(web-ui) - 모바일 메타 칩 접기` | 링크/라벨/댓글 배지가 늘어 **todo 하나가 2줄을 먹는다**(실제 iPhone 스크린샷에서 `#12` 의 `p2`, `#15` 의 PR 링크+`💬 1` 이 제목 아래로 흐름). 모바일에서 2개 초과분을 `+N` 으로 접는다. 접는 로직은 순수 함수로 빼면 테스트된다. |
| `todo(web-ui) - 홈 화면 추가(PWA)` | manifest + `apple-mobile-web-app-*` + `viewport-fit=cover` + `env(safe-area-inset-*)`. tailscale/LAN 으로 폰에서 상시 쓰게 되면 값어치가 생긴다. |

전부 `priority: p4`, `section: "설계"`.

- [ ] **Step 2: `rocky-todo#1` 의 설명을 정리한다**

`#1` 의 description 에서 **3·5·8·9번 항목 본문을 빼고** 위에서 만든 todo 의 참조(`rocky-todo#NN`)로 대체한다. 1·2·4·6·7 은 이번에 구현했으므로 "완료" 로 표시하되 본문은 남긴다 — 무엇을 왜 했는지의 기록이다.

`description` 을 통째로 새로 쓰지 말고, 위 규칙대로 편집한 전체 본문을 `todo_write` 의 `description` 으로 넘긴다. 그리고 무엇을 어디로 옮겼는지 `comment` 로 한 줄 남긴다.

- [ ] **Step 3: changeset 을 만든다**

```bash
bunx changeset
```
- bump: **patch** (새 기능이 아니라 기존 UI 의 사용성 수정)
- 요약: `모바일 사용성 — 터치 타깃 44px, 포그라운드 복귀 재동기화, 드로어 배경 스크롤 잠금, 보관 토글을 topbar 로, quick-add 고정`

`bunx changeset` 이 대화형이라 막히면 `.changeset/` 의 기존 파일을 하나 읽어 형식을 확인하고 같은 모양으로 직접 만든다. 패키지명은 `package.json` 의 `name`.

**changeset 본문은 그대로 CHANGELOG 로 나간다** — 사실이 아닌 문장을 넣지 마라. 이번에 하지 않은 것(바텀시트·메모 탭·칩 접기·PWA)을 적지 않는다.

- [ ] **Step 4: 게이트를 돌린다**

Run: `bun run check && bun run typecheck && bun test`
Expected: 전부 성공

- [ ] **Step 5: 커밋**

```bash
git add .changeset
git commit -m "docs: 모바일 사용성 수정 changeset"
```

---

## 완료 조건

1. `bun run check` · `bun run typecheck` · `bun test` 전부 통과
2. `@media (max-width: 900px)` 블록이 하나
3. `grep -rn "sidebar-foot" src/` 가 비어 있다
4. 좁은 폭 브라우저에서 육안 확인:
   - 체크박스를 가장자리에서 눌러도 토글된다
   - 드로어를 열고 그 위에서 스크롤해도 배경이 안 움직이고, **닫으면 배경 스크롤이 돌아온다**
   - 보드가 여러 개여도 보관됨 표시 토글이 보인다
   - 목록을 스크롤해도 quick-add 가 붙어 있다
5. 탭을 백그라운드로 보냈다 돌아오면 보드가 갱신된다
6. 백로그 todo 넷이 보드에 있고 `rocky-todo#1` 이 그것들을 가리킨다
7. `rocky-todo#1` 을 `done` 으로 전이
