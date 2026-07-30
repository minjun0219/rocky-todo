# rocky-todo 기능 안내

rocky 의 동반 플러그인. 에이전트와 사람이 공유하는 로컬 작업 보드 데몬.

## Quick start

```bash
# 설치 (rocky 마켓플레이스 하나면 rocky-todo 도 설치 가능)
claude plugin marketplace add minjun0219/rocky
claude plugin install rocky-todo@rocky-marketplace     # rocky 자동 동반

# 웹 UI 열기 (호출자)
open http://127.0.0.1:8636        # 또는: rocky-todo open
```

설치 자체가 활성화다 — 별도 스위치 없음. 끄기는 `claude plugin disable rocky-todo`.

## MCP 도구 (에이전트)

| 도구 | 하는 일 |
| --- | --- |
| `todo_list` | 보드/항목 조회 (`{ board }` 현황, `{ id }` 상세+히스토리+댓글, `{ boards: true }` 보드 목록). `includeArchived` 는 `{ id }` 단건 조회에서 댓글까지 함께 통제한다 |
| `todo_write` | todo 생성/수정 (board, title, section, parentId, priority, due, labels, links, comment, createIssue, actor) |
| `todo_status` | 상태 전환 — `start` / `stop` / `done` / `reopen` / `archive` / `unarchive` |
| `note_list` | 스크래치패드 메모 조회 (보드 소속 or 글로벌) |
| `note_write` | 메모 생성/수정/append/archive (`mode`) |

엔드포인트: `http://127.0.0.1:8636/mcp` (streamable HTTP). Claude Code 는 플러그인이 자동 등록,
opencode/Codex 는 `rocky-todo mcp setup` 안내대로 수동 등록.

각 도구의 `id` 인자는 REF 문법(`rocky-12` / 맨숫자 `12` / id 전체 / id 앞부분)을 받는다 —
맨숫자처럼 보드 접두사 없는 번호를 쓰려면 같이 넘기는 `board` 인자가 그 컨텍스트가 된다.
옛 표기(`rocky#12` / `#12`)도 입력으로는 계속 받는다.

`createIssue: true` 를 주면 그 todo 를 GitHub 이슈로 만들고 URL 을 `links` 에 자동으로 붙인다
(보드에 repo 가 설정돼 있어야 한다 — 아래 CLI `board repo` 참고, `gh` CLI 필요).

## CLI (사람 / 스크립트 / 폴백)

```
rocky-todo ls [--board K|--all] [--archived] [--json]
rocky-todo add "제목" [--section S] [--parent REF] [--desc MD] [--due YYYY-MM-DD]
                     [--priority p1..p4] [--label a,b] [--link URL]
rocky-todo show|start|stop|done|reopen|archive|unarchive|update REF
rocky-todo comment REF "본문"
rocky-todo issue REF [--repo OWNER/NAME]           # GitHub 이슈로 (gh CLI 필요)
rocky-todo note add|ls|show|edit|append|archive
rocky-todo history REF [--global|--note] · board ls|add|repo|path · section ls · open
rocky-todo handoff REF [--session NAME] [--message "본문"]   # 실행 중인 세션에 작업 요청
rocky-todo handoff REF --cancel                              # 대기 중인 요청 취소
rocky-todo spawn REF [--message "본문"]                       # todo 전용 워크트리에 새 세션 띄우기
rocky-todo sessions                                          # 실행 중인 세션 목록 (* = 이 보드)
rocky-todo daemon run|start|stop|status|install|uninstall · mcp setup
rocky-todo tailscale on|off|status
```

REF 는 `rocky-12`(보드 지정, 가장 오른쪽 `-` 에서 갈린다) / 맨숫자 `12`(현재 보드의 번호) /
id 전체 / id 앞부분(유일하면) 중 아무거나 받는다. `todo ls` 는 항목마다 맨숫자만 보여준다 —
같은 저장소(cwd)에서는 그 번호를 그대로 다음 명령의 REF 로 쓰면 되고, 다른 보드를
가리키려면 `show` 로 얻은 전체 참조(`rocky-12`)나 `--board` 플래그를 쓴다. 옛 표기
(`rocky#12` / `#12`)도 입력으로는 계속 받는다. `note ls` 는 다르다 — 메모는 보드 컨텍스트가
없는 전역 번호 공간이라 맨숫자가 아니라 전체 참조(`note-3`)를 그대로 보여준다.
글로벌 메모(보드 미소속)는 번호가 `note-3` 으로 표시되며, `note show|edit|append|archive`
와 `history` 는 `--global` 을 붙여야 보드 번호와 헷갈리지 않고 그 공간을 조회한다. `note` 는
전역 메모 참조의 예약 접두사지만 보드 이름으로 쓰는 것 자체는 막지 않는다(레포 이름이
`note` 인 경우까지 막을 이유가 없다) — 다만 그 보드의 항목은 `note-3` 이 늘 전역 메모를
가리키도록 `note-N` 대신 raw id 로만 참조된다.
todo 와 메모는 같은 보드 안에서도 번호를 따로 매기므로 번호 `2` 가 둘 다일 수 있다 — `history` 는
기본적으로 todo 를 먼저 찾으니, 메모 쪽을 보려면 `--note`(보드 메모) 나 `--global`(전역 메모)로
대상을 확정한다.

보드 키는 생략 시 cwd 의 git repo 이름으로 유추. **삭제는 없다 — 아카이브만.**

## 설정 (`rocky.json`, user 레벨)

데몬은 전역 단일 인스턴스라 user `~/.config/rocky/rocky.json` 의 `todo` 블록만 본다
(project rocky.json 무시). **`enabled` 필드는 없다** (설치=활성화).

```json
{ "todo": { "port": 8636, "dir": "~/.config/rocky/todo", "expose": "off", "watch": true } }
```

| env | 의미 | 기본 |
| --- | --- | --- |
| `ROCKY_TODO_PORT` | 데몬 포트 | 8636 |
| `ROCKY_TODO_DIR` | 데이터 디렉터리 (todo.db 등) | `~/.config/rocky/todo` |
| `ROCKY_TODO_ACTOR` | CLI actor 이름 강제 | 호스트 자동 감지 |
| `ROCKY_TODO_WATCH` | 사람 변경 주입 훅 on/off | on |
| `ROCKY_TODO_EXPOSE` | 노출 채널 강제 (`lan,tailscale-serve` / `off`) | (config) |
| `ROCKY_CONFIG` | user rocky.json 경로 override | `~/.config/rocky/rocky.json` |

## 노출 범위 (`todo.expose`, 기본 이 머신만)

보드에 인증이 없으므로 노출은 전부 opt-in. `"lan"` = 내부망(0.0.0.0, 무인증 — 신뢰망 전용),
`"tailscale-serve"` = 테일넷 한정 HTTPS(루프백 유지). 배열로 조합. 자세한 표는
[docs/rocky-todo.md](./docs/rocky-todo.md) 참고.

노출되는 것은 **보드**다. GitHub 이슈 생성은 데몬 사용자의 `gh` 인증을 빌리므로 노출 대상이
아니다 — 노출 설정과 무관하게 **로컬(루프백)에서 직접 온 요청만** 이슈를 만들 수 있다
(REST 는 403, MCP 는 도구 에러). 노출된 화면에서는 웹 UI 가 버튼 대신 그 이유를 보여주고,
이미 만들어진 이슈로 가는 링크는 어디서든 열린다.

## 특징

- **계층/섹션/보드** — subtask(parentId), 섹션 그룹, 레포별 보드.
- **처리중 표시** — `start` 하면 웹 UI 에 actor + 경과 뱃지 (에이전트=앰버, 사람=블루).
  그 작업을 든 세션이 살아 있는지까지 본다: 세션이 사라졌으면 **"세션 없음"**, 살아 있는데
  턴이 끝났고 완료 처리가 없으면 **"멈춤"** 으로 뜬다. 세션을 대조할 수 없을 때만 예전처럼
  경과 30분을 기준으로 "오래됨" 을 붙인다.
- **히스토리** — 모든 mutation 이 누가/무엇을/언제로 자동 기록.
- **댓글** — todo 마다 시간순 대화. 에이전트의 진행 보고와 사용자의 답이 같은 타임라인에
  쌓이고, 사용자가 단 댓글은 다음 세션에 자동 주입된다. 삭제는 없다(보관만) — 보관된
  댓글은 웹 UI 의 "보관됨 표시" 토글로 흐리게 보이고 "보관 해제" 버튼으로 복원한다.
- **사람→에이전트 자동 전달** — Claude Code 의 UserPromptSubmit 훅이 사람의 보드 변경을 세션에 주입.
- **에이전트에게 작업 넘기기** — 보드의 todo 를 실행 중인 Claude Code 세션에 넘긴다. 드로어의
  "에이전트에게 보내기" 를 누르면 활성 세션 목록이 뜨고(보드 이름과 경로가 맞는 세션은 자동
  선택), 고른 세션이 **턴을 끝내는 순간 자동으로 그 항목에 착수**한다(`Stop` 훅). 사용자가
  그 세션에 다음 입력을 넣을 때도 같은 큐가 배달된다. 여러 건을 보내면 한 번에 하나씩
  순서대로 소화한다. 세션 목록은 `claude agents --json` 에서 얻으므로 `claude` CLI 가
  PATH 에 있어야 한다 — 없으면 이 버튼(과 `handoff`/`sessions` CLI)만 비활성되고 보드는
  정상 동작한다. 대기 중인 요청은 만료되지 않으며, 대상 세션이 사라지면 보드에 "세션 없음"
  으로 표시된다. 보낸 뒤에도 추적이 이어진다 — 세션이 **집어가 놓고 아무것도 안 하면**
  드로어에 "받았지만 착수하지 않았다" 와 **다시 보내기** 버튼이 뜬다(그 세션이 사라졌거나
  일을 멈췄을 때만 뜨고, 아직 작업 중이면 조용하다). 자동 재배달은 하지 않는다 — 다시
  보낼지는 사람이 정한다. CLI 대응: `rocky-todo sessions` /
  `handoff REF --session NAME --message "..."` / `handoff REF --cancel`.
- **새 세션 띄우기** — 실행 중인 세션이 없어도 넘길 수 있다. 드로어의 "새 세션 띄우기"
  버튼(또는 `rocky-todo spawn REF`)을 누르면 그 todo 전용 워크트리
  (`<메인 레포>/.claude/worktrees/todo-<번호>`)에 백그라운드 Claude Code 세션을 새로 띄우고
  작업 요청을 바로 프롬프트로 배달한다. 보드마다 메인 레포의 절대경로를 알아야 하며
  `rocky-todo board path <절대경로>`(생략 시 cwd) 또는 드로어 입력으로 설정한다. 워크트리
  생성·재사용은 Claude Code 몫이라 데몬은 이름만 결정론적으로 계산하고, 정리는
  `claude rm <id>` 로 한다(자동 삭제 없음 — 커밋 안 된 작업물을 지킨다). 같은 워크트리에
  세션이 이미 돌고 있으면 새로 띄우지 않고 기존 큐로 넘기며, 방금 띄운 직후(60초) 다시
  누르면 "잠시 후 다시 시도하라" 로 막는다 — 두 에이전트가 한 워크트리를 같이 고치는
  사고를 막는 가드다. 경로는 절대경로만 받고 실경로로 정규화해 저장한다. 이 버튼은
  **로컬(이 머신)에서만** 뜬다 — 이슈 생성과 같은 등급의 게이트다.
- **실시간 웹 UI** — Bun fullstack 자동 번들 + SSE (dist 없음, CDN 없음).
- 번호 버튼을 누르면 `/rocky-todo:board rocky-12` 가 클립보드에 들어간다 — 세션에
  그대로 붙여넣으면 그 항목을 맡아 착수한다.
- **URL 퍼머링크** — 주소가 보는 화면을 담는다: `/`(전체) · `/rocky`(보드) · `/rocky/12`(그
  todo 상세). 새로고침해도 유지되고 링크로 공유할 수 있다. board key `api`/`mcp`(데몬 라우트와
  충돌)와 `.`/`..`(브라우저가 `/` 로 정규화)는 만들 수는 있지만 URL 로 가리킬 수 없어 주소가
  `/` 로 남는다.
- **웹에서 편집·생성** — 제목 클릭 수정(Enter 저장/Esc 취소), 사이드바에서 보드 생성,
  상세에서 섹션 배치. 보드 key 규칙(공백·`#` 불가) 위반은 이유와 함께 표시된다.
  섹션 생성/보관은 CLI(`section add|archive`) — 에이전트가 정리하는 쪽이 자연스럽다.
- **GitHub 이슈 연동** — 웹 UI 상세의 `GitHub 이슈 만들기` 버튼 / CLI `issue` / MCP
  `todo_write.createIssue` 로 todo 를 이슈로 올린다. `gh` CLI 인증을 빌려쓰고 토큰은 저장하지
  않는다. 보드마다 GitHub 레포(`owner/name`)를 알아야 하며 `board repo` 로 설정하거나, 없으면
  cwd 의 git remote 에서 유추(CLI)하거나 입력받고(웹 UI), 실패하면 입력이 열린 채 남아
  고쳐 다시 시도하거나 이미 설정된 repo 를 바꿀 수 있다. 만들어진 이슈
  URL 은 그 todo 의 링크에 자동으로 붙는다. 이미 이슈가 있으면 다시 만들지 않고, 이슈 쪽
  변경(닫힘 등)이 todo 에 역으로 반영되지는 않는다. 만드는 것은 **로컬(루프백) 요청만** —
  노출된 표면(`todo.expose`)으로는 허용하지 않는다(위 "노출 범위" 참고).
