import { describe, expect, test } from 'bun:test';
import { isLocalRequest, isLoopbackAddress } from './local-request';

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
