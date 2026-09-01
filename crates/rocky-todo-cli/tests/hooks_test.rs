//! TS `hooks/ensure-daemon.test.ts` 포팅 — 버전 인식 재기동의 분기들.

use std::cell::RefCell;

use rocky_todo_cli::client::{build_context, DaemonHealth};
use rocky_todo_cli::hooks::{ensure_daemon_with, EnsureDeps};

fn health(version: Option<&str>, pid: u32) -> DaemonHealth {
    DaemonHealth {
        ok: true,
        name: Some("rocky-todo".into()),
        version: version.map(str::to_string),
        pid: Some(pid),
        issue_create_allowed: None,
    }
}

/// 기록 장치 — 각 테스트가 관심 있는 축(spawn/stop/replace 횟수)만 드러낸다.
#[derive(Default)]
struct Log {
    spawned: RefCell<u32>,
    stopped: RefCell<Vec<Option<u32>>>,
    replaced: RefCell<u32>,
}

fn run(log: &Log, check: &dyn Fn(&str) -> Option<DaemonHealth>, managed: bool, stop_ok: bool) {
    let ctx = build_context(8636, std::env::temp_dir(), "test");
    ensure_daemon_with(
        &ctx,
        &EnsureDeps {
            version: "1.0.0",
            check_health: check,
            spawn: &|_| {
                *log.spawned.borrow_mut() += 1;
            },
            stop: &|_, pid| {
                log.stopped.borrow_mut().push(pid);
                stop_ok
            },
            is_managed: &move || managed,
            replace_managed: &|| {
                *log.replaced.borrow_mut() += 1;
            },
        },
    );
}

#[test]
fn same_version_running_is_a_no_op() {
    let log = Log::default();
    run(&log, &|_| Some(health(Some("1.0.0"), 111)), false, true);
    assert_eq!(*log.spawned.borrow(), 0);
    assert!(log.stopped.borrow().is_empty());
}

#[test]
fn absent_daemon_is_spawned() {
    let log = Log::default();
    run(&log, &|_| None, false, true);
    assert_eq!(*log.spawned.borrow(), 1);
    assert!(log.stopped.borrow().is_empty());
}

#[test]
fn stale_daemon_is_stopped_then_respawned() {
    let log = Log::default();
    run(&log, &|_| Some(health(Some("0.9.0"), 222)), false, true);
    assert_eq!(log.stopped.borrow().as_slice(), &[Some(222)]);
    assert_eq!(*log.spawned.borrow(), 1);
}

/// health 에 version 이 없던 시절(≤0.1.0)의 데몬 — 그대로 두면 영원히 안 올라온다.
#[test]
fn a_daemon_without_a_version_is_treated_as_stale() {
    let log = Log::default();
    run(&log, &|_| Some(health(None, 0)), false, true);
    assert_eq!(log.stopped.borrow().len(), 1);
    assert_eq!(*log.spawned.borrow(), 1);
}

/// 못 내리면 재기동하지 않는다 — 보드가 없는 것보다 구버전이라도 있는 게 낫다.
#[test]
fn respawn_is_skipped_when_the_stale_daemon_survives() {
    let log = Log::default();
    run(&log, &|_| Some(health(Some("0.9.0"), 333)), false, false);
    assert_eq!(log.stopped.borrow().len(), 1);
    assert_eq!(*log.spawned.borrow(), 0);
}

/// KeepAlive 가 PID kill 을 즉시 되살리므로 stop/spawn 이 아니라 job 을 교체해야 한다.
#[test]
fn a_managed_stale_daemon_is_replaced_not_killed() {
    let log = Log::default();
    run(&log, &|_| Some(health(Some("0.9.0"), 444)), true, true);
    assert_eq!(*log.replaced.borrow(), 1);
    assert!(log.stopped.borrow().is_empty());
    assert_eq!(*log.spawned.borrow(), 0);
}

#[test]
fn a_managed_daemon_on_the_same_version_is_untouched() {
    let log = Log::default();
    run(&log, &|_| Some(health(Some("1.0.0"), 555)), true, true);
    assert_eq!(*log.replaced.borrow(), 0);
    assert_eq!(*log.spawned.borrow(), 0);
}
