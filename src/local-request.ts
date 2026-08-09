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

/**
 * 브라우저가 붙이는 "이 요청을 누가 시작했나" 표식 — 값은 브라우저가 계산하며
 * 페이지 스크립트가 건드릴 수 없다.
 */
const FETCH_SITE_HEADER = 'sec-fetch-site';

/**
 * 다른 사이트의 페이지가 시킨 요청인가 — 브라우저發 CSRF 판별.
 *
 * 데몬은 무인증이고 루프백에 떠 있다. 사용자가 방문한 악성 페이지가
 * `<form enctype="text/plain" action="http://127.0.0.1:8636/api/...">` 로 POST 하면
 * preflight 없이 나가고, peer 주소는 `127.0.0.1` 이라 {@link isLocalRequest} 를 그대로
 * 통과한다 — 보드 편집·spawn·이슈 생성이 전부 그 통로에 놓인다.
 *
 * **`Sec-Fetch-Site` 를 1순위로 본다.** 브라우저가 요청 URL 과 개시자를 비교해 계산한
 * 값이라 프록시가 `Host` 를 바꿔도 흔들리지 않는다 — `tailscale serve` 를 거친 웹 UI 는
 * 데몬이 보는 URL(`127.0.0.1:8636`)과 브라우저가 보는 URL(`https://<host>.ts.net`)이
 * 달라, origin 문자열 비교만으로는 정상 화면을 막을 위험이 있다. `cross-site` 만
 * 거부한다: `same-site` 는 이 보드가 이미 신뢰하는 범위이고(테일넷의 다른 기기 페이지,
 * 그리고 **같은 호스트의 다른 포트** — `http://127.0.0.1:3000` 의 로컬 개발 서버도 여기
 * 들어온다), `none`(주소창 입력·북마크)은 본문을 실은 요청이 될 수 없다. 막으려는 것은
 * "사용자가 방문한 인터넷의 악성 페이지" 다.
 *
 * `Sec-Fetch-Site` 가 없으면(구형 브라우저, 그리고 헤더를 아예 안 보내는 CLI·훅·MCP
 * 클라이언트) `Origin` 으로 떨어진다 — 있는데 이 요청의 호스트와 다르면 거부다. **헤더가
 * 아예 없을 때만** 통과시킨다: 브라우저는 cross-origin 쓰기에 `Origin` 을 **반드시**
 * 붙이므로, 부재는 위조가 아니라 비브라우저 클라이언트라는 뜻이다. 반대로 불투명 Origin
 * (문자열 `null`)은 거부한다 — 부재와 달리 그건 **브라우저가 보낸** 값이고, sandboxed
 * iframe 이나 `data:` 문서에서 제출된 폼이 정확히 그 값을 만든다. 즉 Fetch Metadata 를
 * 지원하지 않는 브라우저에서 이 분기가 그대로 CSRF 우회로가 된다. 이 데몬을 정상적으로
 * 쓰는 경로 중 불투명 Origin 을 만드는 것은 없다(`file://` 로 보드를 열지 않는다).
 *
 * 호스트 비교는 **포트를 무시한다**(`hostname`). 그러지 않으면 같은 기계의 다른 포트에서
 * 뜬 로컬 개발 UI(`http://127.0.0.1:3000`)가 이 분기에서만 거부돼, 위에서 `same-site` 를
 * 허용한 판단과 두 분기가 어긋난다.
 *
 * @param req 검사할 요청. 변경 메서드(POST/PATCH/PUT/DELETE)에만 의미가 있다.
 */
export function isCrossSiteRequest(req: Request): boolean {
  const site = req.headers.get(FETCH_SITE_HEADER);
  if (site !== null) {
    return site.trim().toLowerCase() === 'cross-site';
  }
  const origin = req.headers.get('origin');
  if (origin === null) {
    return false;
  }
  let originHostname: string;
  try {
    originHostname = new URL(origin).hostname;
  } catch {
    // 파싱조차 안 되는 Origin — 불투명 Origin(`null`)도 여기로 떨어진다. 정상 브라우저가
    // 이 데몬을 향해 만들 값이 아니므로 거부한다(근거 없음은 거부, `isLocalRequest` 와 같은 결).
    return true;
  }
  // 프록시 뒤에서는 데몬이 보는 호스트가 브라우저가 본 호스트와 다르다 — 중계가 보존해
  // 준 원래 호스트도 같이 허용 대상으로 본다.
  const forwardedHost = req.headers.get('x-forwarded-host')?.split(',')[0]?.trim();
  const allowed = new Set([new URL(req.url).hostname]);
  if (forwardedHost) {
    // `x-forwarded-host` 는 URL 이 아니라 `host[:port]` 라 URL 파서에 그대로 못 넣는다.
    // 대괄호는 벗기지 않는다 — IPv6 는 `URL.hostname` 도 `[::1]` 로 대괄호째 준다.
    allowed.add(forwardedHost.replace(/:\d+$/, ''));
  }
  return !allowed.has(originHostname);
}

/** cross-site 쓰기 거부 문구. */
export const CROSS_SITE_MESSAGE =
  '다른 사이트에서 시작된 변경 요청은 처리하지 않는다 (CSRF 방지) — 보드 화면이나 CLI 에서 다시 시도한다';

/** 거부 문구 — REST(403)와 MCP(도구 에러)가 같은 말을 하도록 한 곳에 둔다. */
export const NON_LOCAL_ISSUE_MESSAGE =
  'GitHub 이슈 생성은 로컬(루프백) 요청만 할 수 있다 — 데몬 사용자의 gh 인증을 쓰기 때문에 노출된 표면으로는 허용하지 않는다';

/** spawn 거부 문구 — 이슈 생성과 같은 등급의 게이트다. */
export const NON_LOCAL_SPAWN_MESSAGE =
  '백그라운드 세션 띄우기는 로컬(루프백) 요청만 할 수 있다 — 이 기계에서 파일을 고치는 프로세스를 띄우기 때문에 노출된 표면으로는 허용하지 않는다';
