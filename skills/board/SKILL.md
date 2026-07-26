---
name: board
description: Use when managing the shared rocky-todo board from a session — planning work the user should see live in the web UI ("보드에 올려둬", "todo 정리해줘"), starting/finishing tracked work items, or leaving scratchpad notes for the user. Covers the rocky-todo daemon's MCP tools (todo_list / todo_write / todo_status / note_list / note_write) and the rocky-todo CLI fallback, the start→done etiquette that powers the "처리중" indicator, link-attachment conventions (GitHub issue / Todoist URLs), and the archive-only rule (no deletion exists).
---

# rocky-todo — 공유 작업 보드

로키(에이전트)와 호출자(사람)가 하나의 보드를 공유한다: 에이전트는 MCP/CLI 로 쓰고,
호출자는 웹브라우저(`http://127.0.0.1:8636`)에서 실시간(SSE)으로 보고 편집한다.
모든 변경은 누가-무엇을-언제 히스토리로 남는다.

## 설치 = 활성화

rocky-todo 는 rocky 의 **동반 플러그인**이다. 설치 자체가 활성화 경계라 별도 스위치
(`todo.enabled`)가 없다. 세션에 도구가 없다면 아직 설치 안 된 것 — 다음을 안내한다
(임의로 진행하지 말고 사용자 동의 후):

```bash
claude plugin marketplace add minjun0219/rocky        # 이미 있으면 생략
claude plugin install rocky-todo@rocky-marketplace    # rocky 는 dependencies 로 자동 동반
```

같은 rocky 마켓플레이스가 rocky-todo 를 서빙하며(github source), `dependencies:["rocky"]`
이므로 rocky 가 먼저 없으면 함께 설치된다. 설치 후 SessionStart 훅이 데몬을 기동한다 —
첫 세션에서 MCP 가 `failed` 면 `/mcp` retry 또는 다음 세션에서 붙는다.

## 도구 게이트 (먼저 확인)

- 세션에 `todo_list` / `todo_write` / `todo_status` / `note_list` / `note_write` MCP 도구가
  연결되어 있으면 그것을 쓴다 (rocky-todo 데몬의 `/mcp`).
- MCP 도구가 없으면 CLI 로 폴백: `rocky-todo <cmd>` (Bash). CLI 는 데몬이 죽어 있으면
  자동 기동한다. 레포에서 직접 실행할 땐 `bun run <rocky-todo-repo>/src/cli.ts <cmd>` 도 동일.
- 도구도 CLI 도 없으면 위 "설치 = 활성화" 를 안내하고 멈춘다.
- 데몬 기동이 실패하면 중단하고 `rocky-todo daemon status` 를 안내. 가짜 진행을 만들지 않는다.

## Todoist 와의 역할 구분

코딩 세션의 작업 추적은 **rocky-todo 가 기본**이다. 알림·반복 일정·마감 리마인더가
필요하거나 사용자가 명시적으로 "todoist" 를 언급하면 `todoist` 스킬로 라우팅한다.
두 시스템을 잇는 건 링크 필드 — rocky-todo 항목에 Todoist task URL 을 첨부한다.

## 보드 결정

- board key 는 **레포 이름** (git remote origin 의 basename). 세션 초반에 한 번 정하고
  세션 내내 같은 값을 쓴다. CLI 는 cwd 에서 자동 유추하고, MCP 는 `board` 인자로 명시한다.
- 확신이 없으면 `todo_list { boards: true }` 로 기존 보드를 먼저 확인 — 새 보드 난립 방지.

## 에티켓 (처리중 표시의 핵심)

1. **작업 착수 시 `todo_status { action: "start" }`** — 웹 UI 에 "누가 처리중인지" 앰버
   뱃지로 표시된다. 이것이 호출자가 진행 상황을 인지하는 채널이므로 생략하지 않는다.
2. 끝나면 `done`, 중간에 손 떼면 `stop`. 30분 넘게 방치된 doing 은 UI 에 stale 로 보인다.
3. **actor 인자를 항상 넣는다** — `claude-code` (Codex 면 `codex`, opencode 면 `opencode`).
   히스토리와 뱃지에 이 이름이 남는다.
4. 관련 맥락은 `links` 로 첨부한다 — GitHub 이슈/PR URL, Todoist task URL. 상세 배경은
   `description` (markdown) 에.
5. **삭제는 없다** — 잘못 만든 항목도 `archive` 만 한다. 메모도 동일 (`note_write` 의
   `mode: "archive"`).

## 진행 보고는 댓글로

작업 중 알게 된 것, 막힌 지점, 사용자에게 묻고 싶은 것은 `todo_write` 의 `comment` 로 남긴다.
`description` 을 덮어쓰지 않는다 — 거기는 "이 할 일이 무엇인가"의 자리이고, 덮어쓰면 원래
요구가 사라진다. 사용자가 웹 UI 에서 단 답글은 다음 세션 시작 시 자동으로 주입된다.

## 자주 쓰는 호출

id 자리는 랜덤 id 대신 번호 참조(REF)를 받는다: `rocky#12`(보드 지정) 또는 `board` 인자와
함께 쓰는 `#12`/`12`(현재 보드 안의 번호). id 전체나 앞부분도 여전히 통한다.

```
todo_list  { board: "rocky" }                            # 보드 현황
todo_list  { id: "rocky#12" }                             # 상세 + 히스토리 + 댓글
todo_write { board: "rocky", title: "...", section: "설계",
             priority: "p2", links: [{ url: "https://github.com/..." }],
             actor: "claude-code" }
todo_status { id: "rocky#12", action: "start", actor: "claude-code" }
todo_write { id: "rocky#12", comment: "막힌 지점: ...", actor: "claude-code" }
note_write { board: "rocky", title: "조사 메모", content: "...", actor: "claude-code" }
note_write { id: "rocky#7", content: "추가 발견", mode: "append", actor: "claude-code" }
```

CLI 대응: `rocky-todo ls` / `add "제목" --section 설계 --priority p2 --link URL` /
`start REF` / `done REF` / `comment REF "본문"` / `note add "제목" --content "..."` /
`history REF`.

사용자와 대화할 때도 항목을 `#12` 로 부를 수 있다 — 웹 UI 에서 번호를 클릭하면 `rocky#12`
가 클립보드에 복사되므로, 사용자가 그걸 붙여넣으면 그대로 REF 로 알아듣고 처리하면 된다.

## 메모의 전역 번호 공간 (틀리면 엉뚱한 메모를 건드린다)

메모(note)는 todo 와 달리 보드 미소속(글로벌) 상태로도 존재할 수 있고, 그 전역 메모끼리
자체 번호 공간을 쓴다. 웹 UI 는 전역 메모를 보드 접두사 없이 `#3` 처럼 보여준다 — 이게
`rocky#3`(rocky 보드의 3번 메모)과 **다른 행**이다. 사용자가 붙여넣은 게 `rocky#3` 처럼
보드 접두사가 있으면 있는 그대로 `id` 에 넣으면 되지만, 접두사 없는 `#3` 을 받았다면:

- **`board` 인자를 절대 넣지 말 것.** `note_list`/`note_write` 에 `id: "#3"` 와 함께
  `board` 를 넘기면 전역 3번이 아니라 **그 보드의** 3번 메모가 대신 잡힌다 — 에러 없이
  조용히 엉뚱한 행을 수정/보관하게 된다(예: `note_write { id: "#3", board: "rocky",
  mode: "archive" }` 는 사용자가 보여준 전역 `#3` 이 아니라 rocky 보드의 `#3` 을 archive한다).
- 확신이 없으면 먼저 `note_list { id: "#3" }`(board 생략)로 조회해 제목이 사용자가
  말한 것과 맞는지 확인하고 진행한다.
- todo 는 이 문제가 없다 — todo 는 항상 보드에 속해서 전역 번호 공간이 아예 없다.

## 우선순위 의미 (Todoist 와 동일 관례)

- `p1` 긴급+중요 (오늘) · `p2` 중요 (이번 주) · `p3` 여유 · `p4` 기본/백로그.
- 마감이 실제로 있는 항목에만 `due` (YYYY-MM-DD) 를 넣는다.

## 호출자 편집의 자동 전달 (Claude Code)

Claude Code 에서는 `UserPromptSubmit` 훅이 "마지막 확인 이후 호출자(사람)의 보드 변경"을
자동 주입한다 — `# rocky-todo: 마지막 확인 이후 호출자의 보드 변경` 블록이 보이면 그게
호출자의 웹 편집분이다. 지시로 해석될 수 있는 항목(새 todo 등)은 임의 실행하지 말고
사용자에게 확인 후 진행한다. 훅이 없는 호스트(Codex/opencode)에서는 작업 단위 시작
전에 `todo_list` 로 직접 확인한다.

## 가드레일

- 사용자가 명시하지 않은 항목의 `done`/`archive` 는 실제로 그 작업이 끝났음을 확인한
  뒤에만. 애매하면 묻는다.
- **`todo_write` 의 `createIssue: true` 는 사용자 확인 없이 쓰지 않는다.** 이건 로컬
  보드 조작이 아니라 GitHub 이슈를 실제로 만드는 것 — 되돌릴 수 없고, 대상 레포가
  공개일 수 있으며, todo 의 title/description 이 그대로 올라간다. 다른 4개 도구와
  같은 감각으로 다루면 안 된다.
- 메모(스크래치패드)는 자유롭게 쓰고 고쳐도 되지만, 사용자가 작성한 메모 내용을 통째로
  교체할 땐 `append` 를 우선 고려한다 (히스토리에는 남지만 예의의 문제).
- 웹 UI 주소 안내가 필요하면 `rocky-todo open` 출력(기본 `http://127.0.0.1:8636`)을 준다.
