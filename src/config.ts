import { homedir } from 'node:os';
import { join } from 'node:path';
import { type TodoConfig, expandTilde } from './rocky-config';
import { DEFAULT_STATUSLINE_TEMPLATE } from './statusline';

/**
 * rocky-todo 데몬/CLI 런타임 설정 해석.
 *
 * 우선순위: env (`ROCKY_TODO_PORT` / `ROCKY_TODO_DIR`) > user `rocky.json` 의 `todo`
 * 블록 > 기본값. 데몬은 시스템 전역 단일 인스턴스라 project rocky.json 은 보지 않는다
 * — 어느 레포에서 자동 기동되든 같은 설정으로 떠야 CLI/MCP/웹이 같은 데몬을 본다.
 */

/** 기본 포트 — 키패드로 "todo" (8636). */
export const DEFAULT_TODO_PORT = 8636;

/** 기본 데이터 디렉터리 — todo.db / daemon.pid 가 놓인다. */
export const DEFAULT_TODO_DIR = join(homedir(), '.config', 'rocky', 'todo');

/**
 * 노출 채널 — 빈 배열(기본)이면 루프백만. lan = 내부망(0.0.0.0),
 * tailscale-serve = 테일넷 한정 프록시(tailscale serve — 테일넷 로그인이 사실상의
 * 최소 안전장치, 자체 인증은 아니다).
 */
export const EXPOSE_CHANNELS = ['lan', 'tailscale-serve'] as const;
export type TodoExposeChannel = (typeof EXPOSE_CHANNELS)[number];

export interface TodoRuntimeConfig {
  port: number;
  dir: string;
  /** 바인딩 호스트 — expose 에서 유도 (lan 포함 → 0.0.0.0, 아니면 127.0.0.1). */
  host: string;
  expose: TodoExposeChannel[];
  /** `GET /api/statusline` 이 렌더할 템플릿 — 항상 채워진다(기본값 폴백). */
  statuslineTemplate: string;
}

function parsePort(raw: string | undefined): number | undefined {
  if (!raw) {
    return undefined;
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return undefined;
  }
  return port;
}

export function resolveTodoRuntimeConfig(
  env: Record<string, string | undefined> = process.env,
  todoConfig?: TodoConfig,
): TodoRuntimeConfig {
  const port = parsePort(env.ROCKY_TODO_PORT) ?? todoConfig?.port ?? DEFAULT_TODO_PORT;
  const rawDir = env.ROCKY_TODO_DIR?.trim() || todoConfig?.dir || DEFAULT_TODO_DIR;
  // env 가 설정돼 있으면 (유효 채널이 없어도) config 를 통째로 덮어쓴다 — "off" 로 강제 차단 가능.
  // config 값은 문자열 하나("lan")도 허용 — 배열로 정규화한다.
  const envExpose = env.ROCKY_TODO_EXPOSE;
  const configExpose = todoConfig?.expose;
  const expose: TodoExposeChannel[] =
    envExpose !== undefined
      ? envExpose
          .split(',')
          .map((token) => token.trim().toLowerCase())
          .filter((token): token is TodoExposeChannel =>
            (EXPOSE_CHANNELS as readonly string[]).includes(token),
          )
      : configExpose === undefined || configExpose === null || configExpose === 'off'
        ? []
        : Array.isArray(configExpose)
          ? configExpose
          : [configExpose];
  const host = expose.includes('lan') ? '0.0.0.0' : '127.0.0.1';
  // 빈 문자열은 "출력 안 함" 이 아니라 오설정으로 본다 — 끄고 싶으면 statusline 명령에서
  // curl 을 빼면 되고, 여기서 빈 값을 통과시키면 왜 아무것도 안 뜨는지 알 길이 없다.
  const statuslineTemplate =
    env.ROCKY_TODO_STATUSLINE?.trim() ||
    todoConfig?.statusline?.template?.trim() ||
    DEFAULT_STATUSLINE_TEMPLATE;

  return { port, dir: expandTilde(rawDir), host, expose, statuslineTemplate };
}
