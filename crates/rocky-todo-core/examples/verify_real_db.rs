//! Phase 1 게이트 — 실 DB **복사본**을 Rust 스토어로 열어 마이그레이션 무해성과
//! 행수·내용 일치를 검증한다. 사용: cargo run --example verify_real_db -- <db 복사본 경로>

use rocky_todo_core::store::TodoStore;
use rocky_todo_core::types::*;

fn main() {
    let path = std::env::args()
        .nth(1)
        .expect("usage: verify_real_db <db-path>");
    let path = std::path::PathBuf::from(path);

    let store = TodoStore::open(&path).expect("open store");

    let boards = store.list_boards(true).unwrap();
    let todos = store
        .list_todos(&ListTodosFilter {
            include_archived: true,
            ..Default::default()
        })
        .unwrap();
    let notes = store
        .list_notes(&ListNotesFilter {
            include_archived: true,
            ..Default::default()
        })
        .unwrap();
    let handoffs = store.list_handoffs(&ListHandoffsFilter::default()).unwrap();
    let history = store
        .list_history(&ListHistoryFilter {
            limit: Some(100_000),
            ..Default::default()
        })
        .unwrap();

    println!("boards={}", boards.len());
    println!("todos={}", todos.len());
    println!("notes={}", notes.len()); // 필터 없는 list_notes 는 보드+글로벌 전부다
    println!("handoffs={}", handoffs.len());
    println!("history={}", history.len());

    let mut sections = 0usize;
    let mut comments = 0usize;
    for board in &boards {
        sections += store.list_sections(&board.id, true).unwrap().len();
    }
    for todo in &todos {
        comments += store.list_comments(&todo.id, true).unwrap().len();
    }
    println!("sections={sections}");
    println!("comments={comments}");

    // 참조 해석 실전 검증 — 실 보드의 실제 항목이 왕복되는가.
    let t23 = store
        .get_todo("rocky-todo-23", None)
        .unwrap()
        .expect("rocky-todo-23 should resolve");
    println!("rocky-todo-23.title={}", t23.title);
    println!("rocky-todo-23.status={}", t23.status.as_str());
    let view = rocky_todo_core::refs::with_ref_todo(&store, t23).unwrap();
    println!(
        "rocky-todo-23.ref={} comments={}",
        view.r#ref, view.comment_count
    );

    // 변경 피드 — 전체를 한 번 돌려 파싱 실패(enum/JSON)가 없는지 확인.
    let feed = store.list_changes_since(0, Some(100_000)).unwrap();
    println!(
        "changes_feed={} last_id={}",
        feed.entries.len(),
        feed.last_id
    );
}
