"""Isolated loopback exec fixture. Only used by opt-in Rust protocol tests."""
import argparse
import json
import logging
import os
import selectors
import signal
import socket
import subprocess
import threading
import time
from pathlib import Path

import paramiko

parser = argparse.ArgumentParser()
parser.add_argument('--root', required=True)
parser.add_argument('--mode', default='normal')
args = parser.parse_args()
root = Path(args.root).resolve()
logging.getLogger('paramiko').setLevel(logging.CRITICAL)
audit_lock = threading.Lock()


def audit(name):
    with audit_lock, (root / 'audit').open('a') as f:
        f.write(name + '\n')


class Server(paramiko.ServerInterface):
    def check_auth_password(self, username, password):
        return paramiko.AUTH_SUCCESSFUL if (username, password) == ('fixture', 'fixture-password') else paramiko.AUTH_FAILED

    def get_allowed_auths(self, username):
        return 'password'

    def check_channel_request(self, kind, channel_id):
        return paramiko.OPEN_SUCCEEDED if kind == 'session' else paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED

    def check_channel_exec_request(self, channel, command):
        audit('exec')
        if args.mode == 'reject':
            return False
        threading.Thread(target=run, args=(channel, command.decode()), daemon=True).start()
        return True


def run(channel, command):
    process = None
    try:
        if args.mode == 'missing-trailer':
            channel.send(b'partial output')
            channel.send_exit_status(0)
            return
        environment = dict(os.environ, AI_TERM_PTY_ONLY='must-not-leak')
        process = subprocess.Popen(['/bin/sh', '-c', command], cwd=root, env=environment,
                                   stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, start_new_session=True)
        selector = selectors.DefaultSelector()
        selector.register(process.stdout, selectors.EVENT_READ, False)
        selector.register(process.stderr, selectors.EVENT_READ, True)
        while selector.get_map() and not channel.closed:
            for key, _ in selector.select(timeout=.1):
                chunk = os.read(key.fileobj.fileno(), 4096)
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                send = channel.send_stderr if key.data else channel.send
                while chunk:
                    sent = send(chunk)
                    if not sent:
                        return
                    chunk = chunk[sent:]
                if args.mode == 'disconnect':
                    channel.get_transport().close()
                    return
        code = process.wait()
        if args.mode != 'no-exit-status':
            channel.send_exit_status(code)
    except (OSError, EOFError):
        pass
    finally:
        # Fixture-owned children are cleaned up; production channel closure
        # makes no corresponding claim about remote process termination.
        if process and process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
        channel.close()


key = paramiko.RSAKey.generate(2048)
listener = socket.socket()
listener.bind(('127.0.0.1', 0))
listener.listen(8)
print(json.dumps({'port': listener.getsockname()[1]}), flush=True)


def accept(client):
    transport = paramiko.Transport(client)
    try:
        transport.add_server_key(key)
        transport.start_server(server=Server())
        channels = []
        while transport.is_active():
            channel = transport.accept(timeout=.1)
            if channel:
                channels.append(channel)
    except (EOFError, OSError, paramiko.SSHException):
        pass
    finally:
        transport.close()


while True:
    client, _ = listener.accept()
    threading.Thread(target=accept, args=(client,), daemon=True).start()
