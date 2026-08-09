import { describe, expect, test } from 'bun:test';
import { isCrossSiteRequest, isLocalRequest, isLoopbackAddress } from './local-request';

const BASE = 'http://localhost/api/todos/abc/issue';

function post(headers: Record<string, string> = {}): Request {
  return new Request(BASE, { method: 'POST', headers });
}

describe('isLoopbackAddress', () => {
  test('accepts IPv4 loopback anywhere in 127.0.0.0/8', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('127.1.2.3')).toBe(true);
  });

  test('accepts IPv6 loopback and its IPv4-mapped form', () => {
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('0:0:0:0:0:0:0:1')).toBe(true);
    // 듀얼스택 소켓이 흔히 이 꼴로 보고한다
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
  });

  test('strips brackets, zone ids and case', () => {
    expect(isLoopbackAddress('[::1]')).toBe(true);
    expect(isLoopbackAddress('::1%lo0')).toBe(true);
    expect(isLoopbackAddress('::FFFF:127.0.0.1')).toBe(true);
  });

  test('rejects LAN, tailnet and public addresses', () => {
    expect(isLoopbackAddress('192.168.1.20')).toBe(false);
    expect(isLoopbackAddress('10.0.0.5')).toBe(false);
    // tailnet CGNAT 범위 — 루프백이 아니다
    expect(isLoopbackAddress('100.101.102.103')).toBe(false);
    expect(isLoopbackAddress('93.184.216.34')).toBe(false);
    expect(isLoopbackAddress('fe80::1')).toBe(false);
  });

  test('a lookalike that merely contains 127. is not loopback', () => {
    expect(isLoopbackAddress('10.127.0.1')).toBe(false);
    expect(isLoopbackAddress('1127.0.0.1')).toBe(false);
  });

  test('an unknown address is not loopback — no evidence means deny', () => {
    expect(isLoopbackAddress(undefined)).toBe(false);
    expect(isLoopbackAddress('')).toBe(false);
  });
});

describe('isLocalRequest', () => {
  test('a bare loopback request is local', () => {
    expect(isLocalRequest(post(), '127.0.0.1')).toBe(true);
  });

  test('a LAN peer is not local even with no proxy headers', () => {
    // todo.host: "0.0.0.0" 에서 같은 네트워크의 기기가 직접 보내는 경로
    expect(isLocalRequest(post(), '192.168.1.20')).toBe(false);
  });

  test('a loopback request carrying proxy markers is not local', () => {
    // tailscale serve 는 tailnet 요청을 루프백으로 프록시한다 — peer 주소만 보면 원격
    // 요청도 127.0.0.1 로 보이므로 헤더까지 봐야 이 경로가 막힌다.
    expect(isLocalRequest(post({ 'x-forwarded-for': '100.101.102.103' }), '127.0.0.1')).toBe(false);
    expect(
      isLocalRequest(post({ 'tailscale-user-login': 'someone@example.com' }), '127.0.0.1'),
    ).toBe(false);
    expect(isLocalRequest(post({ forwarded: 'for=100.101.102.103' }), '127.0.0.1')).toBe(false);
    expect(isLocalRequest(post({ 'x-forwarded-proto': 'https' }), '127.0.0.1')).toBe(false);
  });

  test('an unknown peer address is not local', () => {
    expect(isLocalRequest(post(), undefined)).toBe(false);
  });

  test('forging a proxy header can only lose trust, never gain it', () => {
    // 위조로 헤더를 "있게" 만들 수는 있어도 "없게" 만들 수는 없다 — 그래서 이 판별을
    // 우회하는 데는 쓸 수 없다. LAN peer 가 헤더를 지워도 주소에서 걸린다.
    expect(isLocalRequest(post(), '192.168.1.20')).toBe(false);
    expect(isLocalRequest(post({ 'x-forwarded-for': '127.0.0.1' }), '192.168.1.20')).toBe(false);
  });
});

describe('isCrossSiteRequest', () => {
  test('브라우저가 아닌 클라이언트(CLI·훅·MCP)는 통과한다', () => {
    expect(isCrossSiteRequest(post())).toBe(false);
  });

  test('Sec-Fetch-Site 가 1순위다 — cross-site 만 막는다', () => {
    expect(isCrossSiteRequest(post({ 'sec-fetch-site': 'cross-site' }))).toBe(true);
    expect(isCrossSiteRequest(post({ 'sec-fetch-site': 'same-origin' }))).toBe(false);
    // 테일넷의 다른 기기 페이지 — 이 보드가 이미 신뢰하는 망이다
    expect(isCrossSiteRequest(post({ 'sec-fetch-site': 'same-site' }))).toBe(false);
    // 주소창 입력·북마크 — 본문을 실은 요청이 될 수 없다
    expect(isCrossSiteRequest(post({ 'sec-fetch-site': 'none' }))).toBe(false);
  });

  // 프록시가 Host 를 바꾸면 Origin 문자열 비교는 정상 화면을 막는다. 브라우저가 계산한
  // Sec-Fetch-Site 는 그 영향을 받지 않으므로, 있을 때는 Origin 을 보지 않는다.
  test('Sec-Fetch-Site 가 있으면 Origin 불일치는 무시한다 (tailscale serve 경로)', () => {
    expect(
      isCrossSiteRequest(
        post({ 'sec-fetch-site': 'same-origin', origin: 'https://mac.tailnet.ts.net' }),
      ),
    ).toBe(false);
  });

  test('Sec-Fetch-Site 가 없으면 Origin 으로 떨어진다', () => {
    expect(isCrossSiteRequest(post({ origin: 'http://localhost' }))).toBe(false);
    expect(isCrossSiteRequest(post({ origin: 'https://evil.example' }))).toBe(true);
    // 중계가 원래 호스트를 보존해 줬으면 그것도 허용 대상이다
    expect(
      isCrossSiteRequest(
        post({ origin: 'https://mac.tailnet.ts.net', 'x-forwarded-host': 'mac.tailnet.ts.net' }),
      ),
    ).toBe(false);
  });

  test('불투명 Origin(null)은 통과, 파싱 불가 Origin 은 거부', () => {
    expect(isCrossSiteRequest(post({ origin: 'null' }))).toBe(false);
    expect(isCrossSiteRequest(post({ origin: 'not a url' }))).toBe(true);
  });
});
