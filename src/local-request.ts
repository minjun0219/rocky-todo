/**
 * 요청 출처 판별 — "이 요청이 데몬과 같은 기계의 로컬 클라이언트에서 직접 왔는가".
 *
 * 보드 자체는 `todo.expose` 로 노출하는 대상이다(무인증 · 신뢰망 전제). 하지만 이슈 생성은
 * 데몬 사용자의 **`gh` 인증**을 빌려 외부 GitHub 에 되돌릴 수 없는 글을 쓴다 — 보드 쓰기
 * 권한이 GitHub 계정 권한으로 확대되는 지점이다. 그 확대를 여기서 끊는다: 노출 여부와
 * 무관하게, 이슈 생성은 로컬에서 직접 온 요청만 할 수 있다.
 *
 * 순수 함수만 둔다(Request + peer 주소 → boolean) — 테스트가 소켓 없이 계약을 검증한다.
 */

/**
 * 프록시가 붙이는 헤더 — 하나라도 있으면 중계된 요청으로 본다.
 * `tailscale serve` 는 tailnet 사용자 신원을 `Tailscale-User-*` 로 실어 보내고, 일반
 * 리버스 프록시는 `X-Forwarded-*`/`Forwarded` 를 붙인다.
 */
const FORWARDED_HEADERS = [
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'forwarded',
  'tailscale-user-login',
  'tailscale-user-name',
  'tailscale-user-profile-pic',
] as const;

/**
 * 루프백 주소인지 — IPv4 `127.0.0.0/8`, IPv6 `::1`, IPv4-mapped `::ffff:127.x.y.z`.
 * 대괄호와 zone id(`%lo0`)는 벗겨서 본다.
 *
 * 주소를 모르면(undefined) 루프백이 **아니다**. 판별 근거가 없을 때 통과시키면 노출된
 * 데몬에서 그대로 구멍이 된다 — 근거 없음은 거부다.
 */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) {
    return false;
  }
  const bare = (address.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '').split('%')[0] ??
    '') as string;
  if (bare === '::1' || bare === '0:0:0:0:0:0:0:1') {
    return true;
  }
  // IPv4-mapped(`::ffff:127.0.0.1`)는 실제로 IPv4 루프백이다 — 듀얼스택 소켓에서 흔하다.
  const v4 = bare.startsWith('::ffff:') ? bare.slice('::ffff:'.length) : bare;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

/**
 * peer 주소가 루프백이고 **중계 흔적이 없어야** 로컬로 본다.
 *
 * 두 조건이 모두 필요하다:
 * - 주소만 보면 부족하다 — `tailscale serve` 는 tailnet 요청을 루프백으로 프록시하므로
 *   원격 요청도 peer 주소가 `127.0.0.1` 로 보인다.
 * - 헤더만 보면 부족하다 — `todo.host: "0.0.0.0"` 에서 LAN peer 가 직접 보낸 요청에는
 *   아무 헤더도 붙지 않는다.
 *
 * 헤더는 위조로 "있게" 만들 수는 있어도 "없게" 만들 수는 없다. 즉 위조는 요청을 **덜**
 * 신뢰하는 방향으로만 작용하므로, 이 판별을 우회하는 데는 쓸 수 없다.
 */
export function isLocalRequest(req: Request, peerAddress: string | undefined): boolean {
  if (!isLoopbackAddress(peerAddress)) {
    return false;
  }
  return !FORWARDED_HEADERS.some((name) => req.headers.has(name));
}

/** 거부 문구 — REST(403)와 MCP(도구 에러)가 같은 말을 하도록 한 곳에 둔다. */
export const NON_LOCAL_ISSUE_MESSAGE =
  'GitHub 이슈 생성은 로컬(루프백) 요청만 할 수 있다 — 데몬 사용자의 gh 인증을 쓰기 때문에 노출된 표면으로는 허용하지 않는다';
