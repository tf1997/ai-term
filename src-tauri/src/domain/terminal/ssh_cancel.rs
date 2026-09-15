use anyhow::{bail, Result};
use std::net::{Shutdown, TcpStream};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc, Mutex,
};
use std::thread::{self, JoinHandle};
use std::time::Duration;

/// Each operation owns its watcher. A pooled SSH connection never retains the
/// cancellation token of the operation that originally created it.
pub(crate) struct SshIoCancellation {
    token: Option<Arc<AtomicBool>>,
    sockets: Arc<Mutex<Vec<TcpStream>>>,
    stop: Option<mpsc::Sender<()>>,
    worker: Option<JoinHandle<()>>,
}

impl SshIoCancellation {
    pub(crate) fn new(token: Option<&Arc<AtomicBool>>) -> Self {
        let sockets = Arc::new(Mutex::new(Vec::<TcpStream>::new()));
        let (stop, worker) = if let Some(token) = token {
            let token = token.clone();
            let tracked = sockets.clone();
            let (send, receive) = mpsc::channel();
            let worker = thread::spawn(move || loop {
                if token.load(Ordering::SeqCst) {
                    if let Ok(sockets) = tracked.lock() {
                        for socket in sockets.iter() {
                            let _ = socket.shutdown(Shutdown::Both);
                        }
                    }
                    break;
                }
                match receive.recv_timeout(Duration::from_millis(20)) {
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    _ => break,
                }
            });
            (Some(send), Some(worker))
        } else {
            (None, None)
        };
        Self {
            token: token.cloned(),
            sockets,
            stop,
            worker,
        }
    }

    pub(crate) fn check(&self) -> Result<()> {
        if self
            .token
            .as_ref()
            .is_some_and(|token| token.load(Ordering::SeqCst))
        {
            bail!("SFTP task cancelled");
        }
        Ok(())
    }

    pub(crate) fn is_cancellable(&self) -> bool {
        self.token.is_some()
    }

    pub(crate) fn track(&self, stream: &TcpStream) -> Result<()> {
        self.check()?;
        self.sockets.lock().unwrap().push(stream.try_clone()?);
        if let Err(error) = self.check() {
            let _ = stream.shutdown(Shutdown::Both);
            return Err(error);
        }
        Ok(())
    }

    pub(crate) fn sockets(&self) -> Result<Vec<TcpStream>> {
        self.sockets
            .lock()
            .unwrap()
            .iter()
            .map(TcpStream::try_clone)
            .collect::<std::io::Result<_>>()
            .map_err(Into::into)
    }
}

impl Drop for SshIoCancellation {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::net::TcpListener;
    use std::time::Instant;

    #[test]
    fn cancellation_closes_the_tracked_tcp_connection() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (mut server, _) = listener.accept().unwrap();
        server
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let token = Arc::new(AtomicBool::new(false));
        let guard = SshIoCancellation::new(Some(&token));
        guard.track(&client).unwrap();
        let started = Instant::now();
        let cancel = thread::spawn(move || {
            thread::sleep(Duration::from_millis(30));
            token.store(true, Ordering::SeqCst);
        });
        // Verify the peer observes closure. Windows can leave an ordinary
        // blocking recv pending after shutdown; libssh2 uses nonblocking socket
        // I/O, exercised by the separate stalled-handshake/SFTP protocol tests.
        let result = server.read(&mut [0]);
        assert!(!matches!(result, Ok(count) if count > 0));
        assert!(started.elapsed() < Duration::from_secs(1));
        cancel.join().unwrap();
    }

    #[test]
    fn completed_operation_does_not_cancel_a_reused_socket() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let mut client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (mut server, _) = listener.accept().unwrap();
        let token = Arc::new(AtomicBool::new(false));
        let guard = SshIoCancellation::new(Some(&token));
        guard.track(&client).unwrap();
        drop(guard);
        token.store(true, Ordering::SeqCst);
        std::io::Write::write_all(&mut server, b"ok").unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(1)))
            .unwrap();
        let mut bytes = [0; 2];
        client.read_exact(&mut bytes).unwrap();
        assert_eq!(&bytes, b"ok");
    }
}
