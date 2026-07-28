/**
 * tailscale serve 연동 (옵션) — 데몬을 테일넷 한정 HTTPS 로 노출한다.
 *
 * 기본은 **off**: 회사 등 tailscale 을 쓰면 안 되는 환경에서는 rocky-todo 가
 * tailscale 을 일절 건드리지 않는다. 켜는 경로는 **수동 하나뿐**이다:
 *   `rocky-todo tailscale on|off|status`
 * 데몬 자체는 계속 127.0.0.1 만 바인딩한다 — 노출은 tailscaled 의 로컬 프록시가 담당.
 *
 * 기동 시 자동으로 serve 를 잡는 경로는 **의도적으로 없다**. `tailscale serve` 의 노출
 * 지점은 443 의 `/` 하나뿐인 공유 자원이라, 포트가 다른 인스턴스들(설치본 / 개발 워킹트리)이
 * 각자 기동할 때마다 잡으면 서로의 매핑을 말없이 교체한다. 여기 있는 함수는 전부 사용자가
 * 직접 부른 명령에서만 호출된다 — 그래서 남의 설정을 덮어써도 되는 명시적 의사로 취급한다.
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
