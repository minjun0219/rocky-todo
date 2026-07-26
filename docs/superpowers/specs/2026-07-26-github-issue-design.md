# todo → GitHub 이슈

- 날짜: 2026-07-26
- 상태: 설계 승인됨
- 보드 항목: `rocky-todo#8`
- 대상: `src/github.ts`(신규) · `src/store.ts` · `src/migrations.ts` · `src/server.ts` · `src/mcp.ts` · `src/cli.ts` · `src/ui/`

## 문제

보드의 todo 를 GitHub 이슈로 올리려면 지금은 손으로 옮겨 적고, 만들어진 이슈 URL 을 다시
손으로 `links` 에 붙여야 한다. 두 번 적는 일이고, 옮겨 적는 사이에 내용이 갈라진다.

## 목표 / 비목표

**목표** — todo 하나를 버튼(또는 명령) 한 번으로 GitHub 이슈로 만들고, 만들어진 이슈 URL 이
그 todo 의 `links` 에 자동으로 붙는다.

**비목표** — 역방향 동기화(이슈가 닫히면 todo 완료 처리). 폴링이나 웹훅이 필요해 구조가
크게 늘어난다. 이슈 본문/제목의 사후 동기화, 이슈 코멘트 연동, GitHub 외 이슈 트래커.

## 설계

### 1. 인증 — `gh` CLI 를 빌린다

토큰을 저장하지 않는다. 데몬은 사용자 프로세스로 도니 `gh` 를 그대로 실행하면 사용자의
인증을 빌릴 수 있다. `src/tailscale.ts` 가 이미 같은 형태(`Bun.spawnSync` + "CLI 를 찾을 수
없다" 를 사람이 읽는 메시지로 돌려주기)를 쓰고 있으므로 새로운 패턴이 아니다.

### 2. 데이터 — `boards.repo`

이슈를 만들려면 `owner/name` 이 필요한데 보드는 `key`(= git remote basename) 만 갖고 있다.
`boards` 에 컬럼을 더한다:

```sql
ALTER TABLE boards ADD COLUMN repo TEXT;
```

`MIGRATIONS` 배열의 두 번째 항목이 된다(`user_version` 2). **댓글 기능의 신규 테이블과 달리
이번엔 진짜 마이그레이션이다** — 기존 테이블 변경이라 `CREATE TABLE IF NOT EXISTS` 로는 안 된다.
`runMigrations` 가 적용 전 DB 를 백업한다.

`Board` 인터페이스에 `repo?: string` 을 더하고 `toBoard` 가 매핑한다. 스토어에 두 가지를
더한다:

```ts
/** boardId 로 보드 한 건. 이슈 라우트가 todo → 보드 → repo 를 따라갈 때 쓴다. */
boardById(boardId: string): Board | undefined

/** 보드의 repo 를 설정한다. 없는 보드면 던진다 — 여기서 보드를 만들지 않는다. */
setBoardRepo(key: string, repo: string, actor: string): Board
```

### 3. repo 를 채우는 세 경로

어느 것도 **보드를 조용히 만들지 않는다** — 과거 "section add 가 보드를 자동 생성하지 않게"
수정과 같은 원칙이다. 이미 있는 보드에만 값을 채운다.

1. **`rocky-todo issue REF`** 를 git 체크아웃 안에서 실행하면, 그 보드에 `repo` 가 없을 때
   cwd 의 `git remote get-url origin` 에서 유추해 **저장하고 이슈 생성을 계속한다.** 가장
   자연스러운 "그냥 된다" 경로다.

   순서를 못박는다: CLI 는 먼저 `POST .../issue` 를 보낸다. 서버가 `repo 미설정` 400 을
   돌려주면 그때 cwd 에서 유추해 `PATCH /api/boards/:key` 로 저장하고 **한 번만** 재시도한다.
   유추에 실패하면(git 밖이거나 GitHub remote 가 아니면) 서버의 400 메시지를 그대로 보여준다.
   미리 보드를 조회하지 않는 이유: 이미 설정된 흔한 경우에 왕복이 하나 줄어든다.
   `--repo` 가 주어지면 유추를 건너뛰고 그 값으로 먼저 `PATCH` 한 뒤 생성한다.
2. **`rocky-todo board repo [OWNER/NAME]`** — 인자를 주면 그 값으로, 없으면 cwd 에서 유추해
   설정한다. 명시적 경로.
3. **웹 UI** 의 버튼이 `repo` 없는 보드에서 눌리면 1회 입력을 받아 저장한 뒤 진행한다.
   데몬에는 cwd 개념이 없으므로 유추할 수 없다.

### 4. `src/github.ts` (신규)

```ts
/** 외부 명령 실행 — 테스트가 fake 를 주입한다. */
export interface RunCommand {
  (cmd: readonly string[], stdin: string): { code: number; stdout: string; stderr: string };
}

/**
 * git remote URL → `owner/name`. GitHub 이 아니거나 해석 불가면 undefined.
 * `git@github.com:o/n.git` · `https://github.com/o/n.git` · `ssh://git@github.com/o/n` 를 받는다.
 */
export function parseRepoFromRemote(url: string): string | undefined;

/** `owner/name` 모양인지. 사용자 입력(웹 UI·CLI 플래그) 검증용. */
export function isRepoSlug(value: string): boolean;

/** gh 로 이슈를 만든다. 실패는 던지지 않고 사람이 읽는 메시지로 돌려준다. */
export function createIssue(
  input: { repo: string; title: string; body: string },
  run?: RunCommand,
): { ok: true; url: string } | { ok: false; message: string };
```

`createIssue` 는 `gh issue create -R <repo> -t <title> -F -` 를 실행하고 **본문은 stdin 으로**
넘긴다 — argv 길이 제한과 이스케이프 문제를 피한다. `Bun.spawn` 에 배열을 주므로 셸이
개입하지 않는다(셸 주입 없음).

`run` 을 주입 가능하게 두는 것이 이 파일의 핵심이다. **`gh` 가 없는 머신에서도 테스트가
전부 통과해야 한다.**

실패 메시지는 세 가지를 구분한다:
- 실행 파일 없음 → `gh CLI 를 찾을 수 없다 (https://cli.github.com)`
- 미인증(`gh` stderr 에 `auth` 힌트) → stderr + `gh auth login` 안내
- 그 외 → stderr 를 그대로

### 5. 이슈 본문

제목은 todo 의 `title` 그대로. 본문은 `description` 뒤에 빈 줄 하나와 백링크 한 줄:

```
<description>

— rocky-todo `rocky-todo#8`
```

데몬은 루프백이라 클릭 가능한 URL 을 넣을 수 없다. 보드 참조 문자열이 사람이 되짚을 수 있는
가장 안정적인 단서다. `description` 이 비어 있으면 백링크 줄만 남는다.

### 6. 링크 자동 첨부

성공하면 기존 `updateTodo(ref, { links: [...links, { url, title: '#<이슈번호>' }] })` 를 거친다.
새 저장 경로를 만들지 않으므로 히스토리·SSE·`/api/changes` 훅 주입에 자동으로 실린다 —
댓글 기능이 히스토리를 재사용한 것과 같은 판단이다.

이슈 번호는 `gh` 가 돌려준 URL 끝에서 뽑는다.

### 7. 중복 방지

todo 의 `links` 에 이미 `https://github.com/<owner>/<name>/issues/<n>` 꼴이 있으면 서버가
**409** 로 거절한다. 진실은 서버에 둔다 — 웹 UI 는 그 상태에서 버튼을 "이슈 열기 ↗" 로
바꾸지만, 그건 표시일 뿐 강제는 서버가 한다.

### 8. 표면

| 표면 | 계약 |
| --- | --- |
| REST | `POST /api/todos/:ref/issue` → 201 `{ url }` · 400(repo 미설정/gh 실패) · 409(이미 있음) |
| REST | `PATCH /api/boards/:key` `{ repo }` → `Board` · 400(모양 불량) · 404(없는 보드) |
| CLI | `rocky-todo issue REF [--repo OWNER/NAME]` · `rocky-todo board repo [OWNER/NAME]` |
| MCP | `todo_write` 에 `createIssue?: boolean` — **도구는 5개 그대로** |
| 웹 UI | 드로어에 "GitHub 이슈 만들기" 버튼, `repo` 미설정이면 입력 |

MCP 를 새 도구가 아니라 `todo_write` 의 필드로 두는 이유: 5도구 원칙이 존재하는 이유가
세션마다 실리는 스키마 토큰 고정비이고, 필드 하나가 도구 하나보다 훨씬 싸다.

### 9. 실패 처리

| 경우 | 응답 |
| --- | --- |
| 보드에 `repo` 없음 | 400 — 웹 UI 는 입력 폼을 띄우고, CLI 는 cwd 에서 유추를 먼저 시도 |
| `gh` 미설치·미인증·실패 | 400 + `createIssue` 가 만든 메시지 그대로 |
| 이미 이슈 링크 있음 | 409 |
| 없는 todo/보드 | 404 |

웹 UI 는 사이드바 보드 생성 실패가 쓰는 `role="alert"` 패턴을 재사용한다 — 실패 사유가
읽히지 않으면 사용자는 무엇을 고쳐야 할지 모른다.

### 10. 테스트

| 파일 | 검증 |
| --- | --- |
| `src/github.test.ts`(신규) | `parseRepoFromRemote` 의 remote URL 여러 꼴(ssh/https/`.git` 유무/비-GitHub), `isRepoSlug`, `createIssue` 를 주입된 fake `run` 으로 성공·미설치·미인증·기타 실패 |
| `src/migrations.test.ts` | `boards.repo` 마이그레이션이 기존 행을 보존한 채 컬럼을 더한다 |
| `src/store.test.ts` | `setBoardRepo` + `Board.repo` 왕복 |
| `src/server.test.ts` | 두 라우트, 409, 400(repo 미설정), 404 |
| `src/mcp.test.ts` | `todo_write { id, createIssue: true }`, 도구 수 5 유지 |
| `src/cli.test.ts` | 경로 조립 |

**`gh` 가 설치되지 않은 머신에서도 전부 통과해야 한다** — 서버 테스트는 스토어에 주입된
fake `run` 을 거치거나, `gh` 를 부르지 않는 경로(409·400·404)만 검증한다.

## 위험 / 판단 근거

- **`issue` 명령이 repo 유추를 겸한다** — 순수한 "한 가지만 한다" 원칙에서 보면 부수효과지만,
  이 경로가 없으면 사용자는 보드마다 `board repo` 를 먼저 쳐야 한다. 유추는 **보드에 값이
  없을 때만** 일어나고 저장 사실이 출력에 남으므로 조용하지 않다.
- **마이그레이션이 필요하다** — `runMigrations` 가 적용 전 백업을 뜬다. 컬럼 추가는
  기존 행에 `NULL` 을 남길 뿐이라 되돌릴 필요가 거의 없다.
- **`gh` 의존** — 미설치 환경에서 기능만 조용히 빠지는 게 아니라 이유를 말한다. 데몬 자체는
  `gh` 없이도 정상 동작한다.
- **역방향 동기화 제외** — 이슈 상태를 따라오려면 주기 폴링(레이트 리밋)이나 웹훅(공개
  엔드포인트)이 필요하다. 루프백 데몬 전제와 맞지 않아 별도 설계로 미룬다.
