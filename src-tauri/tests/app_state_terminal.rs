use ai_term_lib::app::state::AppState;
use ai_term_lib::domain::terminal::ssh::TerminalSession;
use anyhow::Result;
use std::sync::{Arc, Mutex};

#[derive(Clone, Default)]
struct RecordingTerminal {
    writes: Arc<Mutex<Vec<Vec<u8>>>>,
    resizes: Arc<Mutex<Vec<(u16, u16)>>>,
}

impl TerminalSession for RecordingTerminal {
    fn write(&mut self, bytes: &[u8]) -> Result<()> {
        self.writes.lock().unwrap().push(bytes.to_vec());
        Ok(())
    }

    fn resize(&mut self, cols: u16, rows: u16) -> Result<()> {
        self.resizes.lock().unwrap().push((cols, rows));
        Ok(())
    }
}

#[tokio::test]
async fn write_terminal_forwards_bytes_to_registered_session() {
    let state = AppState::default();
    let terminal = RecordingTerminal::default();
    let writes = terminal.writes.clone();

    state
        .register_terminal_session("local-1".into(), "local".into(), Box::new(terminal))
        .await;

    state
        .write_terminal("local-1", b"pwd\n".to_vec())
        .await
        .unwrap();

    assert_eq!(writes.lock().unwrap().as_slice(), &[b"pwd\n".to_vec()]);
}

#[tokio::test]
async fn resize_terminal_forwards_size_to_registered_session() {
    let state = AppState::default();
    let terminal = RecordingTerminal::default();
    let resizes = terminal.resizes.clone();

    state
        .register_terminal_session("local-1".into(), "local".into(), Box::new(terminal))
        .await;

    state.resize_terminal("local-1", 120, 34).await.unwrap();

    assert_eq!(resizes.lock().unwrap().as_slice(), &[(120, 34)]);
}

#[tokio::test]
async fn write_terminal_rejects_unknown_session() {
    let state = AppState::default();

    let err = state
        .write_terminal("missing", b"pwd\n".to_vec())
        .await
        .unwrap_err();

    assert_eq!(err.to_string(), "unknown session missing");
}

#[tokio::test]
async fn write_terminal_reports_unattached_profile_session() {
    let state = AppState::default();

    state
        .register_session("remote-1".into(), "profile-1".into())
        .await;

    let handled = state
        .write_terminal("remote-1", b"pwd\n".to_vec())
        .await
        .unwrap();

    assert!(!handled);
}

#[tokio::test]
async fn remove_session_drops_registered_session() {
    let state = AppState::default();
    let terminal = RecordingTerminal::default();

    state
        .register_terminal_session("local-1".into(), "local".into(), Box::new(terminal))
        .await;

    assert!(state.has_session("local-1").await);
    assert!(state.remove_session("local-1").await);
    assert!(!state.has_session("local-1").await);
}
