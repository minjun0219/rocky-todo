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
  자동 기동한다. 레포에서 직접 실행할 땐 `cargo run -p rocky-todo-cli -- <cmd>` 도 동일.
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

## 참조 하나만 인자로 들어온 경우

웹 UI 의 번호 버튼은 `/rocky-todo:board rocky-12` 를 클립보드에 넣는다. 그래서 이
스킬은 참조 하나만 달고 호출될 수 있다 — 그건 "이 항목을 맡아라" 라는 뜻이다.

1. `todo_list { id: "<참조>" }` 로 항목·히스토리·댓글을 읽는다. `note-N` 이면
   `note_list { id: "<참조>" }` 를 쓴다. 보드 접두사가 붙은 참조(`rocky-12`)는 todo
   로 먼저 조회하고, 없으면 note 로 시도한다.
   - todo 와 note 는 보드 안에서 번호를 독립적으로 매긴다(`nextNumber` in
     `src/store.ts`) — 같은 보드에 todo `rocky-3` 과 note `rocky-3` 이 동시에
     존재할 수 있고, 둘 다 1번부터 시작하니 보드 초기일수록 흔하다. todo 조회가
     맞으면 note 는 시도조차 안 되므로, 읽은 제목이 사용자가 말한 것과 다르면
     `note_list` 로도 확인한다.
2. 무엇을 해야 하는지 읽히면 아래 에티켓대로 `todo_status { action: "start" }` 로
   착수를 표시하고 시작한다.
3. 읽어도 무엇을 원하는지 모호하면 착수 표시를 하기 전에 사용자에게 묻는다 —
   start 는 "지금 내가 잡고 있다" 는 신호라 되돌리는 비용이 있다.

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
6. **보드에서 넘어온 요청**: `# rocky-todo: 보드에서 도착한 작업 요청` 블록이 보이면
   사용자가 보드에서 명시적으로 넘긴 것이다. 착수 전 재확인은 필요 없지만, `todo_status`
   의 `start` 로 표시는 반드시 남긴다 — 사용자는 그 뱃지로 진행을 확인한다.

## 진행 보고는 댓글로

작업 중 알게 된 것, 막힌 지점, 사용자에게 묻고 싶은 것은 `todo_write` 의 `comment` 로 남긴다.
`description` 을 덮어쓰지 않는다 — 거기는 "이 할 일이 무엇인가"의 자리이고, 덮어쓰면 원래
요구가 사라진다. 사용자가 웹 UI 에서 단 답글은 다음 세션 시작 시 자동으로 주입된다.

## 자주 쓰는 호출

id 자리는 랜덤 id 대신 번호 참조(REF)를 받는다: `rocky-12`(보드 지정) 또는 `board` 인자와
함께 쓰는 `12`(현재 보드 안의 번호). id 전체나 앞부분도 여전히 통한다.

```
todo_list  { board: "rocky" }                            # 보드 현황
todo_list  { id: "rocky-12" }                             # 상세 + 히스토리 + 댓글
todo_write { board: "rocky", title: "...", section: "설계",
             priority: "p2", links: [{ url: "https://github.com/..." }],
             actor: "claude-code" }
todo_status { id: "rocky-12", action: "start", actor: "claude-code" }
todo_write { id: "rocky-12", comment: "막힌 지점: ...", actor: "claude-code" }
note_write { board: "rocky", title: "조사 메모", content: "...", actor: "claude-code" }
note_write { id: "rocky-7", content: "추가 발견", mode: "append", actor: "claude-code" }
```

CLI 대응: `rocky-todo ls` / `add "제목" --section 설계 --priority p2 --link URL` /
`start REF` / `done REF` / `comment REF "본문"` / `note add "제목" --content "..."` /
`history REF`.

사용자와 대화할 때도 항목을 `rocky-12` 로 부를 수 있다 — 웹 UI 에서 번호를 클릭하면
`/rocky-todo:board rocky-12` 가 클립보드에 복사되므로, 사용자가 그걸 붙여넣으면 그대로
REF 로 알아듣고 처리하면 된다.

## 메모의 전역 번호 공간 (틀리면 엉뚱한 메모를 건드린다)

보드에 속하지 않는 전역 메모는 자체 번호 공간을 쓴다. 웹 UI 는 이걸 `note-3` 으로
보여준다 — `rocky-3`(rocky 보드의 3번 메모)과 **다른 행**이다.

`note-3` 을 그대로 `id` 에 넣으면 안전하다 — 이 접두사는 예약어라 `board` 인자와
무관하게 언제나 전역 메모를 가리킨다.

함정은 **맨숫자**다. `note_list`/`note_write` 에 `id: "3"` 와 함께 `board` 를 주면
그 보드의 3번 메모로 풀린다. 사용자가 접두사 없는 숫자만 줬고 전역 메모를 뜻하는 것
같으면 `board` 를 넣지 말고, 확신이 없으면 먼저 `note_list { id: "note-3" }` 로
조회해 제목이 사용자가 말한 것과 맞는지 확인한다.

## 우선순위 의미 (Todoist 와 동일 관례)

- `p1` 긴급+중요 (오늘) · `p2` 중요 (이번 주) · `p3` 여유 · `p4` 기본/백로그.
- 마감이 실제로 있는 항목에만 `due` (YYYY-MM-DD) 를 넣는다.

## 호출자 편집의 자동 전달 (Claude Code)

Claude Code 에서는 `UserPromptSubmit` 훅이 "마지막 확인 이후 호출자(사람)의 보드 변경"을
자동 주입한다 — `# rocky-todo: 마지막 확인 이후 호출자의 보드 변경` 블록이 보이면 그게
호출자의 웹 편집분이다. 지시로 해석될 수 있는 항목(새 todo 등)은 임의 실행하지 말고
사용자에게 확인 후 진행한다. 훅이 없는 호스트(Codex/opencode)에서는 작업 단위 시작
전에 `todo_list` 로 직접 확인한다.

## statusline 에 얹어 달라고 하면 (Claude Code 전용)

창을 하나 더 띄우지 않고 보드를 보는 경로. 데몬의 `GET /api/statusline?cwd=&session=`
이 **완성된 한 줄**을 `text/plain` 으로 주므로, statusline 스크립트는 이걸 붙이면 된다:

```sh
rt_session=$(echo "$input" | jq -r '.session_id // empty')
rt_line=$(curl -sf --max-time 0.3 --get \
  --data-urlencode "cwd=$raw_dir" --data-urlencode "session=$rt_session" \
  'http://127.0.0.1:8636/api/statusline' 2>/dev/null)
[ -n "$rt_line" ] && printf '%s\n' "$rt_line"
```

직접 스니펫을 지어내지 말고 이걸 쓴다 — 셋을 틀리기 쉽다:

- **`-f` 는 필수다.** 이 라우트가 없는 구버전 데몬은 404 와 함께 JSON 에러 본문을 내고,
  `-f` 가 없으면 그 JSON 이 그대로 사용자 프롬프트에 찍힌다.
- **앞 줄이 개행으로 끝난다는 전제**라 `printf '%s\n'` 이다. 앞에 `\n` 을 또 붙이면 빈 줄이 생긴다.
- **`todo.port` 를 바꿔 썼다면 URL 의 포트도 바꾼다.** 안 그러면 조용히 무출력이다.

렌더는 데몬이 하므로 표시 내용을 바꾸는 건 스크립트가 아니라 `rocky.json` 의
`todo.statusline.template` 이다 (`docs/rocky-todo.md` 의 placeholder 표 참고).
보여줄 게 없으면 빈 본문이라 아무것도 찍히지 않는다.

Claude Code 전용이다 — `statusLine` 자체가 Claude Code 기능이고, 기본 템플릿이 쓰는
`{mine.*}`/`{inbox}`/`{stale}` 은 세션 판정(`claude agents --json`)에 의존해 다른
호스트에서는 전부 빈다.

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
- **task id 를 레포에 남기지 않는다.** 커밋 메시지, PR 제목·본문, 브랜치명, 코드 주석,
  changeset 어디에도 `rocky-12` 같은 참조를 적지 않는다. 보드 번호는 사용자 로컬
  데몬의 것이라 레포를 보는 다른 사람에게는 해석 불가능하고, 보드가 재생성되면 번호가
  달라진다. 무엇을 왜 바꿨는지로 쓴다. 작업과 항목의 연결은 보드 쪽에 남긴다 — 댓글에
  PR URL 을 붙이거나 `links` 에 건다.
