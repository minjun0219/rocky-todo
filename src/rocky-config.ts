import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';

/**
 * rocky-todo 자체 경량 config 로더.
 *
 * rocky 본체와 분리된 별도 플러그인이라 `../core/rocky-config` 를 쓸 수 없다.
 * user `~/.config/rocky/rocky.json` 의 `todo` 블록만 읽는다 — 데몬은 시스템 전역
 * 단일 인스턴스라 project rocky.json 은 무시한다. `enabled` 필드는 읽지 않는다
 * (플러그인 설치 자체가 활성화 경계다). rocky 전용 키(openapi/seo/worklog/soul)는
 * 파싱하지 않는다 — todo 블록만 본다.
 */

/** user-level config 기본 경로. env `ROCKY_CONFIG` 로 오버라이드. */
export const USER_CONFIG_PATH = join(homedir(), '.config', 'rocky', 'rocky.json');

/** rocky-todo 데몬 설정 (user rocky.json 의 `todo` 블록). */
export interface TodoConfig {
  /** 데몬 포트. 기본 8636 (키패드 "todo"). env `ROCKY_TODO_PORT` 우선. */
  port?: number;
  /** 데이터 디렉터리 (todo.db). 기본 `~/.config/rocky/todo`. env `ROCKY_TODO_DIR` 우선. */
  dir?: string;
  /**
   * 보드 노출 채널. 생략/빈 배열(기본) = 이 머신만(127.0.0.1). `"lan"` = 내부망(0.0.0.0),
   * `"tailscale-serve"` = 테일넷 한정 프록시. 문자열 하나("lan")도 허용 — 배열로 정규화.
   * `"off"`/null 은 미설정과 동일. env `ROCKY_TODO_EXPOSE` 우선.
   */
  expose?: ('lan' | 'tailscale-serve')[] | 'lan' | 'tailscale-serve' | 'off' | null;
  /** UserPromptSubmit 훅의 보드 변경 주입 on/off. 기본 true. env `ROCKY_TODO_WATCH` 우선. */
  watch?: boolean;
}

/**
 * `~/...` 를 홈으로 확장한다 — `node:path` 의 resolve 는 tilde 를 확장하지 않아
 * 그대로 두면 `<cwd>/~/...` 가 되어버린다. (rocky 본체 `worklog.ts` 의 동명 함수와
 * 동일 로직을 self-contained 로 복제 — 작은 순수 함수라 의존 대신 복제한다.)
 */
export function expandTilde(input: string): string {
  if (input === '~') {
    return homedir();
  }
  if (input.startsWith('~/') || input.startsWith(`~${sep}`)) {
    return join(homedir(), input.slice(2));
  }
  return input;
}

/**
 * user rocky.json 의 `todo` 블록만 읽어 반환한다. 파일이 없거나 파싱 실패, 최상위/`todo`
 * 가 객체가 아니면 `{}` (fail-open — 데몬은 기본값으로 뜬다). `enabled` 는 무시한다.
 *
 * @param configPath user config 경로. 기본 `ROCKY_CONFIG` env > `USER_CONFIG_PATH`.
 */
export function loadTodoConfig(configPath: string = process.env.ROCKY_CONFIG ?? USER_CONFIG_PATH): {
  todo?: TodoConfig;
} {
  if (!existsSync(configPath)) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return {};
  }
  const todo = (parsed as Record<string, unknown>).todo;
  if (typeof todo !== 'object' || todo === null || Array.isArray(todo)) {
    return {};
  }
  const raw = todo as Record<string, unknown>;
  const out: TodoConfig = {};
  if (typeof raw.port === 'number') {
    out.port = raw.port;
  }
  if (typeof raw.dir === 'string') {
    out.dir = raw.dir;
  }
  if (raw.expose !== undefined) {
    out.expose = raw.expose as TodoConfig['expose'];
  }
  if (typeof raw.watch === 'boolean') {
    out.watch = raw.watch;
  }
  return { todo: out };
}
