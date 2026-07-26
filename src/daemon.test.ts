import { describe, expect, test } from 'bun:test';
import { isLoopbackAddress } from './daemon';

/**
 * `isLoopbackAddress` 는 `POST /api/handoffs/claim` 가드(daemon.ts 의 `isLoopback` DI)가
 * 실제로 쓰는 판정 로직의 순수 부분이다 — 이전에는 daemon.ts 안 인라인 람다라 테스트가
 * 없었다(server.test.ts 는 시임만 검증한다). null 판정은 fail-open(루프백 간주) —
 * daemon.ts 의 함수 주석에 근거를 적어뒀다.
 */
describe('isLoopbackAddress', () => {
  test('127.0.0.1 은 루프백', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
  });

  test('::1 (IPv6 루프백) 은 루프백', () => {
    expect(isLoopbackAddress('::1')).toBe(true);
  });

  test('::ffff:127.0.0.1 (IPv4-mapped IPv6) 은 루프백', () => {
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
  });

  test('127.0.0.2 (127.0.0.0/8 이지만 .1 은 아님) 도 루프백', () => {
    expect(isLoopbackAddress('127.0.0.2')).toBe(true);
  });

  test('192.168.1.5 (LAN IP) 은 루프백이 아니다', () => {
    expect(isLoopbackAddress('192.168.1.5')).toBe(false);
  });

  test('null (판별 불가) 은 fail-open — 루프백으로 간주한다', () => {
    expect(isLoopbackAddress(null)).toBe(true);
  });
});
