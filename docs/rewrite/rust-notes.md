# Rust 학습 노트

이 코드베이스를 포팅하며 실제로 부딪힌 것만 적는다 — 일반 튜토리얼이 아니다.
크레이트별 함정(rusqlite / axum / rmcp / tauri) 포함.

## Phase 0

- `rust-toolchain.toml` 은 **채널만** 고정한다(`channel = "stable"`) — 특정 버전이
  아니라 그때의 stable 을 따라간다. 현재 실측 stable 은 1.98.0 (2026-08). components 에
  rustfmt/clippy 를 명시해야 CI 러너에서도 같이 설치된다.

## Phase 1

- `rusqlite` 의 `query_row(...).optional()` 은 `OptionalExtension` trait import 필요.
- `Connection::transaction()` 은 `&mut self` 를 요구 — `Mutex<Connection>` + 명시적
  `execute_batch("BEGIN"/"COMMIT"/"ROLLBACK")` 이 TS(bun:sqlite) 코드와 1:1 로 대응돼
  오히려 포팅이 정직해진다.
- `PRAGMA user_version = ?` 은 바인딩 불가 — `format!` 으로 박는다(값은 루프 인덱스).
- rand 0.9: `rand::rng()` + `RngCore::fill_bytes` (0.8 의 `thread_rng()` 는 구 API).
- chrono 로 JS `toISOString()` 재현: `%Y-%m-%dT%H:%M:%S%.3fZ` (밀리초 3자리 + Z).
- 클로저(`stage`/`apply`)가 `&mut` 를 잡아도 NLL 이 마지막 사용 지점에서 빌림을 끝내므로
  이후 `record_history(&changes)` 가 컴파일된다 — 클로저를 drop 할 필요 없음.
- clippy `-D warnings` 가 테스트 코드까지 본다: `&(dyn Fn…)` 불필요 괄호,
  `.err().expect()` → `expect_err` 등. CI 와 같은 플래그로 로컬에서 미리 돌릴 것.
