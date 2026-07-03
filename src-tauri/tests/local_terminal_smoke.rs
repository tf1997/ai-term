use ai_term_lib::domain::terminal::local::spawn_local_terminal;
use std::sync::mpsc;
use std::time::{Duration, Instant};

#[test]
fn local_terminal_executes_shell_commands_and_streams_output() {
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    let (exit_tx, _exit_rx) = mpsc::channel::<()>();
    let mut terminal = spawn_local_terminal(
        80,
        24,
        move |bytes| {
            let _ = tx.send(bytes);
        },
        move || {
            let _ = exit_tx.send(());
        },
    )
    .expect("local terminal should spawn");

    answer_terminal_position_query(&mut terminal);
    terminal
        .write(local_echo_command())
        .expect("write should reach local shell");

    let started = Instant::now();
    let mut output = Vec::new();
    while started.elapsed() < Duration::from_secs(5) {
        if let Ok(bytes) = rx.recv_timeout(Duration::from_millis(250)) {
            output.extend(bytes);
            if String::from_utf8_lossy(&output).contains("__AI_TERM_LOCAL_OK__") {
                return;
            }
        }
    }

    panic!(
        "local terminal did not stream command output; captured: {}",
        String::from_utf8_lossy(&output)
    );
}

#[test]
fn local_terminal_notifies_when_shell_exits() {
    let (_output_tx, _output_rx) = mpsc::channel::<Vec<u8>>();
    let (exit_tx, exit_rx) = mpsc::channel::<()>();
    let mut terminal = spawn_local_terminal(
        80,
        24,
        move |_bytes| {},
        move || {
            let _ = exit_tx.send(());
        },
    )
    .expect("local terminal should spawn");

    answer_terminal_position_query(&mut terminal);
    terminal
        .write(local_exit_command())
        .expect("exit should reach local shell");

    exit_rx
        .recv_timeout(Duration::from_secs(5))
        .expect("local terminal should notify when the shell exits");
}

#[cfg(windows)]
fn local_echo_command() -> &'static [u8] {
    b"echo __AI_TERM_LOCAL_OK__\r\n"
}

#[cfg(not(windows))]
fn local_echo_command() -> &'static [u8] {
    b"printf __AI_TERM_LOCAL_OK__\\n\n"
}

#[cfg(windows)]
fn local_exit_command() -> &'static [u8] {
    b"exit\r\n"
}

#[cfg(not(windows))]
fn local_exit_command() -> &'static [u8] {
    b"exit\n"
}

#[cfg(windows)]
fn answer_terminal_position_query(
    terminal: &mut ai_term_lib::domain::terminal::local::LocalTerminalSession,
) {
    terminal
        .write(b"\x1b[1;1R")
        .expect("cursor position response should reach local shell");
}

#[cfg(not(windows))]
fn answer_terminal_position_query(
    _terminal: &mut ai_term_lib::domain::terminal::local::LocalTerminalSession,
) {
}
