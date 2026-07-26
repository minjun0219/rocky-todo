# rocky-todo — 공유 todo / 스크래치패드 데몬

로키(에이전트)와 호출자가 하나의 작업 보드를 공유하는 로컬 데몬. 시스템에 **단 하나**만
떠서 Claude Code / opencode / Codex 의 모든 세션·모든 프로젝트가 같은 데이터를 본다.
**rocky 의 동반 플러그인** — 별도 레포(`minjun0219/rocky-todo`)의 독립 플러그인이지만
rocky 마켓플레이스가 함께 서빙한다.

```
                     ┌─ /            React 웹 UI (실시간 SSE)   ← 호출자 (브라우저)
에이전트/CLI ───────►│─ /api/*       REST                       ← CLI / 웹 UI
(MCP or CLI)         │─ /api/events  SSE 변경 브로드캐스트
                     └─ /mcp         MCP streamable HTTP        ← Claude Code / opencode / Codex
        데몬 (Bun, 127.0.0.1:8636) → SQLite ~/.config/rocky/todo/todo.db
```

- 계층(todo/subtask) + 섹션 + 보드(프로젝트) 단위, 우선순위(p1–p4)/라벨/마감일/링크 첨부.
- 처리중 표시: `start` 하면 웹 UI 에 actor + 경과가 앰버 뱃지로 뜬다 (30분+ 는 stale).
- **삭제 없음** — 모든 엔티티는 아카이브만 된다. 모든 변경은 히스토리(누가/무엇을/언제)로 남는다.
- 스크래치패드 메모: 보드 소속 or 글로벌, 에이전트/호출자 모두 편집 (웹 UI 인라인 편집).

## 설치 = 활성화

rocky-todo 는 **별도 스위치가 없다** — 플러그인 설치 자체가 활성화 경계다. rocky 마켓플레이스
하나만 추가하면 rocky 와 rocky-todo 둘 다 설치할 수 있다 (rocky-todo 는 명시할 때만 깔린다):

```bash
claude plugin marketplace add minjun0219/rocky
claude plugin install rocky@rocky-marketplace          # rocky 본체 (todo 안 따라옴)
claude plugin install rocky-todo@rocky-marketplace     # 공유 보드 데몬 (설치=활성화)
```

`rocky-todo` 는 `dependencies:["rocky"]` 를 선언하므로 rocky 가 자동 동반된다 (같은 마켓 안이라
해석이 깔끔). 런타임에 끄려면 `claude plugin disable rocky-todo`.

설치되면 플러그인이 두 가지를 배선한다:
- **`mcpServers` (http)** — 데몬의 `/mcp` (streamable HTTP, 도구 5개)를 세션에 등록. 수동
  `claude mcp add` 불필요.
- **hooks** — `SessionStart` 훅이 데몬을 기동하고, `UserPromptSubmit` 훅이 보드의 사람 변경을 주입.

> **첫 세션 순서 주의**: SessionStart 훅의 데몬 기동과 http MCP 초기화 순서는 보장되지 않는다.
> 첫 세션에서 MCP 가 `failed` 로 뜨면 `/mcp` 패널에서 retry 하거나 다음 세션이면 붙는다.
> 상시 상주(`daemon install`)면 이 창이 사라진다.

## 데몬 기동

설치 후엔 SessionStart 훅이 세션 시작 때 데몬을 자동 기동한다 (없으면 detached spawn, fail-open).
CLI 도 필요 시 온디맨드로 자동 기동한다. 로그인 시 상시 상주를 원하면:

```bash
rocky-todo daemon install     # launchd 등록 (KeepAlive) — macOS
rocky-todo daemon status      # 기동 여부 + launchd 상태
rocky-todo daemon uninstall
```

> **이미 `daemon install` 을 해둔 환경**은 plist 가 자동 갱신되지 않는다 — GitHub 이슈
> 기능(`gh` PATH 인식)을 쓰려면 `rocky-todo daemon uninstall && rocky-todo daemon install`
> 로 한 번 다시 깐다.

레포에서 직접 실행: `bun run src/daemon.ts` (포그라운드는 `rocky-todo daemon run`).

## 호스트별 MCP 등록

Claude Code 에서는 플러그인 설치로 자동 등록되므로 수동 작업이 필요 없다. **opencode / Codex** 는
플러그인 훅을 돌리지 않으므로 수동 등록한다. 데몬의 MCP 엔드포인트는 `http://127.0.0.1:8636/mcp`
(streamable HTTP, 도구 5개: `todo_list` / `todo_write` / `todo_status` / `note_list` / `note_write`).
`rocky-todo mcp setup` 이 스니펫을 출력한다.

**opencode** (`~/.config/opencode/opencode.json`):

```json
{ "mcp": { "rocky-todo": { "type": "remote", "url": "http://127.0.0.1:8636/mcp" } } }
```

**Codex** (`~/.codex/config.toml`, streamable HTTP 지원 버전):

```toml
[mcp_servers.rocky-todo]
url = "http://127.0.0.1:8636/mcp"
```

Codex 버전이 HTTP MCP 를 지원하지 않으면 CLI(`rocky-todo`)를 Bash 로 쓰면 된다 — 표면은 동일하다.
어느 호스트든 세션 시작 시 데몬이 떠 있어야 도구가 붙는다 — 상시 사용이면 `daemon install` 권장.

## 웹 UI — 번호 클릭 복사

목록의 각 행과 상세 드로어에는 랜덤 id 대신 사람이 읽을 수 있는 참조(`rocky#12`, 글로벌
메모는 `#3`)가 뜬다. 그 참조를 클릭하면 전체 참조 문자열이 클립보드로 복사된다 — 세션에
붙여넣어 "`rocky#12` 봐줘" 처럼 바로 부를 수 있게 하려는 용도다. `navigator.clipboard` 는
보안 컨텍스트(HTTPS 또는 루프백)에서만 동작하므로, 평문 LAN HTTP(`todo.expose: "lan"`)로
접속했을 때는 `execCommand` 폴백을, 그마저 안 되면 복사할 텍스트를 보여주는 프롬프트를 띄운다.

## 웹 UI — 퍼머링크

주소가 지금 보고 있는 화면을 담는다: `/`(전체 보기) · `/{board}`(그 보드) · `/{board}/{number}`
(그 todo 상세 열림 — 예: `/rocky/12` 는 사람이 쓰는 참조 `rocky#12` 와 대응). 보드를 고르면
주소가 바뀌고 **새로고침해도 그 보드가 유지된다**. todo 를 열면 주소가 `/{board}/{number}`
가 되어 그 주소를 그대로 건네면 상대가 같은 todo 의 상세를 연 화면을 본다. 드로어를 닫으면
주소가 보드 경로로 돌아가고, 브라우저 뒤로/앞으로가 드로어 열림·닫힘을 따라간다.

없는 보드(`/오타`)는 전체 보기로, 없거나 보관된 번호(`/rocky/999`)는 그 보드 화면으로 조용히
떨어진다 — 에러 화면을 띄우지 않는다. 주소에 꼬리가 붙은 링크(`/rocky/12/뭐든`)는 화면을
띄우면서 주소를 `/rocky/12` 로 정리한다 — 같은 화면이 여러 주소로 돌아다니지 않게 한다.
노트(메모) 상세와 `보관됨 표시` 토글은 주소에 담기지 않는다.

**URL 로 가리킬 수 없는 board key** 가 둘 있다. `api`/`mcp` 는 데몬의 `/api/*`·`/mcp` 라우트와
겹치고, `.`/`..` 는 브라우저 URL 파서가 `/` 로 정규화해 버린다. 이런 키의 보드도 만들고 쓰는
데는 아무 제약이 없다 — 다만 주소는 전체 보기와 같은 `/` 로 남고, 그 보드 안에서의 보드 선택·
상세 열기는 히스토리 항목을 만들지 않는다(되돌아갈 수 없는 주소라서). 그래서 그 보드에서
상세를 닫아도 보드 선택은 그대로 유지되고, 새로고침하면 전체 보기로 돌아간다.

## 웹 UI — 편집과 생성

- **제목 수정**: 상세 드로어의 제목을 클릭하면 입력창으로 바뀐다. Enter 저장, Esc 취소.
  빈 제목은 저장하지 않는다 (제목은 필수 필드).
- **보드 생성**: 사이드바 보드 목록 아래 `+ 새 보드`. key 에 공백이나 `#` 가 들어가면
  거절된다 — `my repo#1` 같은 해석 불가한 참조를 만들기 때문이다. 이유가 입력창 아래
  그대로 표시된다. `api`/`mcp`/`.`/`..` 는 거절되지 않고 만들어지지만, URL 로 가리킬 수
  없어 그 보드의 주소는 항상 `/` 로 남는다 (위 퍼머링크 절 참고).
- **섹션 배치**: 상세 드로어의 `섹션` 드롭다운으로 항목을 옮긴다. `(없음)` 이면 미분류로
  돌아온다. **섹션을 만들고 없애는 건 에이전트 몫이다** — 웹 UI 에는 생성 진입점이 없고
  `rocky-todo section add|archive` (또는 에이전트에게 요청)로 관리한다. 섹션이 사람이
  직접 다룰 만큼 자주 바뀌는 물건이 아니라서 UI 를 두지 않았다.
  - 항목이 없는 섹션은 목록에 뜨지 않는다 — 항목을 옮기면 그때 나타난다.
  - 보관한 섹션에 속해 있던 작업은 사라지지 않고 미분류로 돌아온다.

## 웹 UI — 댓글

상세 드로어는 히스토리와 댓글을 지라식으로 탭을 나누지 않고 **하나의 타임라인**으로 섞어
보여준다 — 에이전트의 진행 보고와 사람의 답이 시간순으로 같이 쌓인다.

- **작성**: 입력창에 쓰고 ⌘/Ctrl+Enter. **편집·보관은 웹 UI 전용이다** — CLI 는 작성만 한다.
- 댓글은 절대 작성 시각을 보여준다 — 오늘이면 `HH:MM`, 다른 날이면 `MM-DD HH:MM`.
- **삭제 없음** — 보관만. 보관해도 history 에는 남는다. 보관된 댓글은 사이드바의 "보관됨
  표시" 토글(todo/note 아카이브 뷰와 같은 스위치)을 켜면 카드가 흐리게 나타나고, 카드의
  "보관 해제" 버튼으로 되돌릴 수 있다.
- 목록 줄에는 `💬 N`(보관 제외 댓글 수) 배지가 뜨고, 마지막 댓글 이후 안 본 항목은 강조된다.
  읽음 커서는 `localStorage` 에만 있다 — 단일 사용자 로컬 데몬이라 서버측 읽음 상태는 두지
  않았다(다른 기기/브라우저에서는 다시 안 읽은 것으로 보인다).

## GitHub 이슈로 만들기

todo 하나를 GitHub 이슈로 올릴 수 있다 — 웹 UI 상세 드로어의 `GitHub 이슈 만들기` 버튼,
CLI `rocky-todo issue REF [--repo OWNER/NAME]`, MCP `todo_write { id, createIssue: true }`
셋 다 같은 경로를 탄다(새 MCP 도구가 아니라 기존 `todo_write` 의 필드다 — 도구는 여전히
5개). 만들어진 이슈 URL 은 그 todo 의 링크에 자동으로 붙고(제목은 `#<이슈번호>`), 기존
`updateTodo` 를 거치므로 히스토리·SSE·훅 주입에 그대로 실린다.

- **인증**: `gh` CLI 를 빌린다 — 토큰을 저장하지 않는다. `gh` 가 없거나 로그인 전이면 그
  사유를 그대로 보여준다(웹 UI 는 `role="alert"` 로 즉시 읽힌다).
- **보드마다 GitHub 레포(`owner/name`)를 알아야 한다** — 보드는 원래 key(=git remote
  basename)만 알아서 owner 를 모른다. 채우는 경로 셋:
  - `rocky-todo board repo [OWNER/NAME]` — 인자 없으면 cwd 의 git remote 에서 유추
  - `rocky-todo issue REF` 는 보드에 repo 가 없으면 cwd 에서 유추해 진행한다 — 저장은
    서버가 `gh` 성공 후 todo 의 실제 보드에 한다(CLI 는 더 이상 미리 PATCH 하지 않는다)
  - 웹 UI 는 버튼을 처음 누를 때 `OWNER/NAME` 입력을 받는다 — 이것도 `gh` 성공 후에만
    보드에 저장되고, 실패하면(오타 슬러그 등) 입력이 값을 유지한 채 다시 열린다
- 이미 이슈 링크가 있는 todo 는 다시 만들지 않는다. **역방향 동기화는 없다** — 이슈를
  닫아도 todo 는 자동으로 완료되지 않고, 이슈 본문/제목이 사후에 바뀌어도 todo 에는
  반영되지 않는다.
- **로컬(루프백) 요청만 이슈를 만들 수 있다.** `gh` 인증을 빌리기 때문이다 — 보드를 노출하는
  것(`todo.expose`)과 GitHub 계정 권한을 노출하는 것은 다른 얘기라, 노출 설정과 무관하게
  이 표면만 잠긴다. 노출된 주소로 접속한 브라우저는 버튼 대신 그 이유를 보고(이미 만들어진
  이슈로 가는 링크는 그대로 열린다), REST 는 403, MCP `todo_write` 는 도구 에러가 된다.
  `tailscale serve` 를 거친 접속도 마찬가지다 — 프록시가 루프백으로 중계하지만 중계 흔적
  (`X-Forwarded-*` / `Tailscale-User-*`)으로 구분한다. 폰에서 보드를 보다 이슈를 만들려면
  그 머신에서 CLI(`rocky-todo issue REF`)를 쓰거나 에이전트에게 시킨다.

## 사람→에이전트 자동 전달 (UserPromptSubmit 훅, Claude Code 전용)

에이전트→웹 방향은 SSE 로 실시간이고, 반대 방향은 **훅**이 닫는다: 사용자가 프롬프트를
보낼 때마다 플러그인의 `UserPromptSubmit` 훅이 데몬의 `/api/changes` 를 세션별 커서
이후로 읽어 **호출자(사람)의 변경만** 요약해 컨텍스트로 주입한다. 웹에서 todo 를 추가하고
아무 말이나 걸면 에이전트가 그 변경을 이미 알고 있는 구조다. 사람이 웹 UI 에서 단 댓글도
같은 경로로 주입된다(본문 200자 절단, 개행은 공백으로 정리).

- 결정론적 (LLM 미사용), fail-open — 데몬이 꺼져 있으면 조용히 no-op (훅이 데몬을 기동하진 않는다)
- 에이전트 자신의 변경(claude-code/codex/opencode)은 걸러서 자기 반향 없음
- 끄기: `rocky.json` `todo.watch: false` 또는 env `ROCKY_TODO_WATCH=0`

## 노출 범위 (`todo.expose` — 기본 이 머신만)

보드에 **인증이 없으므로** 노출은 전부 opt-in 채널이다. user `rocky.json` 의
`todo.expose` 에 채널을 넣는다 — 배열로 조합하거나, 하나면 문자열로:

```jsonc
{ "todo": { "expose": ["lan", "tailscale-serve"] } }   // 내부망 + 테일넷 동시
{ "todo": { "expose": "lan" } }                  // 내부망만
{ "todo": { "expose": "off" } }                  // 미설정과 동일 (기본)
```

| 채널 | 열리는 범위 | 바인딩 | 비고 |
| --- | --- | --- | --- |
| (없음) | 이 머신만 | 127.0.0.1 | 기본값 |
| `"lan"` | 같은 내부망의 모든 기기 (`http://<이 머신 IP>:8636`) | 0.0.0.0 | 무인증 — 집 등 신뢰망 전용. `rocky-todo open` 이 내부망 주소를 함께 출력 |
| `"tailscale-serve"` | 테일넷에 연결된 내 기기들 (HTTPS) | 127.0.0.1 유지 | tailscaled 프록시가 중계, 기동 시 `tailscale serve` 자동 보장. 테일넷 Serve 기능 첫 사용 시 관리 콘솔 1회 승인 필요 |

- env `ROCKY_TODO_EXPOSE`(콤마 구분)가 설정되면 config 를 통째로 덮어쓴다 — `off` 로 강제 차단.
- `tailscale-serve` 채널이 없으면 rocky-todo 는 tailscale 을 일절 건드리지 않는다 (회사 등 금지 환경).
  수동 제어: `rocky-todo tailscale on|off|status`.
- `tailscale funnel`(공인 인터넷 공개)은 지원하지 않는다 — 무인증 보드라 위험하다.
- 노출되는 것은 **보드**다. GitHub 이슈 생성은 어느 채널로도 열리지 않는다 — 로컬 요청
  전용이다 ([GitHub 이슈로 만들기](#github-이슈로-만들기) 참고).
- 데몬 설정 변경 후에는 재시작해야 반영된다: `rocky-todo daemon stop && rocky-todo daemon start`.
- 플러그인 업데이트는 다음 세션 시작 때 자동 반영된다 — SessionStart 훅이 실행 중인 데몬의
  버전을 확인해 구버전이면 내리고 새 버전으로 재기동한다 (보드 데이터는 `~/.config/rocky/todo`
  에 있어 그대로 보존). 즉시 반영하고 싶으면 `rocky-todo daemon stop` 후 아무 명령이나 실행.

## CLI 표면 (사람/스크립트/폴백)

```
rocky-todo ls [--board K|--all] [--archived] [--json]
rocky-todo add "제목" [--section S] [--parent REF] [--desc MD] [--due YYYY-MM-DD]
                     [--priority p1..p4] [--label a,b] [--link URL]
rocky-todo show|start|stop|done|reopen|archive|unarchive|update REF
rocky-todo comment REF "본문"
rocky-todo issue REF [--repo OWNER/NAME]           # GitHub 이슈로 (gh CLI 필요)
rocky-todo note add|ls|show|edit|append|archive
rocky-todo history REF [--global|--note] · board ls|add|repo · section ls · open
rocky-todo daemon run|start|stop|status|install|uninstall · mcp setup
rocky-todo tailscale on|off|status
```

REF 는 id 대신 사람이 읽을 수 있는 참조를 받는다: `rocky#12`(보드 지정) → `#12`/`12`
(현재 보드 안의 번호) → id 전체 → id 앞부분(유일하면) 순으로 해석한다. `ls` 출력의 `#12` 를
그대로 다음 명령의 REF 로 쓰면 된다. 랜덤 id 는 여전히 기본 키이고 `show` 상세 출력의
`id:` 줄에서 볼 수 있다. 보드 미소속 글로벌 메모는 번호가 `#3` 처럼 접두사 없이 표시되고,
그 번호를 보드 번호와 구분해 조회하려면 `note show|edit|append|archive`/`history` 에
`--global` 을 붙인다. todo 와 메모는 같은 보드 안에서도 번호 공간이 따로라 `#2` 가 둘 다일 수
있는데, `history` 는 todo 를 먼저 찾으므로 메모의 히스토리를 보려면 `--note`(보드 메모) 또는
`--global`(전역 메모)로 대상을 확정한다.

보드 키는 생략 시 cwd 의 git repo 이름으로 유추. actor 는 `--actor` >
`ROCKY_TODO_ACTOR` > 호스트 자동 감지 (claude-code / opencode / codex).

`show REF` 출력에는 링크·히스토리와 함께 `댓글:` 섹션(작성 시각 + actor + 본문)이 붙는다 —
히스토리 목록에서는 댓글 계열 항목을 걸러 중복을 없앤다. **댓글 편집·보관 CLI 명령은
없다** — 웹 UI 에서만 한다.

`#` 로 시작하는 REF 는 셸(bash/zsh)에서 주석 시작 문자로 해석되므로 반드시 따옴표로 감싼다:
`rocky-todo show '#12'`. 번호만 쓰면(`rocky-todo show 12`) 따옴표가 필요 없다.

## 설정

`rocky.json` (user 레벨 권장 — 데몬은 project rocky.json 을 보지 않는다). **`enabled` 필드는
없다** (설치=활성화):

```json
{ "todo": { "port": 8636, "dir": "~/.config/rocky/todo" } }
```

| env | 의미 |
| --- | --- |
| `ROCKY_TODO_PORT` | 데몬 포트 (기본 8636 — 키패드 "todo") |
| `ROCKY_TODO_DIR` | 데이터 디렉터리 (todo.db / daemon.pid / daemon.log / hook-cursors.json) |
| `ROCKY_TODO_ACTOR` | CLI actor 이름 강제 |
| `ROCKY_TODO_WATCH` | 보드 변경 주입 훅 on/off (기본 on) |
| `ROCKY_TODO_EXPOSE` | 노출 채널 강제 (`lan,tailscale-serve` / `off`) — 설정 시 config 무시 |
| `ROCKY_CONFIG` | user rocky.json 경로 override (기본 `~/.config/rocky/rocky.json`) |
