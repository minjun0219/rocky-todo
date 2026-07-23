# rocky-todo — 공유 todo / 스크래치패드 데몬

로키(에이전트)와 호출자가 하나의 작업 보드를 공유하는 로컬 데몬. 시스템에 **단 하나**만
떠서 Claude Code / opencode / Codex 의 모든 세션·모든 프로젝트가 같은 데이터를 본다.

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

## 활성화 (기본 off)

상주 데몬을 띄우는 기능이라 **기본 비활성**이다. user `rocky.json` 에서 켠다:

```json
{ "todo": { "enabled": true } }
```

꺼져 있으면 훅·CLI 자동 기동·데몬이 전부 침묵한다 (env `ROCKY_TODO_ENABLED` 가 우선).

## 데몬 기동

활성화 후에는 CLI 가 필요 시 자동 기동하므로 별도 설치 없이 동작한다. 상시 상주(로그인 시 자동 기동)를
원하면:

```bash
rocky-todo daemon install     # launchd 등록 (KeepAlive) — macOS
rocky-todo daemon status      # 기동 여부 + launchd 상태
rocky-todo daemon uninstall
```

레포에서 직접 실행: `bun run src/todo/daemon.ts` (포그라운드는 `rocky-todo daemon run`).

## 호스트별 MCP 등록

데몬의 MCP 엔드포인트는 `http://127.0.0.1:8636/mcp` (streamable HTTP, 도구 5개:
`todo_list` / `todo_write` / `todo_status` / `note_list` / `note_write`).
`rocky-todo mcp setup` 이 아래 스니펫을 출력한다.

**Claude Code** (user 스코프 — 모든 프로젝트 공유):

```bash
claude mcp add --scope user --transport http rocky-todo http://127.0.0.1:8636/mcp
```

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

> 등록은 세션 시작 시 데몬이 떠 있어야 연결된다 — 상시 사용이면 `daemon install` 권장.
> plugin.json 에는 넣지 않는다 (데몬 lifecycle 은 플러그인과 독립).

## 사람→에이전트 자동 전달 (UserPromptSubmit 훅, Claude Code 전용)

에이전트→웹 방향은 SSE 로 실시간이고, 반대 방향은 **훅**이 닫는다: 사용자가 프롬프트를
보낼 때마다 플러그인의 `UserPromptSubmit` 훅이 데몬의 `/api/changes` 를 세션별 커서
이후로 읽어 **호출자(사람)의 변경만** 요약해 컨텍스트로 주입한다. 웹에서 todo 를 추가하고
아무 말이나 걸면 에이전트가 그 변경을 이미 알고 있는 구조다.

- 결정론적 (LLM 미사용), fail-open — 데몬이 꺼져 있으면 조용히 no-op
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
- 데몬 설정 변경 후에는 재시작해야 반영된다: `rocky-todo daemon stop && rocky-todo daemon start`.

## CLI 표면 (사람/스크립트/폴백)

```
rocky-todo ls [--board K|--all] [--archived] [--json]
rocky-todo add "제목" [--section S] [--parent ID] [--desc MD] [--due YYYY-MM-DD]
                     [--priority p1..p4] [--label a,b] [--link URL]
rocky-todo show|start|stop|done|reopen|archive|unarchive|update ID
rocky-todo note add|ls|show|edit|append|archive
rocky-todo history ID · board ls|add · section ls · open
rocky-todo daemon run|start|stop|status|install|uninstall · mcp setup
rocky-todo tailscale on|off|status
```

보드 키는 생략 시 cwd 의 git repo 이름으로 유추. actor 는 `--actor` >
`ROCKY_TODO_ACTOR` > 호스트 자동 감지 (claude-code / opencode / codex).

## 설정

`rocky.json` (user 레벨 권장 — 데몬은 project rocky.json 을 보지 않는다):

```json
{ "todo": { "enabled": true, "port": 8636, "dir": "~/.config/rocky/todo" } }
```

| env | 의미 |
| --- | --- |
| `ROCKY_TODO_ENABLED` | 마스터 스위치 강제 (기본 off — `todo.enabled` 보다 우선) |
| `ROCKY_TODO_PORT` | 데몬 포트 (기본 8636 — 키패드 "todo") |
| `ROCKY_TODO_DIR` | 데이터 디렉터리 (todo.db / daemon.pid / daemon.log / hook-cursors.json) |
| `ROCKY_TODO_ACTOR` | CLI actor 이름 강제 |
| `ROCKY_TODO_WATCH` | 보드 변경 주입 훅 on/off (기본 on) |
| `ROCKY_TODO_EXPOSE` | 노출 채널 강제 (`lan,tailscale-serve` / `off`) — 설정 시 config 무시 |
