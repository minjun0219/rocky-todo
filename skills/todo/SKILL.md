---
name: todo
description: Use when managing the shared rocky-todo board from a session — planning work the user should see live in the web UI ("보드에 올려둬", "todo 정리해줘"), starting/finishing tracked work items, or leaving scratchpad notes for the user. Covers the rocky-todo daemon's MCP tools (todo_list / todo_write / todo_status / note_list / note_write) and the rocky-todo CLI fallback, the start→done etiquette that powers the "처리중" indicator, link-attachment conventions (GitHub issue / Todoist URLs), and the archive-only rule (no deletion exists).
---

# rocky-todo — 공유 작업 보드

로키(에이전트)와 호출자(사람)가 하나의 보드를 공유한다: 에이전트는 MCP/CLI 로 쓰고,
호출자는 웹브라우저(`http://127.0.0.1:8636`)에서 실시간(SSE)으로 보고 편집한다.
모든 변경은 누가-무엇을-언제 히스토리로 남는다.

## 도구 게이트 (먼저 확인)

- 세션에 `todo_list` / `todo_write` / `todo_status` / `note_list` / `note_write` MCP 도구가
  연결되어 있으면 그것을 쓴다 (rocky-todo 데몬의 `/mcp`).
- MCP 도구가 없으면 CLI 로 폴백: `rocky-todo <cmd>` (Bash). CLI 는 데몬이 죽어 있으면
  자동 기동한다. 레포에서 직접 실행할 땐 `bun run <rocky-repo>/src/todo/cli.ts <cmd>` 도 동일.
- CLI 가 "기본 비활성" 에러를 내면 rocky-todo 가 꺼져 있는 것 — user rocky.json 에
  `"todo": { "enabled": true }` 설정을 안내하고 멈춘다 (임의로 켜지 않는다).
- 둘 다 실패하면(데몬 기동 실패 등) 중단하고 사용자에게 `rocky-todo daemon status` 를 안내.
  가짜 진행을 만들지 않는다.

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

## 자주 쓰는 호출

```
todo_list  { board: "rocky" }                            # 보드 현황
todo_list  { id: "a1b2c3" }                              # 상세 + 히스토리
todo_write { board: "rocky", title: "...", section: "설계",
             priority: "p2", links: [{ url: "https://github.com/..." }],
             actor: "claude-code" }
todo_status { id: "a1b2c3", action: "start", actor: "claude-code" }
note_write { board: "rocky", title: "조사 메모", content: "...", actor: "claude-code" }
note_write { id: "z9y8x7", content: "추가 발견", mode: "append", actor: "claude-code" }
```

CLI 대응: `rocky-todo ls` / `add "제목" --section 설계 --priority p2 --link URL` /
`start ID` / `done ID` / `note add "제목" --content "..."` / `history ID`.

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
- 메모(스크래치패드)는 자유롭게 쓰고 고쳐도 되지만, 사용자가 작성한 메모 내용을 통째로
  교체할 땐 `append` 를 우선 고려한다 (히스토리에는 남지만 예의의 문제).
- 웹 UI 주소 안내가 필요하면 `rocky-todo open` 출력(기본 `http://127.0.0.1:8636`)을 준다.
