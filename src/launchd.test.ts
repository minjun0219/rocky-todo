import { describe, expect, test } from 'bun:test';
import { plistContent } from './launchd';

/**
 * `installLaunchd`/`uninstallLaunchd` 는 실제 `~/Library/LaunchAgents` 와 `launchctl` 을
 * 건드리는 매우 부수효과가 큰 함수라(호스트 launchd 상태를 바꾼다) 여기서 실행하지 않는다.
 * plist 를 만드는 순수 함수(`plistContent`)만 검증한다 — PATH 회귀는 이 정도로 충분히 잡힌다.
 */
describe('plistContent', () => {
  test('EnvironmentVariables 로 설치 시점 PATH 를 굽는다 — launchd 기본 PATH 에는 claude 가 없다', () => {
    const xml = plistContent();
    expect(xml).toContain('<key>EnvironmentVariables</key>');
    expect(xml).toContain('<key>PATH</key>');
    expect(xml).toContain(
      `<string>${process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin'}</string>`,
    );
  });

  test('PATH 가 비어 있어도(테스트 환경 등) 최소 기본 PATH 로 폴백한다', () => {
    const original = process.env.PATH;
    delete process.env.PATH;
    try {
      const xml = plistContent();
      expect(xml).toContain('<string>/usr/bin:/bin:/usr/sbin:/sbin</string>');
    } finally {
      if (original !== undefined) {
        process.env.PATH = original;
      }
    }
  });
});
