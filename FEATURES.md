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
| `todo_list` | 보드/항목 조회 (`{ board }` 현황, `{ id }` 상세+히스토리, `{ boards: true }` 보드 목록) |
| `todo_write` | todo 생성/수정 (board, title, section, parentId, priority, due, labels, links, actor) |
| `todo_status` | 상태 전환 — `start` / `stop` / `done` / `reopen` / `archive` / `unarchive` |
| `note_list` | 스크래치패드 메모 조회 (보드 소속 or 글로벌) |
| `note_write` | 메모 생성/수정/append/archive (`mode`) |

엔드포인트: `http://127.0.0.1:8636/mcp` (streamable HTTP). Claude Code 는 플러그인이 자동 등록,
opencode/Codex 는 `rocky-todo mcp setup` 안내대로 수동 등록.

## CLI (사람 / 스크립트 / 폴백)

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

## 특징

- **계층/섹션/보드** — subtask(parentId), 섹션 그룹, 레포별 보드.
- **처리중 표시** — `start` 하면 웹 UI 에 actor + 경과 뱃지 (에이전트=앰버, 사람=블루).
- **히스토리** — 모든 mutation 이 누가/무엇을/언제로 자동 기록.
- **사람→에이전트 자동 전달** — Claude Code 의 UserPromptSubmit 훅이 사람의 보드 변경을 세션에 주입.
- **실시간 웹 UI** — Bun fullstack 자동 번들 + SSE (dist 없음, CDN 없음).
