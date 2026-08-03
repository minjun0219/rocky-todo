import { describe, expect, test } from 'bun:test';
import { decideServeAction, ensureTailscaleServe, parseServeProxyPort } from './tailscale';

const statusJson = (proxy: string | null) =>
  JSON.stringify({
    TCP: { '443': { HTTPS: true } },
    Web: {
      'host.tail0.ts.net:443': { Handlers: proxy === null ? {} : { '/': { Proxy: proxy } } },
    },
  });

describe('parseServeProxyPort', () => {
  test('루트 핸들러의 루프백 프록시 포트를 뽑는다', () => {
    expect(parseServeProxyPort(statusJson('http://127.0.0.1:8636'))).toBe(8636);
    expect(parseServeProxyPort(statusJson('http://localhost:8995'))).toBe(8995);
  });

  test('serve 미설정 / 파싱 불가 / 루트 아님은 null', () => {
    expect(parseServeProxyPort('{}')).toBeNull();
    expect(parseServeProxyPort('')).toBeNull();
    expect(parseServeProxyPort('No serve config')).toBeNull();
    expect(parseServeProxyPort(statusJson(null))).toBeNull();
  });

  test('루프백이 아닌 프록시 대상은 우리 관심사가 아니다', () => {
    expect(parseServeProxyPort(statusJson('http://192.168.0.5:8636'))).toBeNull();
  });

  test('루트가 아닌 경로만 있으면 null', () => {
    const json = JSON.stringify({
      Web: { 'host:443': { Handlers: { '/other': { Proxy: 'http://127.0.0.1:8636' } } } },
    });
    expect(parseServeProxyPort(json)).toBeNull();
  });
});

describe('decideServeAction', () => {
  test('빈 자리면 잡는다', () => {
    expect(
      decideServeAction({ myPort: 8636, occupiedPort: null, occupantIsLiveDaemon: false }).action,
    ).toBe('claim');
  });

  test('이미 내 포트면 no-op', () => {
    expect(
      decideServeAction({ myPort: 8636, occupiedPort: 8636, occupantIsLiveDaemon: false }).action,
    ).toBe('keep');
  });

  test('살아있는 다른 데몬이 쓰는 중이면 양보한다', () => {
    const decision = decideServeAction({
      myPort: 8995,
      occupiedPort: 8636,
      occupantIsLiveDaemon: true,
    });
    expect(decision.action).toBe('yield');
    expect(decision.message).toContain('8636');
  });

  test('죽은 포트를 가리키면 되찾는다', () => {
    const decision = decideServeAction({
      myPort: 8636,
      occupiedPort: 8995,
      occupantIsLiveDaemon: false,
    });
    expect(decision.action).toBe('reclaim');
  });
});

/** run 호출을 기록하는 스텁 — serve 하위 명령이 실제로 실행됐는지 본다. */
function stubRun(statusOut: string, statusOk = true) {
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    return args[1] === 'status' ? { ok: statusOk, out: statusOut } : { ok: true, out: 'started' };
  };
  const served = () => calls.some((args) => args.includes('--bg'));
  return { run, calls, served };
}

describe('ensureTailscaleServe', () => {
  test('살아있는 다른 데몬의 노출은 빼앗지 않는다', async () => {
    const stub = stubRun(statusJson('http://127.0.0.1:8636'));
    const log = await ensureTailscaleServe(8995, {
      run: stub.run,
      probeDaemon: async () => true,
    });
    expect(stub.served()).toBe(false);
    expect(log).toContain('건드리지 않는다');
  });

  test('stale 설정(죽은 포트)은 되찾는다', async () => {
    const stub = stubRun(statusJson('http://127.0.0.1:8995'));
    await ensureTailscaleServe(8636, { run: stub.run, probeDaemon: async () => false });
    expect(stub.calls).toContainEqual(['serve', '--bg', '8636']);
  });

  test('이미 내 포트면 probe 없이 no-op', async () => {
    const stub = stubRun(statusJson('http://127.0.0.1:8636'));
    let probed = false;
    await ensureTailscaleServe(8636, {
      run: stub.run,
      probeDaemon: async () => {
        probed = true;
        return true;
      },
    });
    expect(stub.served()).toBe(false);
    expect(probed).toBe(false);
  });

  test('serve 미설정이면 잡는다', async () => {
    const stub = stubRun('{}');
    await ensureTailscaleServe(8636, { run: stub.run, probeDaemon: async () => false });
    expect(stub.calls).toContainEqual(['serve', '--bg', '8636']);
  });

  test('status 조회 실패는 fail-open — claim 을 시도하고 실패해도 던지지 않는다', async () => {
    const calls: string[][] = [];
    const run = (args: string[]) => {
      calls.push(args);
      return { ok: false, out: 'tailscale CLI 를 찾을 수 없다' };
    };
    const log = await ensureTailscaleServe(8636, { run, probeDaemon: async () => false });
    expect(calls).toContainEqual(['serve', '--bg', '8636']);
    expect(log).toContain('무시하고 계속');
  });
});
