import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
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

function plistContent(): string {
  const logPath = join(DEFAULT_TODO_DIR, 'daemon.log');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>run</string>
    <string>${daemonEntryPath()}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${logPath}</string>
  <key>StandardErrorPath</key><string>${logPath}</string>
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
