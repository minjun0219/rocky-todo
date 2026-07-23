/**
 * tailscale serve 연동 (옵션) — 데몬을 테일넷 한정 HTTPS 로 노출한다.
 *
 * 기본은 **off**: 회사 등 tailscale 을 쓰면 안 되는 환경에서는 rocky-todo 가
 * tailscale 을 일절 건드리지 않는다. 켜는 경로는 둘:
 *   - 수동: `rocky-todo tailscale on|off|status`
 *   - 자동: user rocky.json 의 `todo.tailscale: true` → 데몬 기동 시 serve 보장
 * 데몬 자체는 계속 127.0.0.1 만 바인딩한다 — 노출은 tailscaled 의 로컬 프록시가 담당.
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

/**
 * 데몬 기동 시 자동 보장 경로 — serve 가 이미 설정돼 있으면 no-op, 실패는 로그만
 * 남기고 삼킨다 (fail-open: tailscale 문제로 데몬이 죽으면 안 된다).
 */
export function ensureTailscaleServe(port: number): void {
  const status = tailscaleCmd(['serve', 'status'], 5_000);
  if (status.ok && status.out.includes('proxy') && status.out.includes(`:${port}`)) {
    return; // 이미 이 포트로 serve 중
  }
  const result = tailscaleCmd(['serve', '--bg', String(port)]);
  console.log(
    result.ok
      ? `tailscale serve 활성화됨 (todo.tailscale=true)\n${result.out}`
      : `tailscale serve 자동 활성화 실패 (무시하고 계속): ${result.out.split('\n')[0]}`,
  );
}
