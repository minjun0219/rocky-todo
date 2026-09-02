import { describe, expect, it } from 'bun:test';
import { syncCargoLock, syncCargoToml, syncPluginJson } from './sync-version';

describe('syncPluginJson', () => {
  const plugin = `{
  "name": "rocky-todo",
  "version": "0.14.0",
  "description": "버전 인식 재기동 — version 이 다르면 재기동한다",
  "mcpServers": { "rocky-todo": { "url": "http://127.0.0.1:8636/mcp" } }
}
`;

  it('최상위 version 만 바꾸고 나머지 텍스트는 그대로 둔다', () => {
    const next = syncPluginJson(plugin, '0.15.0-next.0');
    expect(next).toContain('"version": "0.15.0-next.0"');
    expect(next.replace('"0.15.0-next.0"', '"0.14.0"')).toBe(plugin);
  });

  it('설명 문구 속 version 단어에 걸리지 않는다', () => {
    const next = syncPluginJson(plugin, '1.0.0');
    expect(next).toContain('버전 인식 재기동 — version 이 다르면');
  });

  it('필드가 없으면 실패한다', () => {
    expect(() => syncPluginJson('{ "name": "x" }', '1.0.0')).toThrow(/version 필드/);
  });
});

describe('syncCargoToml', () => {
  const cargo = `[workspace]
members = ["crates/rocky-todo-core", "app"]
resolver = "2"

[workspace.package]
version = "0.15.0-dev"
edition = "2021"

[workspace.dependencies]
serde_json = { version = "1", features = ["preserve_order"] }
tokio = { version = "1", features = ["full"] }
`;

  it('[workspace.package] 의 version 만 바꾼다', () => {
    const next = syncCargoToml(cargo, '0.15.0-next.0');
    expect(next).toContain('version = "0.15.0-next.0"\nedition');
    // 의존성 표기의 version 은 그대로
    expect(next).toContain('serde_json = { version = "1"');
    expect(next).toContain('tokio = { version = "1"');
  });

  it('섹션이 없으면 실패한다', () => {
    expect(() => syncCargoToml('[workspace]\nmembers = []\n', '1.0.0')).toThrow(
      /workspace\.package/,
    );
  });
});

describe('syncCargoLock', () => {
  const lock = `version = 4

[[package]]
name = "axum"
version = "0.8.4"
source = "registry+https://github.com/rust-lang/crates.io-index"

[[package]]
name = "rocky-todo-app"
version = "0.15.0-dev"
dependencies = [
 "rocky-todo-core",
]

[[package]]
name = "rocky-todo-cli"
version = "0.15.0-dev"

[[package]]
name = "rocky-todo-core"
version = "0.15.0-dev"

[[package]]
name = "rocky-todod"
version = "0.15.0-dev"
`;

  it('워크스페이스 멤버 넷의 버전을 바꾸고 외부 크레이트는 건드리지 않는다', () => {
    const next = syncCargoLock(lock, '0.15.0-next.0');
    expect(next.match(/0\.15\.0-next\.0/g)).toHaveLength(4);
    expect(next).not.toContain('0.15.0-dev');
    expect(next).toContain('name = "axum"\nversion = "0.8.4"');
  });

  it('멤버 항목이 하나라도 없으면 실패한다', () => {
    const missing = lock.replace('name = "rocky-todod"\nversion = "0.15.0-dev"\n', '');
    expect(() => syncCargoLock(missing, '1.0.0')).toThrow(/rocky-todod/);
  });
});
