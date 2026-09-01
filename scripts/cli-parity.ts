/**
 * Rust CLI ↔ TS CLI 출력 대조 (parity 게이트).
 *
 * 포팅이 자기 테스트를 통과하는 것과 **원본과 같은 출력을 내는 것**은 다르다. 이 스크립트는
 * 데모 데몬 하나를 띄우고 두 CLI 를 같은 상태에 붙여 stdout 을 바이트 단위로 비교한다.
 * 한쪽만 고치면 여기서 걸린다.
 *
 * 실행: `bun scripts/cli-parity.ts` (Rust 바이너리가 필요하다 — `cargo build`).
 * 데몬은 전용 포트/디렉터리에 `expose: off` 로 띄워 전역 설정을 상속하지 않는다.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 포트 고정은 로컬/CI 에서 점유 충돌로 플래키해질 수 있다 — env 로 오버라이드 가능.
const PORT = Number.parseInt(process.env.ROCKY_TODO_PARITY_PORT ?? '', 10) || 8994;
const ROOT = join(import.meta.dir, '..');
const RUST_CLI = join(ROOT, 'target/debug/rocky-todo');
const RUST_DAEMON = join(ROOT, 'target/debug/rocky-todod');

/** 두 CLI 에 똑같이 넘길 인자 묶음. 텍스트 경로와 에러 경로를 함께 덮는다. */
const CASES: string[][] = [
  ['help'],
  ['ls', '--board', 'parity'],
  ['ls', '--board', 'parity', '--archived'],
  ['ls', '--board', 'parity', '--json'],
  ['ls', '--all'],
  ['show', 'parity-1', '--board', 'parity'],
  ['show', 'parity-1', '--board', 'parity', '--json'],
  ['section', 'ls', '--board', 'parity'],
  ['sessions', '--board', 'parity'],
  ['next', '--board', 'parity'],
  ['next', '--board', 'parity', '--json'],
  ['next', '--board', 'parity', '--limit', '2'],
  ['board', 'ls'],
  ['board', 'show', 'parity'],
  ['history', 'parity-1', '--board', 'parity'],
  ['history', 'parity-1', '--board', 'parity', '--limit', '3'],
  ['note', 'ls', '--board', 'parity'],
  ['note', 'ls', '--global'],
  ['note', 'ls', '--board', 'parity', '--json'],
  ['note', 'show', 'parity-1', '--board', 'parity'],
  ['note', 'show', 'note-1', '--global'],
  // 에러 경로 — 메시지가 사용자 표면이라 함께 고정한다.
  ['show', '999', '--board', 'parity'],
  ['show', '--board', 'parity'],
  ['ls', '--explode'],
  ['comment', 'parity-1', '--board', 'parity'],
  ['section', 'archive', '없는섹션', '--board', 'parity'],
  ['move', 'parity-1', '--board', 'parity'],
  ['board', 'show', '없는보드'],
  ['history', '--board', 'parity'],
  ['board', 'nonsense'],
  ['note', 'nonsense'],
  ['note', 'show', '--board', 'parity'],
  ['note', 'edit', 'parity-1', '--board', 'parity'],
  ['note', 'append', 'parity-1', '--board', 'parity'],
  ['mcp', 'setup'],
  ['mcp', 'nonsense'],
  ['tailscale', 'nonsense'],
  ['daemon', 'nonsense'],
  ['issue'],
  ['issue', 'parity-1', '--repo', '이상한모양', '--board', 'parity'],
  ['nonsense-command'],
];

/** 보드를 만들고 대조에 쓸 상태를 심는다 — Rust CLI 로 한다(둘 다 같은 데몬을 본다). */
const SEED: string[][] = [
  ['add', '첫 작업', '--board', 'parity', '--priority', 'p1', '--label', 'bug,urgent'],
  ['add', '둘째', '--board', 'parity'],
  ['add', '자식', '--board', 'parity', '--parent', 'parity-1'],
  ['start', 'parity-1', '--board', 'parity'],
  ['comment', 'parity-1', '진행 보고', '--board', 'parity'],
  ['section', 'add', '진행중', '--board', 'parity'],
  ['note', 'add', '보드 메모', '--board', 'parity', '--content', '본문 한 줄'],
  ['note', 'add', '전역 메모', '--global', '--content', '전역 본문'],
];

interface RunResult {
  text: string;
  exitCode: number | null;
}

function run(cmd: string[], env: Record<string, string>): RunResult {
  const proc = Bun.spawnSync({
    cmd,
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
    // 케이스당 상한 — 데몬/CLI 가 어떤 이유로든 응답을 못 하면 CI 가 무기한 매달린다.
    timeout: 30_000,
  });
  return {
    text: `${proc.stdout.toString()}${proc.stderr.toString()}`,
    exitCode: proc.exitCode,
  };
}

const dir = mkdtempSync(join(tmpdir(), 'rt-parity-'));
const configPath = join(dir, 'config.json');
writeFileSync(
  configPath,
  JSON.stringify({ todo: { port: PORT, dir: join(dir, 'data'), expose: 'off' } }),
);
const env = { ROCKY_CONFIG: configPath };

const daemon = Bun.spawn({
  cmd: [RUST_DAEMON],
  env: { ...process.env, ...env },
  stdout: 'ignore',
  stderr: 'ignore',
});

let failures = 0;
try {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const ok = await fetch(`http://127.0.0.1:${PORT}/api/health`)
      .then((r) => r.ok)
      .catch(() => false);
    if (ok) {
      break;
    }
    if (Date.now() > deadline) {
      throw new Error('데몬이 뜨지 않았다');
    }
    await Bun.sleep(150);
  }

  for (const args of SEED) {
    // 시드가 실패하면 이후 비교가 빈 보드 위에서 공허하게 통과한다 — 즉시 끊는다.
    const seeded = run([RUST_CLI, ...args], env);
    if (seeded.exitCode !== 0) {
      throw new Error(`시드 실패 (${args.join(' ')}):\n${seeded.text}`);
    }
  }

  for (const args of CASES) {
    const rust = run([RUST_CLI, ...args], env);
    const ts = run([process.execPath, join(ROOT, 'src/cli.ts'), ...args], env);
    const label = args.join(' ');
    // 출력이 같아도 종료 코드가 다르면(성공/실패 판정 회귀) 게이트가 잡아야 한다.
    if (rust.text === ts.text && rust.exitCode === ts.exitCode) {
      console.log(`✓ ${label}`);
      continue;
    }
    failures++;
    console.log(`✗ ${label}  (exit TS=${ts.exitCode} Rust=${rust.exitCode})`);
    console.log(`--- TS ---\n${ts.text}--- Rust ---\n${rust.text}`);
  }
} finally {
  // kill 만 하고 떠나면 데몬이 내려가기 전에 임시 디렉터리 삭제/포트 재사용과
  // 레이스가 된다 — 종료를 기다린 뒤 정리한다.
  daemon.kill();
  await daemon.exited;
  rmSync(dir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures}건이 어긋났다`);
  process.exit(1);
}
console.log('\n모든 케이스에서 두 CLI 의 출력이 같다');
