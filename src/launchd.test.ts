import { describe, expect, test } from 'bun:test';
import { plistContent } from './launchd';

/**
 * `installLaunchd`/`uninstallLaunchd` 는 실제 `~/Library/LaunchAgents` 와 `launchctl` 을
 * 건드리는 매우 부수효과가 큰 함수라(호스트 launchd 상태를 바꾼다) 여기서 실행하지 않는다.
 * plist 를 만드는 순수 함수(`plistContent`)만 검증한다 — PATH 회귀는 이 정도로 충분히 잡힌다.
 */
describe('plistContent', () => {
  // launchd 기본 PATH 에는 `claude`(핸드오프)도 `gh`(이슈 만들기)도 없다 — 데몬이 둘 다
  // 이름만으로 spawn 하므로 설치 시점 PATH 를 굽고, 뒤에 흔한 설치 위치를 이어 붙인다.
  const FALLBACK = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';

  // PATH 를 알려진 값으로 고정하고 검증한다 — 실행 환경의 PATH 를 그대로 기대값에 쓰면
  // 그 값에 `&` 같은 문자가 섞인 머신에서(이스케이프가 적용되어) 플래키하게 깨진다.
  test('EnvironmentVariables 로 설치 시점 PATH 를 굽는다', () => {
    const original = process.env.PATH;
    process.env.PATH = '/opt/homebrew/bin:/usr/bin';
    try {
      const xml = plistContent();
      expect(xml).toContain('<key>EnvironmentVariables</key>');
      expect(xml).toContain('<key>PATH</key>');
      expect(xml).toContain(`<string>/opt/homebrew/bin:/usr/bin:${FALLBACK}</string>`);
    } finally {
      if (original === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = original;
      }
    }
  });

  test('PATH 가 비어 있어도(테스트 환경 등) 흔한 설치 위치로 폴백한다', () => {
    const original = process.env.PATH;
    delete process.env.PATH;
    try {
      expect(plistContent()).toContain(`<string>${FALLBACK}</string>`);
    } finally {
      if (original !== undefined) {
        process.env.PATH = original;
      }
    }
  });

  test('PATH 에 &/</> 가 섞여도 XML 엔티티로 이스케이프해 파싱 가능한 plist 를 만든다', () => {
    // 예: `/Users/x/Tools & Scripts/bin` — 실제로 나올 수 있는 디렉터리 이름이다.
    const xml = plistContent({ path: '/usr/bin:/Users/x/Tools & Scripts<bin>:/bin' });
    expect(xml).toContain('<string>/usr/bin:/Users/x/Tools &amp; Scripts&lt;bin&gt;:/bin</string>');
    expect(xml).not.toContain('Tools & Scripts<bin>');
  });

  test('execPath/entryPath/logPath 에 특수문자가 있어도 각각 이스케이프된다', () => {
    const xml = plistContent({
      execPath: '/opt/bun & co/bin/bun',
      entryPath: '/repo/<daemon>.ts',
      logPath: '/tmp/rocky & todo/daemon.log',
    });
    expect(xml).toContain('<string>/opt/bun &amp; co/bin/bun</string>');
    expect(xml).toContain('<string>/repo/&lt;daemon&gt;.ts</string>');
    expect(xml).toContain('<string>/tmp/rocky &amp; todo/daemon.log</string>');
    expect(xml).not.toContain('/opt/bun & co');
    expect(xml).not.toContain('<daemon>.ts');
    expect(xml).not.toContain('/tmp/rocky & todo');
  });

  test('override 없이 호출하면 기존 기본 동작(실제 process.execPath 등)이 그대로다', () => {
    const xml = plistContent();
    // escapeXml 은 항등 함수와 다를 게 없는 값(특수문자 없는 실제 경로)에 대해
    // 회귀를 만들지 않는다 — 기존 두 테스트가 이미 이 계약을 커버하므로 여기서는
    // ProgramArguments 자리에 process.execPath 가 그대로(이스케이프해도 불변) 있는지만 본다.
    expect(xml).toContain(`<string>${process.execPath}</string>`);
  });
});
