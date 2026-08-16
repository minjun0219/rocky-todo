import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DEFAULT_TODO_DIR } from './config';

/**
 * launchd 상주 등록 — `rocky-todo daemon install` 이 쓰는 macOS 전용 헬퍼.
 *
 * KeepAlive 로 데몬을 로그인 세션 동안 상시 유지한다. 미설치 상태여도 CLI 의
 * 온디맨드 자동 기동은 그대로 동작하므로 install 은 선택 사항이다.
 */

export const LAUNCHD_LABEL = 'com.rocky.todo';

const PLIST_PATH = join(homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);

/**
 * launchd(KeepAlive) 상주 job 이 등록돼 있나 — plist 존재 여부로 판별한다 (macOS 전용).
 *
 * 등록돼 있으면 데몬은 launchd 가 관리하므로, 구버전을 교체할 때 PID 만 죽여선 안 된다
 * (KeepAlive 가 같은 plist 경로의 구버전을 즉시 되살린다). `installLaunchd` 로 job 자체를
 * 현재 설치 경로로 교체해야 한다.
 */
export function isLaunchdRegistered(): boolean {
  return process.platform === 'darwin' && existsSync(PLIST_PATH);
}

function daemonEntryPath(): string {
  return join(import.meta.dir, 'daemon.ts');
}

/**
 * launchd 가 잡에 물려주는 PATH 는 최소치(`/usr/bin:/bin:/usr/sbin:/sbin`)라 Homebrew 등
 * 사용자 설치 위치가 빠진다. `bun` 은 그래서 `process.execPath` 로 절대경로를 쓴다(아래
 * ProgramArguments). 하지만 데몬이 이름만으로 spawn 하는 외부 CLI 가 둘 있다:
 * `src/github.ts` 의 `gh`(finding D — 최소 PATH 아래서 "gh CLI 를 찾을 수 없다"는 잘못된
 * 메시지가 뜬다)와 `src/sessions.ts` 의 `claude`(못 찾으면 핸드오프 기능 전체가
 * `available:false` 로 죽는다). 둘 다 같은 함정이고, SessionStart 훅이 띄운 데몬은 셸
 * PATH 를 상속해 잘 도는데 `daemon install` 로 상주시킨 데몬만 안 되는 상태를 만든다.
 */
const PLIST_PATH_FALLBACK = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';

/**
 * plist 에 구울 PATH — **설치 시점의 `process.env.PATH` 를 우선**한다. 지금 이 셸에서
 * `gh`/`claude` 가 보이면(`command -v`) launchd 데몬도 보게 만드는 게 가장 정확하다.
 * 뒤에 흔한 설치 위치를 이어 붙여, PATH 가 비었거나 비표준 셸에서 설치한 경우도 받친다
 * (중복 항목은 PATH 해석에 무해하다).
 */
function pathForPlist(): string {
  const inherited = process.env.PATH;
  return inherited ? `${inherited}:${PLIST_PATH_FALLBACK}` : PLIST_PATH_FALLBACK;
}

/**
 * plist 는 XML 이다 — 보간되는 값(PATH, 실행 파일 경로, 로그 경로 등)에 `&`/`<`/`>` 가
 * 섞이면(예: `/Users/x/Tools & Scripts/bin`) 이스케이프 없이는 파싱 불가한 plist 가
 * 만들어진다. `installLaunchd` 는 이 plist 를 쓰기 전에 기존 job 을 먼저 내리므로
 * (`launchctl bootout` → `bootstrap`), 깨진 plist 로 로드가 실패하면 상주 데몬이 롤백 없이
 * 사라진다 — 여기서 막아야 하는 이유다. `"` 는 속성값이 아니라 텍스트 노드 안에서만
 * 쓰이므로(이 파일의 모든 보간이 `<string>...</string>` 안) 이스케이프 대상에서 뺐다.
 */
function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/**
 * plist 에 들어가는 보간값 — 기본은 실제 install 시점 값(process.execPath/PATH/실제 경로).
 * 테스트에서 특수문자가 든 값의 이스케이프를 검증할 수 있도록 override 가능한 seam 을
 * 열어뒀다 — `plistContent()`(인자 없이 호출)의 기본 동작은 이전과 동일하다.
 */
export interface PlistValues {
  execPath?: string;
  entryPath?: string;
  logPath?: string;
  path?: string;
}

/** plist 본문 — install 시점에 캡처한 PATH 를 EnvironmentVariables 로 굽는다. 테스트 전용 export. */
export function plistContent(overrides?: PlistValues): string {
  const execPath = overrides?.execPath ?? process.execPath;
  const entryPath = overrides?.entryPath ?? daemonEntryPath();
  const logPath = overrides?.logPath ?? join(DEFAULT_TODO_DIR, 'daemon.log');
  const path = overrides?.path ?? pathForPlist();
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(execPath)}</string>
    <string>run</string>
    <string>${escapeXml(entryPath)}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <!-- bunfig.toml(Tailwind serve 플러그인)은 시작 시점 cwd 에서 읽힌다 — 레포 루트 고정. -->
  <key>WorkingDirectory</key><string>${escapeXml(join(dirname(entryPath), '..'))}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${escapeXml(path)}</string>
  </dict>
  <key>StandardOutPath</key><string>${escapeXml(logPath)}</string>
  <key>StandardErrorPath</key><string>${escapeXml(logPath)}</string>
</dict>
</plist>
`;
}

function launchctl(args: string[]): { ok: boolean; out: string } {
  const proc = Bun.spawnSync({ cmd: ['launchctl', ...args], stdout: 'pipe', stderr: 'pipe' });
  return {
    ok: proc.exitCode === 0,
    out: `${proc.stdout.toString()}${proc.stderr.toString()}`.trim(),
  };
}

function gid(): string {
  return `gui/${process.getuid?.() ?? 501}`;
}

export function installLaunchd(): string {
  mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
  mkdirSync(DEFAULT_TODO_DIR, { recursive: true });
  writeFileSync(PLIST_PATH, plistContent());
  // 재설치를 멱등하게 — 이미 떠 있으면 내리고 다시 올린다
  launchctl(['bootout', gid(), PLIST_PATH]);
  const result = launchctl(['bootstrap', gid(), PLIST_PATH]);
  if (!result.ok) {
    return `launchd 등록 실패: ${result.out}\nplist: ${PLIST_PATH}`;
  }
  return `✓ launchd 등록 완료 (${LAUNCHD_LABEL}) — 로그인 시 자동 기동 + KeepAlive\n  plist: ${PLIST_PATH}`;
}

export function uninstallLaunchd(): string {
  const result = launchctl(['bootout', gid(), PLIST_PATH]);
  if (existsSync(PLIST_PATH)) {
    rmSync(PLIST_PATH, { force: true });
  }
  return result.ok
    ? `✓ launchd 해제 완료 (${LAUNCHD_LABEL})`
    : `launchd 해제: 등록되어 있지 않았다 (plist 는 정리됨)`;
}

export function launchdStatus(): string {
  if (!existsSync(PLIST_PATH)) {
    return 'launchd: 미등록 (온디맨드 자동 기동만 사용중)';
  }
  const result = launchctl(['print', `${gid()}/${LAUNCHD_LABEL}`]);
  if (!result.ok) {
    return `launchd: plist 는 있으나 로드되지 않음 (${PLIST_PATH})`;
  }
  const state = result.out.match(/state = (\w+)/)?.[1] ?? 'unknown';
  return `launchd: 등록됨, state=${state}`;
}
