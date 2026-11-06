# Application-owned, read-only helper. No remote installation or model source.
import base64
import errno
import hashlib
import json
import os
import stat
import sys

MAX_BYTES = 65536
MAX_SCAN = 1048576
MAX_ENTRIES = 10000
MAX_MOUNTINFO = 262144


class FileFailure(Exception):
    def __init__(self, kind, message, absence=None):
        self.kind, self.message = kind, message
        self.absence = absence


def fail(kind, message):
    raise FileFailure(kind, message)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def bounded(path, limit):
    with open(path, 'rb', buffering=0) as stream:
        data = stream.read(limit + 1)
    if len(data) > limit:
        fail('unavailable', 'File environment evidence exceeded budget')
    return data.decode('utf-8').strip('\0\r\n')


def linux_root_mount(mountinfo):
    if len(mountinfo.encode('utf-8')) > MAX_MOUNTINFO:
        fail('unavailable', 'Root mount evidence exceeded budget')
    root = None
    for line in mountinfo.splitlines():
        fields = line.split()
        if len(fields) < 5 or fields[4] != '/':
            continue
        separator = fields.index('-') if '-' in fields else -1
        device = fields[2].split(':')
        valid = separator >= 6 and len(fields) == separator + 4 and fields[0].isascii() and fields[0].isdigit() and 0 < int(fields[0]) <= 2**64 - 1 and fields[1].isascii() and fields[1].isdigit() and int(fields[1]) <= 2**64 - 1 and len(device) == 2 and all(value.isascii() and value.isdigit() for value in device) and fields[3].startswith('/')
        if not valid or root is not None:
            fail('unavailable', 'Cannot establish a unique process root mount')
        root = hashlib.sha256(' '.join(fields).encode('utf-8')).hexdigest()
    if root is None:
        fail('unavailable', 'Current process root is not a visible mountpoint')
    return root


def environment():
    root_stat = os.stat('/')
    identity = [sys.platform, root_stat.st_dev, root_stat.st_ino, os.getuid(), os.geteuid(), os.getgid(), os.getegid(), sorted(set(os.getgroups()))]
    proof = None
    if sys.platform.startswith('linux'):
        try:
            status = bounded('/proc/self/status', 16384)
            fields = dict(line.split(':', 1) for line in status.splitlines() if ':' in line)
            credentials = ';'.join(key + ':' + ' '.join(fields[key].split()) for key in ['Uid', 'Gid', 'Groups', 'CapEff', 'NoNewPrivs', 'Seccomp'])
            proof = dict(platform='linux', boot=bounded('/proc/sys/kernel/random/boot_id', 64), mount=os.readlink('/proc/self/ns/mnt'), root=os.readlink('/proc/self/root'), credentials=credentials, security=bounded('/proc/self/attr/current', 4096))
            # Keep the existing terminal identity stable for saved file-change
            # records. It already includes the root device/inode; the extra
            # mount proof governs only native/SFTP provider equivalence.
            identity.append(proof.copy())
            if fields['Seccomp'].strip() != '0':
                proof = None
            else:
                try:
                    proof['root_mount'] = linux_root_mount(bounded('/proc/self/mountinfo', MAX_MOUNTINFO))
                except (OSError, ValueError, UnicodeError, FileFailure):
                    proof = None
        except (OSError, ValueError, KeyError, UnicodeError, FileFailure):
            # Native mapping is unavailable; terminal operations still bind to
            # the observed root, uid/groups and any available namespace evidence.
            for path in ['/proc/self/ns/mnt', '/proc/self/root']:
                try:
                    identity.append(os.readlink(path))
                except OSError:
                    identity.append(None)
    elif sys.platform == 'darwin':
        proof = dict(platform='darwin', device=root_stat.st_dev, inode=root_stat.st_ino, uid=os.geteuid(), gid=os.getegid(), groups=sorted(set(os.getgroups())))
    return proof, digest(identity)


def path_check(path):
    if not isinstance(path, str) or not path.startswith('/') or len(path.encode('utf-8')) > 4096 or any(ord(c) < 32 or 127 <= ord(c) <= 159 for c in path) or any(p in ['.', '..'] for p in path.split('/')):
        fail('invalid-request', 'An absolute path without traversal or control characters is required')


def sensitive(path):
    parts = path.replace('\\', '/').lower().split('/')
    base = parts[-1]
    return any(p in ['.ssh', '.aws', '.kube', '.docker', 'keychains', '.env'] or p.startswith(('.env.', 'shadow', 'gshadow', 'sudoers')) for p in parts) or base.endswith(('.pem', '.key', '.p12', '.pfx', '.jks', '.keychain-db')) or base in ['.netrc', '.npmrc', '.pypirc', 'login data', 'logins.json', 'cookies']


def kind(meta):
    return 'file' if stat.S_ISREG(meta.st_mode) else 'directory' if stat.S_ISDIR(meta.st_mode) else 'symlink' if stat.S_ISLNK(meta.st_mode) else 'other'


def metadata(meta):
    return dict(kind=kind(meta), size=meta.st_size, modifiedNs=meta.st_mtime_ns, identity='{}:{}:{}:{}'.format(meta.st_dev, meta.st_ino, meta.st_uid, meta.st_gid))


def version(meta):
    # This is a metadata hint, not an atomic snapshot or a content hash.
    return 'terminal-metadata:' + digest([meta.st_dev, meta.st_ino, meta.st_uid, meta.st_gid, meta.st_mode, meta.st_size, meta.st_mtime_ns, meta.st_ctime_ns])


def inspect(path):
    path_check(path)
    resolved = os.path.realpath(path)
    path_check(resolved)
    proof, scope = environment()
    try:
        meta = os.stat(resolved)
    except FileNotFoundError:
        parent = os.path.dirname(resolved)
        while True:
            try:
                parent_meta = os.stat(parent)
                if not stat.S_ISDIR(parent_meta.st_mode):
                    fail('not-directory', 'A path ancestor is not a directory')
                if not os.access(parent, os.X_OK, effective_ids=True):
                    fail('permission-denied', 'Cannot establish file absence in this directory')
                break
            except FileNotFoundError:
                if parent == '/':
                    raise
                parent = os.path.dirname(parent)
        raise FileFailure('missing', 'The file does not exist in the current terminal environment', dict(path=path, resolvedPath=resolved, environmentScope=scope))
    return dict(path=path, resolvedPath=resolved, metadata=metadata(meta), revision=version(meta), environment=proof, scope=scope)


def opened_path(fd, resolved):
    if sys.platform.startswith('linux'):
        actual = os.readlink('/proc/self/fd/' + str(fd))
    elif sys.platform == 'darwin':
        import fcntl
        actual = fcntl.fcntl(fd, 50, bytes(1024)).split(b'\0', 1)[0].decode('utf-8')  # F_GETPATH
    else:
        fail('unavailable', 'Cannot verify the opened file path on this platform')
    path_check(actual)
    if actual != resolved:
        fail('version-changed', 'The resolved file path changed while opening it')


def read_page(stream, size, options, resume):
    start_line = options.get('startLine', 1)
    max_lines = options.get('maxLines', 200)
    max_bytes = options.get('maxBytes', MAX_BYTES)
    tail = options.get('tail', False)
    if type(start_line) is not int or start_line < 1 or type(max_lines) is not int or not 1 <= max_lines <= MAX_BYTES or type(max_bytes) is not int or not 4 <= max_bytes <= MAX_BYTES or type(tail) is not bool or tail and (start_line != 1 or resume):
        fail('invalid-request', 'Invalid read range')
    if tail:
        window = max(0, size - max_bytes)
        read_start = max(0, window - 1)
        stream.seek(read_start)
        data = stream.read(size - read_start)
        if b'\0' in data:
            fail('binary', 'File contains binary bytes')
        begin = window - read_start
        if begin > len(data):
            fail('version-changed', 'File shortened while reading its tail')
        if begin:
            while begin < len(data) and data[begin] & 0xc0 == 0x80:
                begin += 1
        lines = 0
        limited = False
        for index in range(len(data) - 1, begin - 1, -1):
            if data[index] == 10 and index + 1 < len(data):
                lines += 1
                if lines >= max_lines:
                    begin, limited = index + 1, True
                    break
        content = data[begin:].decode('utf-8')
        start_byte, end_byte = read_start + begin, read_start + len(data)
        complete = start_byte == 0 and end_byte == size
        return dict(content=content, start=dict(byte=start_byte, line=1 if start_byte == 0 else None, midLine=begin > 0 and data[begin-1] != 10), end=dict(byte=end_byte, line=None, midLine=bool(data) and data[-1] != 10), eof=end_byte == size, complete=complete, truncation=None if complete else 'lines' if limited else 'tail-window', scannedBytes=len(data))
    position = dict(resume or dict(byte=0, line=1, midLine=False))
    if type(position['byte']) is not int or position['byte'] < 0 or position['byte'] > size or resume and start_line != 1:
        fail('invalid-request', 'Invalid page position')
    stream.seek(position['byte'])
    start = dict(position)
    selecting = bool(resume) or start_line == 1
    selected = bytearray()
    scanned = read_bytes = lines = 0
    truncation = None
    eof = False
    while scanned < MAX_SCAN and not truncation:
        chunk = stream.read(min(8192, MAX_SCAN + 1 - read_bytes))
        read_bytes += len(chunk)
        if not chunk:
            eof = True
            break
        for byte in chunk[:MAX_SCAN - scanned]:
            scanned += 1
            if byte == 0:
                fail('binary', 'File contains binary bytes')
            position['byte'] += 1
            position['midLine'] = byte != 10
            if byte == 10 and position['line'] is not None:
                position['line'] += 1
            if not selecting:
                start = dict(position)
                selecting = position['line'] is not None and position['line'] >= start_line
                continue
            selected.append(byte)
            if byte == 10:
                lines += 1
            if lines >= max_lines:
                truncation = 'lines'
                break
            if len(selected) >= max_bytes:
                truncation = 'bytes'
                break
        if truncation or scanned == MAX_SCAN:
            # The unread part of this chunk already proves continuation.
            if position['byte'] < stream.tell():
                eof = False
            else:
                extra = stream.read(1)
                read_bytes += len(extra)
                eof = not extra
            break
    if not eof and truncation is None:
        truncation = 'scan-budget'
    try:
        content = selected.decode('utf-8')
    except UnicodeDecodeError as error:
        if not eof and error.reason == 'unexpected end of data':
            position['byte'] -= len(selected) - error.start
            content = selected[:error.start].decode('utf-8')
        else:
            raise
    return dict(content=content, start=start, end=position, eof=eof, complete=eof and start['byte'] == 0, truncation=None if eof else truncation, scannedBytes=read_bytes)


def list_page(fd, offset, limit):
    if type(offset) is not int or not 0 <= offset < MAX_ENTRIES or type(limit) is not int or not 1 <= limit <= 500:
        fail('invalid-request', 'Invalid directory range')
    entries, scanned, byte_count, next_offset, truncation = [], 0, 2, None, None
    prefix = hashlib.sha256(b'ai-term-directory-v1')
    start_fingerprint = prefix.hexdigest() if offset == 0 else None
    with os.scandir(fd) as iterator:
        for entry in iterator:
            if scanned >= MAX_ENTRIES:
                truncation = 'scan-budget'
                break
            index = scanned
            scanned += 1
            name = entry.name
            if len(name.encode('utf-8')) > 4096 or any(ord(c) < 32 or 127 <= ord(c) <= 159 for c in name):
                fail('unsupported-encoding', 'Directory contains an unsupported filename')
            meta = entry.stat(follow_symlinks=False)
            value = dict(name=name, kind=kind(meta), size=meta.st_size)
            encoded = json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode()
            if index >= offset:
                if len(entries) == limit:
                    next_offset, truncation = index, 'lines'
                    break
                size = len(encoded) + (1 if entries else 0)
                if byte_count + size > MAX_BYTES:
                    next_offset, truncation = index, 'bytes'
                    break
                entries.append(value)
                byte_count += size
            prefix.update(len(encoded).to_bytes(8, 'little'))
            prefix.update(encoded)
            if scanned == offset:
                start_fingerprint = prefix.hexdigest()
    if scanned == MAX_ENTRIES and next_offset is None:
        truncation = 'scan-budget'
    if start_fingerprint is None:
        fail('version-changed', 'Directory no longer contains the requested page position')
    return dict(entries=entries, nextOffset=next_offset, scannedEntries=scanned, truncation=truncation, startFingerprint=start_fingerprint, endFingerprint=prefix.hexdigest())


def operate(request):
    path = request['path']
    before = inspect(path)
    if request['action'] == 'inspect':
        return before
    if request.get('scope') != before['scope']:
        fail('target-changed', 'The terminal filesystem or access identity changed')
    if request.get('resolvedPath') != before['resolvedPath'] or request.get('revision') != before['revision']:
        fail('version-changed', 'The file changed after inspection; inspect again')
    if sensitive(path) or sensitive(before['resolvedPath']):
        if request.get('approvedPaths') != [path, before['resolvedPath']]:
            fail('sensitive-path', 'This path needs an individually reviewed read')
    resolved = before['resolvedPath']
    flags = os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW
    if request['action'] == 'list':
        flags |= os.O_DIRECTORY
    elif before['metadata']['kind'] != 'file':
        fail('not-regular-file', 'The path is not a regular file')
    fd = os.open(resolved, flags)
    try:
        opened_path(fd, resolved)
        meta = os.fstat(fd)
        if version(meta) != before['revision'] or os.path.realpath(path) != resolved:
            fail('version-changed', 'The file changed while opening it')
        if request['action'] == 'read':
            with os.fdopen(os.dup(fd), 'rb', buffering=0) as stream:
                page = read_page(stream, meta.st_size, request.get('options', {}), request.get('resume'))
            result = dict(path=path, resolvedPath=resolved, metadata=metadata(meta), revision=before['revision'], **page)
        elif request['action'] == 'list':
            result = dict(path=path, resolvedPath=resolved, revision=before['revision'], **list_page(fd, request.get('offset', 0), request.get('limit', 100)))
        else:
            fail('invalid-request', 'Unknown file operation')
        result['changedDuringRead'] = version(os.fstat(fd)) != before['revision']
        if environment()[1] != before['scope']:
            fail('target-changed', 'The file environment changed during the operation')
        return result
    finally:
        os.close(fd)


def main():
    request = json.loads(base64.b64decode(sys.argv[1], validate=True))
    try:
        result = dict(ok=True, value=operate(request))
    except FileFailure as error:
        result = dict(ok=False, error=dict(kind=error.kind, message=error.message))
        if error.absence:
            result['error']['absence'] = error.absence
    except UnicodeError:
        result = dict(ok=False, error=dict(kind='unsupported-encoding', message='File or path is not valid UTF-8'))
    except OSError as error:
        kind = {errno.ENOENT: 'missing', errno.EACCES: 'permission-denied', errno.EPERM: 'permission-denied', errno.ENOTDIR: 'not-directory', errno.ELOOP: 'version-changed'}.get(error.errno, 'transport')
        result = dict(ok=False, error=dict(kind=kind, message=str(error)))
    payload = base64.b64encode(json.dumps(result, ensure_ascii=False, separators=(',', ':')).encode('utf-8')).decode('ascii')
    print('AI_TERM_FILE_' + request['nonce'] + '_' + payload)


if __name__ == '__main__':
    main()
