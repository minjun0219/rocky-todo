import { daemonHealth } from './client';

/**
 * tailscale serve 연동 (옵션) — 데몬을 테일넷 한정 HTTPS 로 노출한다.
 *
 * 기본은 **off**: 회사 등 tailscale 을 쓰면 안 되는 환경에서는 rocky-todo 가
 * tailscale 을 일절 건드리지 않는다. 켜는 경로는 둘:
 *   - 수동: `rocky-todo tailscale on|off|status`
 *   - 자동: user rocky.json 의 `todo.expose` 에 `tailscale-serve` → 데몬 기동 시 serve 보장
 * 데몬 자체는 계속 127.0.0.1 만 바인딩한다 — 노출은 tailscaled 의 로컬 프록시가 담당.
 *
 * **자동 경로는 남의 노출을 빼앗지 않는다** (`decideServeAction`). `tailscale serve` 의
 * 노출 지점은 443 의 `/` 하나뿐인 머신 공유 자원인데, 데몬의 단일 인스턴스 보장은
 * *같은 포트* 기준이라 다른 포트의 개발/데모 인스턴스가 나란히 뜰 수 있다. 그 인스턴스가
 * 기동하며 serve 를 자기 포트로 잡아가면 설치본의 테일넷 노출이 조용히 끊긴다.
 * 수동 경로(`rocky-todo tailscale on`)는 사용자가 명시적으로 요구한 것이므로 그대로 인수한다.
 */

function tailscaleCmd(args: string[], timeoutMs = 10_000): { ok: boolean; out: string } {
  try {
    const proc = Bun.spawnSync({
      cmd: ['tailscale', ...args],
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: timeoutMs,
    });
    return {
      ok: proc.exitCode === 0,
      out: `${proc.stdout.toString()}${proc.stderr.toString()}`.trim(),
    };
  } catch {
    return {
      ok: false,
      out: 'tailscale CLI 를 찾을 수 없다 (미설치 환경에서는 이 기능을 쓰지 않는다)',
    };
  }
}

export function tailscaleServeOn(port: number): string {
  const result = tailscaleCmd(['serve', '--bg', String(port)]);
  if (result.ok) {
    return `✓ tailscale serve 활성 — 테일넷 기기에서 접근 가능:\n${result.out}`;
  }
  if (result.out.includes('not enabled on your tailnet')) {
    return `tailscale serve 가 테일넷에서 비활성 상태다. 관리 콘솔에서 1회 승인이 필요하다:\n${result.out}\n(승인 후 다시: rocky-todo tailscale on)`;
  }
  return `tailscale serve 실패: ${result.out}`;
}

export function tailscaleServeOff(): string {
  const result = tailscaleCmd(['serve', '--https=443', 'off']);
  return result.ok ? '✓ tailscale serve 해제' : `tailscale serve 해제 실패: ${result.out}`;
}

export function tailscaleServeStatus(): string {
  const result = tailscaleCmd(['serve', 'status']);
  if (!result.ok) {
    return `tailscale: ${result.out}`;
  }
  return result.out === '' || result.out.includes('No serve config')
    ? 'tailscale serve: 미설정 (로컬 전용)'
    : result.out;
}

interface ServeStatusJson {
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
}

/**
 * 루프백 판정 — `URL.hostname` 은 IPv6 를 대괄호째(`[::1]`) 돌려주므로 벗겨서 비교한다.
 * 여기서 놓친 형태는 "점유자 없음"으로 읽혀 남의 serve 를 덮어쓰게 되므로 넓게 잡는다.
 */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

/**
 * `tailscale serve status --json` 출력에서 루트(`/`) 핸들러가 프록시하는 로컬 포트를 뽑는다.
 *
 * 텍스트 출력 대신 JSON 을 파싱하는 이유는 사람이 읽는 트리 모양이 버전마다 흔들려서다.
 * 루프백이 아닌 대상(다른 호스트로의 프록시)은 우리 관심사가 아니므로 무시한다.
 * @returns 루트 핸들러가 루프백으로 프록시 중이면 그 포트, 아니면 null (파싱 실패 포함).
 */
export function parseServeProxyPort(json: string): number | null {
  let parsed: ServeStatusJson;
  try {
    parsed = JSON.parse(json) as ServeStatusJson;
  } catch {
    return null;
  }
  for (const site of Object.values(parsed?.Web ?? {})) {
    const proxy = site?.Handlers?.['/']?.Proxy;
    if (!proxy) {
      continue;
    }
    let url: URL;
    try {
      url = new URL(proxy);
    } catch {
      continue;
    }
    if (!isLoopbackHost(url.hostname)) {
      continue;
    }
    const port = Number(url.port);
    if (Number.isInteger(port) && port > 0) {
      return port;
    }
  }
  return null;
}

export type ServeAction = 'claim' | 'keep' | 'yield' | 'reclaim';

export interface ServeDecision {
  action: ServeAction;
  message: string;
}

/**
 * 기동 시 serve 를 잡을지 판정한다 (순수).
 *
 * - `claim`   — 루트가 비어 있다. 잡는다.
 * - `keep`    — 이미 내 포트다. no-op.
 * - `yield`   — 다른 포트인데 그쪽에 **살아 있는** rocky-todo 데몬이 있다. 양보한다
 *               (개발/데모 인스턴스가 설치본의 노출을 빼앗는 것을 막는 지점).
 * - `reclaim` — 다른 포트인데 아무도 안 듣는다. 죽은 인스턴스가 남긴 stale 설정이므로
 *               되찾는다. 이게 없으면 한 번 빼앗긴 노출이 영영 복구되지 않는다.
 *
 * @param occupantIsLiveDaemon `occupiedPort` 에 rocky-todo 데몬이 실제로 응답하는가.
 *   `occupiedPort` 가 null 이거나 내 포트일 때는 보지 않는다.
 */
export function decideServeAction(input: {
  myPort: number;
  occupiedPort: number | null;
  occupantIsLiveDaemon: boolean;
}): ServeDecision {
  const { myPort, occupiedPort, occupantIsLiveDaemon } = input;
  if (occupiedPort === null) {
    return { action: 'claim', message: 'tailscale serve 활성화 (todo.expose: tailscale-serve)' };
  }
  if (occupiedPort === myPort) {
    return { action: 'keep', message: `tailscale serve 이미 :${myPort} 로 설정됨` };
  }
  if (occupantIsLiveDaemon) {
    return {
      action: 'yield',
      message:
        `tailscale serve 는 :${occupiedPort} 의 다른 rocky-todo 데몬이 쓰는 중 — 건드리지 않는다.\n` +
        `      이 인스턴스(:${myPort})는 테일넷에 노출되지 않는다. 넘기려면: rocky-todo tailscale on`,
    };
  }
  return {
    action: 'reclaim',
    message: `tailscale serve 가 죽은 :${occupiedPort} 를 가리키고 있어 :${myPort} 로 되돌린다`,
  };
}

export interface EnsureServeDeps {
  /** tailscale CLI 실행 (테스트 주입점). */
  run?: (args: string[], timeoutMs?: number) => { ok: boolean; out: string };
  /** 해당 포트에 살아 있는 rocky-todo 데몬이 있는가. */
  probeDaemon?: (port: number) => Promise<boolean>;
}

/**
 * 데몬 기동 시 자동 보장 경로 — 판정은 `decideServeAction` 이 하고, 여기서는 실행만 한다.
 * 실패는 메시지로만 돌려준다 (fail-open: tailscale 문제로 데몬이 죽으면 안 된다).
 * @returns 호출자가 그대로 출력할 로그 한 덩어리.
 */
export async function ensureTailscaleServe(
  port: number,
  deps: EnsureServeDeps = {},
): Promise<string> {
  const run = deps.run ?? tailscaleCmd;
  const probeDaemon =
    deps.probeDaemon ??
    (async (target: number) => (await daemonHealth(`http://127.0.0.1:${target}`)) !== null);

  const status = run(['serve', 'status', '--json'], 5_000);
  // status 조회 자체가 실패하면 점유자를 알 수 없다 — 빈 자리로 보고 claim 을 시도한다
  // (뺏을 대상을 모르는 상태이고, tailscale 미설치라면 아래 실행도 같이 실패해 로그만 남는다).
  const occupiedPort = status.ok ? parseServeProxyPort(status.out) : null;
  const occupantIsLiveDaemon =
    occupiedPort !== null && occupiedPort !== port ? await probeDaemon(occupiedPort) : false;

  const decision = decideServeAction({ myPort: port, occupiedPort, occupantIsLiveDaemon });
  if (decision.action === 'keep' || decision.action === 'yield') {
    return decision.message;
  }

  const result = run(['serve', '--bg', String(port)]);
  return result.ok
    ? `${decision.message}\n${result.out}`
    : `tailscale serve 자동 활성화 실패 (무시하고 계속): ${result.out.split('\n')[0]}`;
}
