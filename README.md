# rocky-todo

**rocky 의 동반 플러그인** — 로키(에이전트)와 호출자가 하나의 작업 보드를 공유하는 로컬 상주 데몬.
시스템에 단 하나만 떠서 Claude Code / opencode / Codex 의 모든 세션·모든 프로젝트가 같은 보드를 본다.
에이전트는 MCP/CLI 로 쓰고, 호출자는 웹 UI(`http://127.0.0.1:8636`)에서 실시간(SSE)으로 보고 편집한다.

- 계층(parentId) + 섹션 + 보드(레포별) todo, 우선순위 p1–p4 / 라벨 / 마감 / 링크 첨부
- 처리중 표시(start→actor + 경과 뱃지), 전 mutation 히스토리 자동 기록
- **삭제 없음 — 아카이브만**
- 댓글: todo 마다 시간순 대화 — 진행 보고와 사용자 답이 한 타임라인에 쌓인다
- GitHub 이슈로 만들기: 웹 UI 버튼 / CLI `issue` / MCP `todo_write.createIssue` — `gh` CLI 를
  빌려 인증하고, 만들어진 이슈 URL 은 그 todo 의 링크에 자동으로 붙는다 (로컬 요청 전용 —
  노출된 표면에서는 만들 수 없다)
- 스크래치패드 note (보드 소속 or 글로벌)
- 실행 중인 Claude Code 세션으로 작업 넘기기(보드 버튼 → 그 세션이 턴을 끝내며 자동 착수) —
  세션이 없으면 그 todo 전용 워크트리에 새로 띄울 수도 있다(로컬 전용)
- 사람이 읽는 참조(`rocky-12`, 글로벌 메모는 `note-3`)로 부른다 — 웹 UI에서는 번호 버튼을
  클릭하면 `/rocky-todo:board rocky-12` 가 클립보드로 복사된다
- 다음 작업 고르기: `/rocky-todo:next` — 착수 후보를 랭킹해 보여주고 고른 항목을 바로 시작한다
  (CLI 는 `rocky-todo next`). 주인 없는 진행중 → 마감 → 우선순위 순, 우산 항목은 제외
- 웹 UI 퍼머링크 — 주소가 화면을 담는다: `/`(전체) · `/{board}` · `/{board}/{number}`. 새로고침해도 유지되고 링크 공유 가능

## 표면

| 표면 | 경로 | 용도 |
| --- | --- | --- |
| 웹 UI | `/` | 호출자 — React + SSE 실시간 |
| REST | `/api/*` | CLI + 웹 UI |
| SSE | `/api/events` | 웹 UI 실시간 갱신 |
| MCP | `/mcp` | Claude Code / opencode / Codex — streamable HTTP, 5도구 |
| CLI | `rocky-todo` | 사람 / 스크립트 / 폴백 |

MCP 도구 5개: `todo_list` / `todo_write` / `todo_status` / `note_list` / `note_write`.

## 설치 = 활성화

```bash
claude plugin marketplace add minjun0219/rocky
claude plugin install rocky-todo@rocky-marketplace     # rocky 자동 동반 (dependencies)
```

별도 스위치 없음 — 설치 자체가 활성화다. SessionStart 훅이 데몬을 기동하고, http MCP 가 자동 등록된다.
런타임에 끄려면 `claude plugin disable rocky-todo`. 자세한 설치/데몬/노출/설정은 **[docs/rocky-todo.md](./docs/rocky-todo.md)**.

## 문서

- **[docs/rocky-todo.md](./docs/rocky-todo.md)** — 설치·데몬·MCP 도구·노출 범위·CLI·설정 (사람용 단일 출처)
- **[AGENTS.md](./AGENTS.md)** — 레이아웃/코딩 규칙/게이트 (AI 에이전트용)
- **[skills/board/SKILL.md](./skills/board/SKILL.md)** — 보드 활용 에티켓 (`rocky-todo:board` 스킬)

## 개발

```bash
bun install
bun run check       # Biome
bun run typecheck   # tsc --noEmit
bun run test        # 모든 테스트 (unit + dom) — 맨손 `bun test` 는 두 갈래가 섞여 깨진다
```

rocky 본체는 별도 레포 [minjun0219/rocky](https://github.com/minjun0219/rocky).
