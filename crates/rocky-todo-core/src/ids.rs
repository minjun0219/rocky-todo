//! 엔티티 id 생성과 그 길이 — TS 원본 `src/ids.ts`.
//!
//! `ID_LENGTH` 는 참조 해석이 "번호냐 id 냐"를 가르는 기준이다(짧은 순수 숫자는 번호,
//! 그 이상은 id) — `refs`/`store` 양쪽이 같은 값을 봐야 한다.

use rand::RngCore;

const ID_ALPHABET: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";

/// 랜덤 id 길이 — 참조 해석이 "번호냐 id 냐"를 가르는 기준.
pub const ID_LENGTH: usize = 8;

/// 8자 base36 랜덤 id — 짧아서 CLI/대화에서 다루기 좋고 prefix 매칭을 허용한다.
pub fn new_id() -> String {
    let mut bytes = [0u8; ID_LENGTH];
    rand::rng().fill_bytes(&mut bytes);
    bytes
        .iter()
        .map(|b| ID_ALPHABET[(b % 36) as usize] as char)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_id_shape() {
        let id = new_id();
        assert_eq!(id.len(), ID_LENGTH);
        assert!(id
            .chars()
            .all(|c| c.is_ascii_digit() || c.is_ascii_lowercase()));
    }

    #[test]
    fn new_id_unique_enough() {
        let a = new_id();
        let b = new_id();
        assert_ne!(a, b);
    }
}
