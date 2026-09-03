import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * `bin/rocky-todo`(셸 부트스트랩) 스모크 — 다운로드 없이 검증할 수 있는 경로만 본다.
 * 실제 tarball 을 받는 경로는 GitHub 에 닿아야 해서 테스트에 넣지 않는다 — 대신
 * 존재하지 않는 미러(`ROCKY_TODO_RELEASE_BASE`)와 격리된 `XDG_DATA_HOME` 으로
 * "받아야 하는데 못 받는" 상황을 만든다.
 */
const bin = join(import.meta.dir, '..', 'bin', 'rocky-todo');

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rocky-todo-bootstrap-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(args: string[], env: Record<string, string>) {
  const proc = Bun.spawnSync({
    cmd: [bin, ...args],
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      PATH: process.env.PATH ?? '',
      HOME: dir,
      XDG_DATA_HOME: join(dir, 'data'),
      // 진짜 릴리스에 닿지 않게 — 아무도 안 듣는 루프백 포트
      ROCKY_TODO_RELEASE_BASE: 'http://127.0.0.1:9/none',
      ...env,
    },
  });
  return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() };
}

function fakeBinary(): string {
  const path = join(dir, 'fake-rocky-todo');
  writeFileSync(path, '#!/bin/sh\necho "fake:$*"\nexit 7\n');
  chmodSync(path, 0o755);
  return path;
}

describe('bin/rocky-todo bootstrap', () => {
  test('ROCKY_TODO_BIN 이 있으면 그 바이너리로 인자 그대로 exec 한다', () => {
    const r = run(['hook', 'notify-todo', '--x'], { ROCKY_TODO_BIN: fakeBinary() });
    expect(r.out).toBe('fake:hook notify-todo --x\n');
    expect(r.code).toBe(7);
  });

  test('설치된 버전 디렉터리가 있으면 다운로드 없이 그것을 실행한다', () => {
    const version = '9.9.9-test.0';
    const root = join(dir, 'plugin');
    mkdirSync(join(root, '.claude-plugin'), { recursive: true });
    writeFileSync(
      join(root, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'rocky-todo', version, description: 'version 단어 함정' }),
    );
    const installed = join(dir, 'data', 'rocky-todo', `v${version}`);
    mkdirSync(installed, { recursive: true });
    writeFileSync(join(installed, 'rocky-todo'), '#!/bin/sh\necho "installed:$*"\n');
    chmodSync(join(installed, 'rocky-todo'), 0o755);

    const r = run(['ls'], { CLAUDE_PLUGIN_ROOT: root });
    expect(r.err).toBe('');
    expect(r.out).toBe('installed:ls\n');
    expect(r.code).toBe(0);
  });

  test('바이너리가 없을 때 SessionStart 가 아닌 훅은 조용히 0 으로 끝난다', () => {
    const root = join(import.meta.dir, '..');
    for (const hook of ['notify-todo', 'handoff-stop']) {
      const r = run(['hook', hook], { CLAUDE_PLUGIN_ROOT: root });
      expect(r.code).toBe(0);
      expect(r.out).toBe('');
      expect(r.err).toBe('');
    }
  });

  test('ensure-daemon 은 받으려 하고, 실패하면 fail-open(0) + stderr 한 줄', () => {
    const r = run(['hook', 'ensure-daemon'], { CLAUDE_PLUGIN_ROOT: join(import.meta.dir, '..') });
    expect(r.code).toBe(0);
    // Apple Silicon 이 아닌 러너(CI 의 ubuntu)는 다운로드 전에 플랫폼에서 걸린다
    expect(r.err).toMatch(/다운로드 실패|미지원 플랫폼/);
  });

  test('CLI 직접 실행은 같은 실패를 exit 1 로 낸다', () => {
    const r = run(['ls'], { CLAUDE_PLUGIN_ROOT: join(import.meta.dir, '..') });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/다운로드 실패|미지원 플랫폼/);
  });
});
