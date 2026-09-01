//! rocky-todo CLI — 데몬의 얇은 HTTP 클라이언트 (보조 표면).
//!
//! 에이전트의 주 경로는 데몬의 `/mcp` 지만, CLI 는 사람/스크립트/데몬 관리용으로
//! 전체 동작을 커버한다. 출력은 컴팩트 텍스트 한 줄주의 — `--json` 으로 원본 JSON.
//!
//! 순수 계층(파싱·포맷)을 lib 으로 열어 두는 이유는 테스트가 붙게 하기 위해서다.

pub mod client;
pub mod commands;
pub mod context;
pub mod flags;
pub mod format;
pub mod hooks;
pub mod launchd;
pub mod system;

/// `help` 출력 — TS `src/cli.ts` 의 HELP 를 그대로 옮겼다.
pub const HELP: &str = r#"rocky-todo — 공유 todo/스크래치패드 보드 (데몬 + 웹 UI + MCP 의 CLI 표면)

사용:
  rocky-todo ls [--board K|--all] [--archived] [--json]
  rocky-todo next [--board K|--all] [--limit N] [--json]   착수 후보 랭킹 (다음에 뭘 할까)
  rocky-todo add "제목" [--board K] [--section S] [--parent REF] [--desc MD]
                       [--due YYYY-MM-DD] [--priority p1..p4] [--label a,b] [--link URL]
  rocky-todo show REF · update REF [플래그] [--title "새 제목"]
  rocky-todo comment REF "본문"                 todo 에 댓글 (에이전트/사람 공용 타임라인)
  rocky-todo issue REF [--repo OWNER/NAME]      todo 를 GitHub 이슈로 (gh CLI 필요)
  rocky-todo handoff REF [--session NAME] [--message "본문"]  실행 중인 세션에 작업 요청 보내기
  rocky-todo handoff REF --cancel               대기 중인 요청 취소
  rocky-todo spawn REF [--message "본문"]        그 todo 전용 워크트리에 새 세션 띄우기
  rocky-todo sessions                           실행 중인 Claude Code 세션 (* = 이 보드)
  rocky-todo move REF --to BOARD | --before REF2 | --last   보드 이동 / 순서 이동
  rocky-todo start|stop|done|reopen|archive|unarchive REF
  rocky-todo section add|archive "이름" [--board K] · section ls [--board K]
  rocky-todo note add "제목" [--board K|--global] [--content MD]
  rocky-todo note ls [--board K|--global]
  rocky-todo note show REF [--global] | edit REF --content MD [--global] |
                       append REF "텍스트" [--global] | archive REF [--global]
  rocky-todo history REF [--limit N] [--global|--note] · section ls
  rocky-todo board ls|show|add|rename|title|desc|repo|path   보드 메타 (이름·slug·설명·GitHub)
  rocky-todo open                              접속 주소 출력 (로컬/내부망/테일넷 — 링크 클릭으로 열기)
  rocky-todo daemon run|start|stop|status|install|uninstall
  rocky-todo mcp setup                         호스트별 MCP 등록 안내
  rocky-todo tailscale on|off|status           테일넷 한정 HTTPS 노출 (옵션, 기본 off)

REF 는 12 (현재 보드) 또는 rocky-12 (보드 지정) 또는 raw id 를 받는다.
보드 키는 생략 시 cwd 의 git repo 이름으로 유추한다. actor 는 --actor >
ROCKY_TODO_ACTOR > 호스트 자동 감지. 삭제는 없다 — 아카이브만 존재한다.
note show/edit/append/archive 의 맨 번호(12)는 기본적으로 todos 와 동일하게 현재 보드
컨텍스트로 풀린다 — 전역 메모를 번호로 가리키려면 note-3 처럼 접두사를 붙이거나
--global 을 붙인다. 둘 다 없으면 같은 번호의 보드 메모가 대신 잡힐 수 있다(모호성 회피).
옛 표기(rocky#12 / #12)도 계속 받는다 — 다만 bash 에서 #12 는 주석 시작 문자라
따옴표가 필요하다: rocky-todo show '#12'"#;
