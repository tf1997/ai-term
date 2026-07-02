use ai_term_lib::app::events::{
    terminal_closed_event_name, terminal_data_event_name, TerminalClosedEvent, TerminalDataEvent,
};
use ai_term_lib::app::state::AppState;

#[test]
fn terminal_data_event_name_is_scoped_to_session() {
    assert_eq!(
        terminal_data_event_name("session-1"),
        "terminal:data:session-1"
    );
}

#[test]
fn terminal_closed_event_name_is_scoped_to_session() {
    assert_eq!(
        terminal_closed_event_name("session-1"),
        "terminal:closed:session-1"
    );
}

#[test]
fn terminal_event_payload_keeps_session_id_for_diagnostics() {
    let payload = TerminalDataEvent {
        session_id: "session-1".into(),
        data: "hello".into(),
    };

    assert_eq!(payload.session_id, "session-1");
    assert_eq!(payload.data, "hello");
}

#[test]
fn terminal_closed_payload_keeps_exit_reason() {
    let payload = TerminalClosedEvent {
        session_id: "session-1".into(),
        reason: "eof".into(),
    };

    assert_eq!(payload.session_id, "session-1");
    assert_eq!(payload.reason, "eof");
}

#[tokio::test]
async fn unattached_profile_session_does_not_handle_terminal_input() {
    let state = AppState::default();
    state
        .register_session("remote-1".into(), "profile-1".into())
        .await;

    let handled = state
        .write_terminal("remote-1", b"echo should-not-echo\n".to_vec())
        .await
        .unwrap();

    assert!(!handled);
}
