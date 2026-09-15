"""Loopback-only SFTP fixture. Install paramiko into an isolated venv to run.

Rust tests own a fresh temporary root, this process, and an isolated known_hosts
file. No system SSH configuration or real host credentials are used.
"""
import argparse
import json
import logging
import os
from pathlib import Path
import posixpath
import socket
import threading
import time

import paramiko


parser = argparse.ArgumentParser()
parser.add_argument("--root", required=True)
parser.add_argument("--audit", required=True)
args = parser.parse_args()
ROOT = Path(args.root).resolve()
AUDIT = Path(args.audit)
AUDIT_LOCK = threading.Lock()
logging.getLogger("paramiko").setLevel(logging.CRITICAL)


def audit(event, **details):
    with AUDIT_LOCK, AUDIT.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps({"event": event, **details}) + "\n")


class Server(paramiko.ServerInterface):
    def __init__(self, transport):
        self.transport = transport

    def check_auth_password(self, username, password):
        audit("auth", username=username)
        if username == "fixture" and password == "fixture-password":
            return paramiko.AUTH_SUCCESSFUL
        return paramiko.AUTH_FAILED

    def get_allowed_auths(self, username):
        return "password"

    def check_channel_request(self, kind, channel_id):
        return paramiko.OPEN_SUCCEEDED if kind == "session" else paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED


class Handle(paramiko.SFTPHandle):
    def __init__(self, flags, path, transport):
        super().__init__(flags)
        self.path = path
        self.transport = transport

    def stat(self):
        return paramiko.SFTPAttributes.from_stat(os.fstat(self.readfile.fileno()))

    def read(self, offset, length):
        if self.path.name == "stall-read.txt":
            audit("stall-read")
            while self.transport.is_active():
                time.sleep(0.01)
            return b""
        return super().read(offset, length)

    def write(self, offset, data):
        audit("write", path=self.path.name, length=len(data))
        result = super().write(offset, data)
        if self.path.name == "fail-write.txt":
            self.transport.close()
        return result


class Files(paramiko.SFTPServerInterface):
    def __init__(self, server, *args, **kwargs):
        super().__init__(server, *args, **kwargs)
        self.transport = server.transport

    @staticmethod
    def local(path):
        path = (ROOT / path.lstrip("/")).resolve()
        if not path.is_relative_to(ROOT):
            raise OSError("outside fixture")
        return path

    def canonicalize(self, path):
        return posixpath.normpath("/" + path.lstrip("/"))

    def list_folder(self, path):
        audit("list-request", path=path)
        if posixpath.normpath(path) == "/stall-readdir":
            audit("stall-readdir")
            while self.transport.is_active():
                time.sleep(0.01)
            return paramiko.SFTP_FAILURE
        try:
            entries = []
            for child in self.local(path).iterdir():
                entry = paramiko.SFTPAttributes.from_stat(child.stat())
                entry.filename = child.name
                entries.append(entry)
            audit("list", path=path)
            return entries
        except OSError as error:
            return paramiko.SFTPServer.convert_errno(error.errno or 13)

    def stat(self, path):
        try:
            return paramiko.SFTPAttributes.from_stat(self.local(path).stat())
        except OSError as error:
            return paramiko.SFTPServer.convert_errno(error.errno or 13)

    lstat = stat

    def open(self, path, flags, attr):
        try:
            local = self.local(path)
            descriptor = os.open(local, flags | getattr(os, "O_BINARY", 0), attr.st_mode or 0o644)
            mode = "r+b" if flags & os.O_RDWR else "wb" if flags & os.O_WRONLY else "rb"
            stream = os.fdopen(descriptor, mode)
            handle = Handle(flags, local, self.transport)
            handle.readfile = stream
            if flags & (os.O_WRONLY | os.O_RDWR):
                handle.writefile = stream
            audit("open", path=path, flags=flags)
            return handle
        except OSError as error:
            return paramiko.SFTPServer.convert_errno(error.errno or 13)

    def mkdir(self, path, attr):
        try:
            self.local(path).mkdir(mode=attr.st_mode or 0o755)
            audit("mkdir", path=path)
            return paramiko.SFTP_OK
        except OSError as error:
            return paramiko.SFTPServer.convert_errno(error.errno or 13)

    def remove(self, path):
        try:
            self.local(path).unlink()
            audit("remove", path=path)
            return paramiko.SFTP_OK
        except OSError as error:
            return paramiko.SFTPServer.convert_errno(error.errno or 13)

    def rmdir(self, path):
        try:
            self.local(path).rmdir()
            audit("rmdir", path=path)
            return paramiko.SFTP_OK
        except OSError as error:
            return paramiko.SFTPServer.convert_errno(error.errno or 13)


KEY = paramiko.RSAKey.generate(2048)


def serve(client):
    transport = paramiko.Transport(client)
    try:
        audit("connect")
        transport.add_server_key(KEY)
        # No system moduli file is available in this isolated fixture. Advertise
        # fixed groups only, so libssh2 cannot select unsupported server GEX.
        transport.get_security_options().kex = ("ecdh-sha2-nistp256", "diffie-hellman-group14-sha256")
        transport.set_subsystem_handler("sftp", paramiko.SFTPServer, Files)
        transport.start_server(server=Server(transport))
        while transport.is_active():
            time.sleep(0.01)
    except Exception as error:
        audit("transport-error", message=str(error))
    finally:
        transport.close()
        client.close()
        audit("disconnect")


listener = socket.socket()
listener.bind(("127.0.0.1", 0))
listener.listen(16)
print(json.dumps({"port": listener.getsockname()[1]}), flush=True)
while True:
    client, peer = listener.accept()
    assert peer[0] == "127.0.0.1"
    threading.Thread(target=serve, args=(client,), daemon=True).start()
