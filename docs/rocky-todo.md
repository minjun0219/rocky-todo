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
- 처리중 표시: `start` 하면 웹 UI 에 actor + 경과가 앰버 뱃지로 뜬다. 그 작업을 든 세션이
  사라졌으면 "세션 없음", 살아 있는데 턴이 끝났고 완료 처리가 없으면 "멈춤" 으로 바뀐다
  (세션을 대조할 수 없을 때만 경과 30분 기준 "오래됨").
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
- **hooks** — `SessionStart` 훅이 데몬을 기동하고, `UserPromptSubmit` 훅이 보드의 사람 변경을
  주입하며, `Stop` 훅이 그 세션 앞으로 온 핸드오프 요청을 자동 착수시킨다(아래 "보드→세션
  핸드오프" 참고). 셋 다 플러그인 업데이트 후 **첫 세션부터** 적용된다.

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

> **PATH 회귀 수정 (재설치 필요)**: 이전 버전으로 `daemon install` 을 이미 해뒀다면
> `rocky-todo daemon install` 을 다시 실행하라 — plist 에 설치 시점 PATH 를 굽는 수정이라,
> 재설치해야 launchd 데몬이 `claude` CLI(핸드오프 기능이 쓴다)를 PATH 에서 찾는다.

## MCP 도구 5개 (에이전트)

| 도구 | 하는 일 |
| --- | --- |
| `todo_list` | 보드/항목 조회 (`{ board }` 현황, `{ id }` 상세+히스토리+댓글, `{ boards: true }` 보드 목록). `includeArchived` 는 `{ id }` 단건 조회에서 댓글까지 함께 통제한다 |
| `todo_write` | todo 생성/수정 (board, title, section, parentId, priority, due, labels, links, comment, createIssue, actor) |
| `todo_status` | 상태 전환 — `start` / `stop` / `done` / `reopen` / `archive` / `unarchive` |
| `note_list` | 스크래치패드 메모 조회 (보드 소속 or 글로벌) |
| `note_write` | 메모 생성/수정/append/archive (`mode`) |

각 도구의 `id` 인자는 아래 "CLI 표면" 의 REF 문법을 그대로 받는다 — 맨숫자(`12`)처럼 보드
접두사가 없는 번호는 같이 넘기는 `board` 인자가 그 컨텍스트가 된다. `createIssue: true` 는
그 todo 를 GitHub 이슈로 만들고 URL 을 `links` 에 붙인다 (아래 "GitHub 이슈로 만들기" 참고).

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

목록의 각 행은 랜덤 id 대신 번호만(예: `12`) 보여주고, 상세 드로어에는 보드 접두사가
붙은 전체 참조(`rocky-12`, 글로벌 메모는 `note-3`)가 뜬다. 어느 쪽을 클릭해도
`/rocky-todo:board rocky-12` 슬래시 커맨드가 클립보드로 복사된다 — 세션에 그대로
붙여넣으면 그 항목을 맡아 착수한다. `navigator.clipboard` 는
보안 컨텍스트(HTTPS 또는 루프백)에서만 동작하므로, 평문 LAN HTTP(`todo.expose: "lan"`)로
접속했을 때는 `execCommand` 폴백을, 그마저 안 되면 복사할 텍스트를 보여주는 프롬프트를 띄운다.

## 다음 작업 고르기 (`/rocky-todo:next`)

브라우저를 열지 않고 세션에서 바로 고르는 경로. `/rocky-todo:next` 를 치면 착수 후보를
랭킹해 보여주고, 고른 항목을 `start` 표시한 뒤 그 자리에서 시작한다. 참조를 알고 있으면
`/rocky-todo:next rocky-12` 로 픽커를 건너뛴다.

커맨드는 후보를 **텍스트 목록으로 그대로 보여주고** 번호나 참조로 고르게 한다 — 클릭형 선택
UI 는 쓰지 않는다(블록이 다 만들어져야 렌더돼서 목록이 늦게 나타난다).

랭킹은 CLI(`rocky-todo next`)와 같은 판정을 쓴다 — **주인 없는 진행중**(세션이 사라졌거나
멈춘 doing) → 마감(지남 > 오늘 > 7일 내) → 판정할 수 없는 진행중(사람이 잡은 것 등) →
우선순위 → 최근 댓글. 이 순서는 **뒤집히지 않는다**: 아래쪽 기준이 아무리 쌓여도 위쪽
기준을 넘지 못하므로, 마감 지난 p1 이 이어받을 p4 를 밀어내는 일은 없다. 살아 있는 세션이
붙들고 있는 항목과 **열린 자식을 가진 우산 항목**은 후보에서 빠진다. 근거는 목록에 그대로
찍힌다:

```
$ rocky-todo next
1. rocky-todo-22  데몬 라우트에 Origin 검사  — 이어받기(멈춤) · p2
2. rocky-todo-21  웹 UI 라이트 모드 마이그레이션  — p2 · 최근 댓글
```

고른 항목의 보드가 지금 레포와 다르면 어디서 할지(여기서 / 새 세션 spawn / 다른 세션
handoff)를 한 번 더 묻는다. 같은 레포면 묻지 않는다.

`--json` 은 `ls --json` 과 달리 **컴팩트 형태**다 — 고를 때 필요한 필드(`ref`·`number`·`board`
·`title`·`reason`·`priority`·`status`·`due`·`labels`·`commentCount` + 160자로 자른 `summary`)만
낸다. `description` 전문은 싣지 않는다 — 전문이 필요하면 `show REF`. 스크립트나 CLI 를 직접
부르는 호스트용이고, 커맨드는 텍스트 쪽을 쓴다.

## 웹 UI — 퍼머링크

주소가 지금 보고 있는 화면을 담는다: `/`(전체 보기) · `/{board}`(그 보드) · `/{board}/{number}`
(그 todo 상세 열림 — 예: `/rocky/12` 는 사람이 쓰는 참조 `rocky-12` 와 대응). 보드를 고르면
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

## 보드 메타 — 이름·key·설명·GitHub

보드는 자기 정체를 들고 있다. 보드를 열면 목록 위에 헤더가 뜨고(이름 · key · 한 줄 설명 ·
GitHub 링크 · 레포 경로), 오른쪽 `편집` 으로 그 자리에서 고친다 — 웹 폼은 네 필드를 다루고
`path` 는 표시만 한다(그건 spawn 이 자기 입력창에서 받는다). CLI 는 다섯 다 고친다:

| 항목 | 무엇 | CLI |
| --- | --- | --- |
| `title` | 사람이 읽는 이름 (사이드바에 뜨는 값) | `board title "Tally"` |
| `key` | 참조 접두사(`tally-12`)이자 레포 이름으로 유추되는 식별자 | `board rename tally` |
| `description` | "이 보드가 무엇인가" 한 줄 | `board desc "가계부 앱"` (인자 없으면 지움) |
| `repo` | GitHub `owner/name` — 이슈 생성 대상 | `board repo OWNER/NAME` |
| `path` | 메인 레포 절대경로 — spawn 이 워크트리를 만드는 자리 | `board path [절대경로]` |

`rocky-todo board show [KEY]` 로 한 보드의 전부를 본다. `board ls` 는 설명까지 한 줄로 붙인다.

**key 를 바꿔도 옛 참조는 죽지 않는다.** 옛 key 는 별칭으로 남아 입력으로 계속 받는다 —
히스토리·댓글·GitHub 이슈 본문에 박힌 `gotgan-12` 도, 훅/CLI 가 cwd 에서 유추해 보내는 옛
`board` 인자도 그대로 그 보드로 풀린다. 반대로 **내보내는 문자열은 언제나 새 key** 다
(`refOf`). 그 대가로 한 번 쓴 key 는 은퇴한다 — 다른 보드가 그 이름을 다시 가질 수 없고,
시도하면 `board key already in use` 로 거절된다.

- key 는 만들 때와 같은 검증을 받는다 — 공백과 `#` 는 참조로 되읽을 수 없어 거절된다.
- 이름을 바꾸는 목적은 보통 `key` 를 레포 디렉터리 이름에 **맞추는** 것이다. 반대로
  어긋나게 두면 잃는 게 하나 있다: 세션 ↔ 보드 자동 매칭은 세션 cwd 의 경로 세그먼트에
  key 가 나타나는지로 판정하므로(핸드오프 대상 고르기, 방치된 doing 판정) 디렉터리 이름과
  다른 key 는 후보를 못 찾는다 — 기능이 죽지는 않고 사람이 대상을 직접 고르게 된다.
  statusline 의 보드 판정은 다르다 — `boards.path` 를 먼저 보므로 경로만 설정돼 있으면
  이름이 어긋나도 정확하다.
- 웹 UI 헤더는 옛 이름이 있으면 `옛 이름 gotgan` 칩으로 보여준다 — 그 참조가 아직
  살아 있다는 걸 아는 유일한 자리다.

REST 로는 `PATCH /api/boards/:key` 하나가 다섯 필드를 **함께** 받는다(한 트랜잭션이라
부분 적용이 없다). `null` 은 "지운다"이고 빈 문자열은 400 — 폼이 실수로 비워 보낸 값이
설정을 날리지 않게 하려는 구분이다.

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

## 보드 → 세션 핸드오프 (턴 경계 배달, Claude Code 전용)

보드의 todo 를 실행 중인 Claude Code 세션에 넘길 수 있다 — 웹 UI 드로어의 "에이전트에게
보내기" 버튼, 또는 `rocky-todo handoff REF [--session NAME] [--message "본문"]`. 데몬은
세션에 아무것도 밀 수 없으므로 요청은 큐에 쌓이고, 대상 세션이 **턴 경계**에 이를 때
훅이 집어간다 — `UserPromptSubmit`(턴 시작) 또는 `Stop`(턴 끝, `decision: block` 으로 그
자리에서 착수). 한 번에 한 건씩 순서대로 소화한다.

> **큐잉은 배달이 아니다.** 턴 경계가 와야 배달되므로 **idle 세션은 아무 일도 일어나지
> 않는다** — 누군가 그 세션의 턴을 열어줘야 한다. 그래서 `handoff` 응답(`--json`)에는
> `poke: { to, message }` 가 함께 온다. 에이전트라면 그대로 `SendMessage` 로 보내면 되고
> (그 메시지가 여는 바로 그 턴에 훅이 상세 지시를 주입한다), 사람이라면 그 세션에 아무
> 입력이나 한 줄 넣으면 된다. CLI 출력도 이 두 갈래를 그대로 안내한다.

운영자가 알아둘 것:
- **`claude` CLI 가 PATH 에 있어야 동작한다** — 세션 목록(`rocky-todo sessions`, 웹 UI 드로어의
  세션 선택창)이 `claude agents --json` 을 실행해서 얻기 때문이다. 없으면 이 기능(버튼 +
  `sessions`/`handoff` CLI)만 비활성되고, 보드의 나머지 기능은 정상 동작한다.
- **`Stop` 훅은 신규다** — 플러그인을 이 버전으로 업데이트하면 다음 세션이 아니라 **그 세션의
  다음 Stop 이벤트부터** 곧바로 적용된다(훅 등록 자체는 SessionStart 때가 아니라 플러그인
  설치 시점에 이미 반영되어 있다).
- 대상 세션은 보드 key 와 세션 cwd 의 **경로 세그먼트** 매칭으로 고른다 — 후보가 정확히 1개면
  자동으로 그 세션에 보내고, 여러 개면 웹 UI/CLI 에서 직접 골라야 한다.
- 대기 중인 요청에 TTL 은 없다 — 대상 세션이 종료돼도 큐에는 남고 "세션 없음"(stale)으로만
  표시된다. 취소하려면 웹 UI 의 취소 버튼 또는 `rocky-todo handoff REF --cancel`.
- **배달 이후도 추적한다.** 세션이 요청을 집어간 뒤 그 항목에 `start`(또는 start 를 건너뛴
  `done`)를 부르면 "착수함"으로 기록되고, `done` 이면 "완료"까지 남는다. 집어가 놓고
  아무것도 하지 않으면 드로어에 "받았지만 착수하지 않았다" 와 **다시 보내기** 버튼이 뜬다.
  판정에 시간 제한은 없다 — 대상 세션이 사라졌거나 일을 멈춘 상태일 때만 뜨고, 아직 작업
  중이면 조용하다. 자동 재배달은 하지 않는다(다시 보내면 새 요청이 생기고 원래 기록은
  남는다) — "보냈는데 조용히 사라졌다" 를 만들지 않기 위해서다.
- MCP 도구는 늘지 않았다 — 여전히 5개(`todo_list` / `todo_write` / `todo_status` /
  `note_list` / `note_write`). 핸드오프는 사람이 세션에 넘기는 경로이지, 에이전트가 호출하는
  도구가 아니다.

## 보드 → 새 워크트리 세션 (spawn, 로컬 전용)

실행 중인 세션이 없어도 보드에서 바로 새 작업을 시작시킬 수 있다 — 웹 UI 드로어의
"새 세션 띄우기" 버튼, 또는 `rocky-todo spawn REF [--message "본문"]`. 데몬은 git 을
전혀 만지지 않는다 — `claude --bg --worktree todo-<번호>` 를 실행해 **Claude Code 에게
워크트리 생성을 맡긴다.**

- **경로 설정**: 보드마다 메인 레포의 절대경로(`boards.path`)를 알아야 spawn 이 동작한다.
  `rocky-todo board path [절대경로]`(인자 없으면 지금 있는 cwd) 또는 웹 UI 가 처음 누를 때
  띄우는 입력창으로 설정한다 — GitHub 이슈의 `board repo` 와 같은 모양으로, spawn 이
  성공한 뒤에만 보드에 저장된다(오타난 경로가 실패와 무관하게 눌어붙지 않는다).
  **상대경로는 거부한다**(400) — 데몬은 launchd/훅이 임의의 자리에서 띄우므로 상대경로가
  어느 레포로 풀릴지 알 수 없다. 심볼릭 링크와 `..` 은 실경로로 정규화해서 쓰고 저장한다
  — 동시 실행 가드가 `claude agents --json` 의 cwd 와 문자열로 비교하기 때문이다.
- **워크트리가 쌓이는 자리**: `<메인 레포>/.claude/worktrees/todo-<번호>`, 브랜치는
  `worktree-todo-<번호>`. 같은 todo 번호로 다시 누르면 Claude Code 가 기존 워크트리를
  재사용한다 — 워크트리 이름 자체가 "이 todo 의 워크트리" 라는 기억이라 데몬은 따로
  저장하지 않는다.
- **정리**: `claude rm <짧은 id>` 가 워크트리와 job state 를 함께 지운다. git 명령으로
  직접 지우려면 Claude Code 가 걸어둔 lock 때문에 `git worktree remove -f -f` 가 필요하다.
  **자동 삭제는 없다** — 커밋되지 않은 작업물이 조용히 사라지는 것이 이 기능에서 가장
  나쁜 실패라, 워크트리는 명시적으로 지울 때까지 남는다.
- **동시 실행 가드**: 그 워크트리에서 이미 도는 세션(백그라운드든 사람이 연 interactive
  세션이든)이 있으면 새로 띄우지 않고 기존 핸드오프 큐로 넘긴다(`reused: true`) — 두
  에이전트가 한 워크트리를 같이 고치는 사고를 막는다. 이 판정만은 **캐시 없는** 세션
  목록으로 한다(다른 조회는 TTL 3초 캐시를 쓴다). 새 세션이 `agents --json` 에 등록되기
  전의 틈은 데몬이 "방금 띄운 워크트리" 를 60초 기억해 메운다 — 그 창 안의 재요청은
  409 다(버튼 두 번 누르기/두 탭). 잠시 후 다시 누르면 된다. 이 기억은 세션을 **띄우기
  전에** 잡고 실패하면 되돌린다 — 그래야 두 탭에서 동시에 눌러도 하나만 통과하고,
  실패한 시도가 60초 동안 재시도를 막지 않는다.
- **로컬(루프백) 요청만** — GitHub 이슈 생성과 같은 등급의 게이트다. 보드 쓰기 권한이
  "이 기계에서 파일을 고치는 프로세스를 띄우는 권한" 으로 확대되는 지점이라, `todo.expose`
  로 `lan`/`tailscale-serve` 를 열어도 그 화면에는 "새 세션 띄우기" 버튼이 뜨지 않는다
  (`/api/health` 의 `spawnAllowed` 를 보고 웹 UI 가 버튼 대신 이유를 보여준다 — 강제는
  서버가 한다). 원격에서 띄우려면 그 머신에서 CLI(`rocky-todo spawn REF`)를 쓰거나
  에이전트에게 시킨다.
- **승인 프롬프트에서 멈춘 세션은 보드가 모른다** — `state` 가 그때도 `working` 으로
  보인다. 드로어와 `rocky-todo sessions` 가 보여주는 짧은 id 로 `claude attach <id>` 하면
  붙어서 승인을 처리할 수 있다.
- **`--permission-mode` 는 넘기지 않는다** — 사용자 settings 의 `permissions.defaultMode`
  를 그대로 따른다.
- MCP 도구는 늘지 않았다 — spawn 은 사람이 보드에서 누르는 버튼으로만 남는다.

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

- 핸드오프 "보내기"(`POST /api/todos/:ref/handoff`)와 세션 목록(`GET /api/sessions`)은
  노출 채널을 그대로 타 원격에서도 된다 — 의도된 동작(폰에서 보드 보다 보내기). **새 세션
  띄우기(`POST /api/todos/:ref/spawn`)는 다르다** — 이슈 생성과 같이 노출 설정과 무관하게
  로컬 요청만 받는다(위 "보드 → 새 워크트리 세션" 참고). `claim`(`POST /api/handoffs/claim`)
  은 훅 전용이라 루프백(127.0.0.1/::1) 요청만 받는다 —
  훅은 항상 로컬에서 붙으니 기능 손실은 없다. 판정은 이슈 생성과 같은 `isLocalRequest`
  를 쓴다 — **소스 주소가 루프백이고 동시에 중계 헤더가 없어야** 로컬로 본다. 주소만
  보면 부족하기 때문이다:
  - `lan` 은 데몬이 `0.0.0.0` 에 직접 바인딩하므로 원격 요청의 소스 주소가 실제 LAN IP 로
    보인다 — 주소만으로 걸러진다.
  - `tailscale-serve` 는 데몬이 계속 127.0.0.1 에만 바인딩하고 tailscaled 의 로컬 프록시가
    테일넷 요청을 다시 `127.0.0.1:<port>` 로 다이얼해 전달한다(위 표의 "바인딩" 참고).
    그래서 소스 주소는 항상 127.0.0.1 이지만, tailscale serve 가 붙이는
    `Tailscale-User-*` 헤더가 남으므로 **이 요청도 404 로 막힌다.**

  헤더는 위조로 "있게" 만들 수는 있어도 "없게" 만들 수는 없다 — 위조는 요청을 덜
  신뢰하는 방향으로만 작용하므로 이 판정을 우회하는 데 쓸 수 없다.
- env `ROCKY_TODO_EXPOSE`(콤마 구분)가 설정되면 config 를 통째로 덮어쓴다 — `off` 로 강제 차단.
- `tailscale-serve` 채널이 없으면 rocky-todo 는 tailscale 을 일절 건드리지 않는다 (회사 등 금지 환경).
  수동 제어: `rocky-todo tailscale on|off|status`.
- **기동 시 자동 보장은 남의 노출을 빼앗지 않는다.** `tailscale serve` 의 노출 지점은 443 의
  `/` 하나뿐인 머신 공유 자원인데, 데몬의 단일 인스턴스 보장은 *같은 포트* 기준이라 다른
  포트로 뜬 개발/데모 인스턴스가 설치본과 나란히 존재할 수 있다. 그래서 기동 시에는 현재
  serve 대상 포트를 먼저 확인해서, 거기에 **살아 있는 다른 rocky-todo 데몬**이 있으면
  양보하고(그 인스턴스는 테일넷에 노출되지 않는다) 아무도 안 듣는 죽은 포트면 되찾는다.
  일부러 넘기고 싶을 땐 명시적으로 `rocky-todo tailscale on` — 수동 경로는 그대로 인수한다.
- `tailscale funnel`(공인 인터넷 공개)은 지원하지 않는다 — 무인증 보드라 위험하다.
- 노출되는 것은 **보드**다. GitHub 이슈 생성은 어느 채널로도 열리지 않는다 — 로컬 요청
  전용이다 ([GitHub 이슈로 만들기](#github-이슈로-만들기) 참고).
- **다른 사이트가 시킨 변경은 거부한다(403).** 데몬은 무인증이라, 사용자가 방문한 아무
  페이지나 루프백으로 폼을 POST 하면 소스 주소 기반 로컬 게이트를 그대로 통과한다. 그래서
  변경 메서드(POST/PATCH/PUT/DELETE)는 브라우저가 붙이는 `Sec-Fetch-Site` 를 먼저 보고
  `cross-site` 면 라우트에 닿기 전에 끊는다(그 헤더가 없는 구형 브라우저는 `Origin` 으로
  판정). CLI·훅·MCP 클라이언트는 두 헤더를 아예 안 보내므로 영향이 없고, 웹 UI 는 자기
  화면이라 `same-origin` 이다. `tailscale serve` 를 거친 화면도 정상 동작한다 —
  `Sec-Fetch-Site` 는 브라우저가 계산한 값이라 프록시가 `Host` 를 바꿔도 흔들리지 않는다.
- 데몬 설정 변경 후에는 재시작해야 반영된다: `rocky-todo daemon stop && rocky-todo daemon start`.
- 플러그인 업데이트는 다음 세션 시작 때 자동 반영된다 — SessionStart 훅이 실행 중인 데몬의
  버전을 확인해 구버전이면 내리고 새 버전으로 재기동한다 (보드 데이터는 `~/.config/rocky/todo`
  에 있어 그대로 보존). 즉시 반영하고 싶으면 `rocky-todo daemon stop` 후 아무 명령이나 실행.

## CLI 표면 (사람/스크립트/폴백)

```
rocky-todo ls [--board K|--all] [--archived] [--json]
rocky-todo next [--board K|--all] [--limit N] [--json]   # 착수 후보 랭킹 (다음에 뭘 할까)
rocky-todo add "제목" [--section S] [--parent REF] [--desc MD] [--due YYYY-MM-DD]
                     [--priority p1..p4] [--label a,b] [--link URL]
rocky-todo show|start|stop|done|reopen|archive|unarchive|update REF
rocky-todo comment REF "본문"
rocky-todo issue REF [--repo OWNER/NAME]           # GitHub 이슈로 (gh CLI 필요)
rocky-todo note add|ls|show|edit|append|archive
rocky-todo history REF [--global|--note] · section ls · open
rocky-todo board ls|show [KEY]|add KEY [제목]      # 보드 메타 — 아래 "보드 메타" 참고
rocky-todo board rename NEWKEY|title "제목"|desc ["설명"]|repo [OWNER/NAME]|path [절대경로]
rocky-todo handoff REF [--session NAME] [--message "본문"] · handoff REF --cancel
rocky-todo spawn REF [--message "본문"]            # todo 전용 워크트리에 새 세션 띄우기 (로컬 전용)
rocky-todo sessions
rocky-todo daemon run|start|stop|status|install|uninstall · mcp setup
rocky-todo tailscale on|off|status
```

REF 는 id 대신 사람이 읽을 수 있는 참조를 받는다: `rocky-12`(보드 지정, 가장 오른쪽 `-` 에서
갈린다) → 맨숫자 `12`(현재 보드 안의 번호) → id 전체 → id 앞부분(유일하면) 순으로 해석한다.
옛 표기(`rocky#12` / `#12`)도 입력으로는 계속 받는다. `todo ls` 는 항목마다 맨숫자만
보여준다 — 같은 저장소(cwd)에서는 그 번호를 그대로 다음 명령의 REF 로 쓰면 되고, 다른
보드를 가리키려면 `show` 로 얻은 전체 참조(`rocky-12`)나 `--board` 플래그를 쓴다. `note ls`
는 다르다 — 메모는 보드 컨텍스트가 없는 전역 번호 공간이라 맨숫자가 아니라 전체 참조
(`note-3`)를 그대로 보여준다. 랜덤 id 는
여전히 기본 키이고 `show` 상세 출력의 `id:` 줄에서 볼 수 있다. 보드 미소속 글로벌
메모는 번호가 `note-3` 으로 표시되고,
그 번호를 보드 번호와 구분해 조회하려면 `note show|edit|append|archive`/`history` 에
`--global` 을 붙인다. `note` 는 전역 메모 참조의 예약 접두사지만 보드 이름으로 쓰는 것
자체는 막지 않는다 — 다만 그 보드의 항목은 `note-3` 이 늘 전역 메모를 가리키도록
`note-N` 대신 raw id 로만 참조된다. todo 와 메모는
같은 보드 안에서도 번호 공간이 따로라 번호 `2` 가 둘 다일 수 있는데, `history` 는 todo 를
먼저 찾으므로 메모의 히스토리를 보려면 `--note`(보드 메모) 또는 `--global`(전역 메모)로
대상을 확정한다.

보드 키는 생략 시 cwd 의 git repo 이름으로 유추. actor 는 `--actor` >
`ROCKY_TODO_ACTOR` > 호스트 자동 감지 (claude-code / opencode / codex).

`show REF` 출력에는 링크·히스토리와 함께 `댓글:` 섹션(작성 시각 + actor + 본문)이 붙는다 —
히스토리 목록에서는 댓글 계열 항목을 걸러 중복을 없앤다. **댓글 편집·보관 CLI 명령은
없다** — 웹 UI 에서만 한다.

`rocky-12` 나 맨숫자 `12` 는 셸에서 그대로 쓸 수 있다: `rocky-todo show rocky-12`. 옛 표기
(`#12` 등)처럼 `#` 로 시작하는 REF 는 bash/zsh 에서 주석 시작 문자로 해석되므로 따옴표로
감싼다: `rocky-todo show '#12'`.

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
| `ROCKY_TODO_STATUSLINE` | statusline 템플릿 강제 (아래 "statusline 에 얹기") |
| `ROCKY_CONFIG` | user rocky.json 경로 override (기본 `~/.config/rocky/rocky.json`) |

## statusline 에 얹기

보드를 보려고 브라우저 창이나 터미널 pane 을 따로 띄우는 대신, 이미 떠 있는 Claude Code
statusline 에 세그먼트 하나로 붙인다. **보여줄 게 없으면 아무것도 출력하지 않는다.**

`GET /api/statusline?cwd=<경로>&session=<세션 id>` 가 완성된 한 줄을 `text/plain` 으로
돌려준다 — 렌더까지 데몬이 하므로 소비자 쪽은 `curl` 한 줄이면 된다. 이 자리는 1초마다 ×
열어둔 세션 수만큼 도는 곳이라, 여기서 `bun` 을 띄우지 않는 것이 설계 목적이다.

`~/.claude/statusline-command.sh` 끝에 (또는 `settings.json` 의 `statusLine.command` 에)
이어 붙인다 — 입력 JSON 에서 두 값을 꺼내 쓴다:

```sh
cwd=$(echo "$input" | jq -r '.workspace.current_dir // empty')
sid=$(echo "$input" | jq -r '.session_id // empty')
rt=$(curl -sf --max-time 0.3 "http://127.0.0.1:8636/api/statusline?cwd=$cwd&session=$sid")
[ -n "$rt" ] && printf '%s\n' "$rt"
```

(앞선 줄이 개행으로 끝난다는 전제다 — 보통 `printf '...\n'` 로 끝나므로 여기서 `\n` 을
앞에 또 붙이면 빈 줄이 하나 생긴다.)

`-f` 를 빼지 마라. 데몬이 안 떠 있으면 `curl` 이 빈 값을 내지만, **이 라우트가 없는 구버전
데몬**은 404 와 함께 JSON 에러 본문을 낸다 — `-f` 가 없으면 그 JSON 이 그대로 statusline 에
찍힌다. `-f` 는 비 2xx 응답을 무출력으로 만들어 두 경우를 같게 만든다 (fail-open —
statusline 이 보드 때문에 깨지지 않는다).

**환경 전제 셋** — 새 머신에 붙일 때 걸리는 것들이다:

- **Claude Code 전용.** `statusLine` 자체가 Claude Code 기능이고, 기본 템플릿이 쓰는
  `{mine.*}`/`{inbox}`/`{stale}` 은 세션 판정(`claude agents --json`)에 의존한다 —
  opencode/Codex 에서는 전부 비어 `{doing}` 만 남는다.
- **포트를 바꿔 썼으면** (`todo.port`) URL 의 포트도 같이 바꾼다. 안 그러면 조용히 무출력이다.
- **`jq` 가 필요하다.** statusline 입력은 stdin JSON 이라 파서 없이는 값을 못 꺼낸다.

배선은 머신마다 수동이다 — 플러그인은 사용자의 statusline 스크립트를 건드리지 않는다.

### 템플릿

`rocky.json` 의 `todo.statusline.template` 로 바꾼다. 기본값:

```
[⏺ {mine.ref} {mine.title}][ 💬{mine.comments}][  ✉{inbox}][  ⚠{stale}]
```

문법은 둘뿐이다.

- `{name}` — 값으로 치환. 모르는 이름은 그대로 남는다(오타가 눈에 보이라고).
- `[...]` — 옵셔널 그룹. 안의 placeholder 가 **전부** 비면 그룹이 통째로 사라진다.
  숫자 `0` 은 "빈 값"이다. placeholder 가 없는 그룹은 순수 장식이라 늘 남는다.

| placeholder | 뜻 |
| --- | --- |
| `{mine.ref}` / `{mine.title}` | **이 세션이** `doing` 으로 잡은 항목 (제목은 30자에서 절단) |
| `{mine.comments}` | 그 항목의 댓글 수 — 사람이 댓글을 달면 다음 갱신에 숫자가 올라간다 |
| `{inbox}` | 이 세션 앞으로 대기 중인 핸드오프 수 |
| `{stale}` | 이 보드에서 방치된 `doing` 수 (세션이 사라졌거나 턴이 끝났는데 완료가 없다) |
| `{doing}` | 이 보드의 전체 `doing` 수 |

`{mine.*}` 은 핸드오프로 시작된 작업에만 붙는다 — 세션 귀속(`doing_session_id`)이 생기는
유일한 경로라서다. 보드 판정은 `cwd` 로 하며 워크트리도 원본 보드로 모인다.

색을 넣으려면 템플릿에 ANSI 이스케이프를 직접 쓴다(JSON 문자열이라 `\u001b` 가 그대로
들어간다). 이스케이프 안의 `[` 는 그룹 문법으로 읽지 않는다:

```json
{ "todo": { "statusline": { "template": "[\u001b[33m⏺ {mine.ref}\u001b[0m {mine.title}][  ⚠{stale}]" } } }
```
