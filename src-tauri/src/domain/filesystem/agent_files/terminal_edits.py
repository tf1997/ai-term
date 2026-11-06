# Loaded after the read-only helpers with their main disabled. This program is
# generated only from a consumed write approval; there is no caller shell code.
import uuid


def edit_copy_attributes(source, destination):
    if sys.platform == 'darwin':
        import ctypes
        library = ctypes.CDLL(None, use_errno=True)
        library.fcopyfile.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
        if library.fcopyfile(source, destination, None, 5):  # COPYFILE_ACL | COPYFILE_XATTR
            raise OSError(ctypes.get_errno(), 'Cannot preserve ACLs and extended attributes')
    elif sys.platform.startswith('linux'):
        total = 0
        for name in os.listxattr(source):
            value = os.getxattr(source, name)
            total += len(name.encode()) + len(value)
            if total > MAX_BYTES:
                fail('scan-limit', 'Extended attributes exceed the copy budget')
            os.setxattr(destination, name, value)
    else:
        fail('unavailable', 'Cannot preserve file permissions on this platform')


def edit_file(request, progress):
    path, resolved = request['path'], request['resolvedPath']
    path_check(path)
    path_check(resolved)
    if request['after'] is not None and (len(request['after'].encode('utf-8')) > MAX_BYTES or '\0' in request['after']):
        fail('invalid-request', 'Only bounded UTF-8 text is supported')
    parent, name = os.path.split(resolved)
    directory = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    original = temporary = None
    temp_name = None

    def check_environment_and_path():
        if environment()[1] != request['scope']:
            fail('target-changed', 'The current file environment has changed')
        if os.path.realpath(path) != resolved:
            fail('version-changed', 'The resolved path changed since approval')
        opened_path(directory, parent)
        current_parent = os.stat(parent)
        bound_parent = os.fstat(directory)
        if (current_parent.st_dev, current_parent.st_ino) != (bound_parent.st_dev, bound_parent.st_ino):
            fail('version-changed', 'The parent directory changed since approval')

    def check_before():
        check_environment_and_path()
        if request['beforeHash'] is None:
            try:
                os.stat(name, dir_fd=directory, follow_symlinks=False)
            except FileNotFoundError:
                return None, None
            fail('version-changed', 'The previously missing path now exists')
        fd = os.open(name, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW, dir_fd=directory)
        try:
            opened_path(fd, resolved)
            meta = os.fstat(fd)
            if not stat.S_ISREG(meta.st_mode) or version(meta) != request['revision'] or meta.st_nlink != 1:
                fail('version-changed', 'The file version, type or hard links changed')
            data = bytearray()
            while len(data) <= MAX_BYTES:
                chunk = os.read(fd, min(8192, MAX_BYTES + 1 - len(data)))
                if not chunk:
                    break
                data.extend(chunk)
            if len(data) > MAX_BYTES or hashlib.sha256(data).hexdigest() != request['beforeHash'] or version(meta) != version(os.fstat(fd)):
                fail('version-changed', 'File content changed since the complete read')
            return fd, edit_attributes(meta, fd)
        except BaseException:
            os.close(fd)
            raise

    try:
        original, before_attributes = check_before()
        wanted = request['restoreAttributes'] or before_attributes or dict(mode=0o600, uid=os.geteuid(), gid=os.getegid(), extendedMetadata=None, metadataBackup=None)
        if request['after'] is not None:
            temp_name = '.ai-term-' + uuid.uuid4().hex + '.tmp'
            temporary = os.open(temp_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
            data = request['after'].encode('utf-8')
            offset = 0
            while offset < len(data):
                offset += os.write(temporary, data[offset:])
            if original is not None:
                edit_copy_attributes(original, temporary)
            actual = os.fstat(temporary)
            if (actual.st_uid, actual.st_gid) != (wanted['uid'], wanted['gid']):
                os.fchown(temporary, wanted['uid'], wanted['gid'])
            os.fchmod(temporary, wanted['mode'])
            if request['restoreAttributes']:
                backup = wanted.get('metadataBackup')
                if backup is None and wanted.get('extendedMetadata') is False:
                    backup = dict(platform='darwin' if sys.platform == 'darwin' else 'linux', xattrs={}, acl=None)
                if backup is not None:
                    restore_metadata(temporary, backup)
            actual = edit_attributes(os.fstat(temporary), temporary)
            if wanted.get('metadataBackup') is None:
                wanted['metadataBackup'] = actual['metadataBackup']
                wanted['extendedMetadata'] = actual['extendedMetadata']
            if actual != wanted:
                fail('unavailable', 'Cannot preserve the recorded permissions and extended metadata')
            os.fsync(temporary)
        checked, _ = check_before()
        if checked is not None:
            os.close(checked)
        progress['started'] = True
        if request['after'] is None:
            os.unlink(name, dir_fd=directory)
        elif request['beforeHash'] is None:
            # link is no-clobber: a concurrently created destination is never
            # replaced. The cleanup only removes our own temporary name.
            os.link(temp_name, name, src_dir_fd=directory, dst_dir_fd=directory, follow_symlinks=False)
        else:
            os.replace(temp_name, name, src_dir_fd=directory, dst_dir_fd=directory)
            temp_name = None
        if temp_name is not None:
            os.unlink(temp_name, dir_fd=directory)
            temp_name = None
        os.fsync(directory)
        check_environment_and_path()
        revision = content_hash = after_attributes = None
        if request['after'] is None:
            try:
                os.stat(name, dir_fd=directory, follow_symlinks=False)
            except FileNotFoundError:
                pass
            else:
                fail('version-changed', 'Deletion could not be verified')
        else:
            fd = os.open(name, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW, dir_fd=directory)
            try:
                opened_path(fd, resolved)
                meta = os.fstat(fd)
                if not stat.S_ISREG(meta.st_mode):
                    fail('version-changed', 'The written path is no longer a regular file')
                with os.fdopen(os.dup(fd), 'rb') as stream:
                    actual = stream.read(MAX_BYTES + 1)
                after_attributes = edit_attributes(meta, fd)
                if actual != request['after'].encode('utf-8') or after_attributes != wanted or version(meta) != version(os.fstat(fd)):
                    fail('version-changed', 'The written file did not pass read-back verification')
                revision, content_hash = version(meta), hashlib.sha256(actual).hexdigest()
            finally:
                os.close(fd)
        check_environment_and_path()
        return dict(status='applied', revision=revision, contentHash=content_hash, beforeAttributes=before_attributes, afterAttributes=after_attributes, error=None)
    finally:
        if original is not None:
            os.close(original)
        if temporary is not None:
            os.close(temporary)
        if temp_name is not None:
            try:
                os.unlink(temp_name, dir_fd=directory)
            except OSError:
                pass
        os.close(directory)


def edit_main():
    request = json.loads(base64.b64decode(''.join(sys.argv[1:]), validate=True))
    request['after'] = None if request['afterBase64'] is None else base64.b64decode(request['afterBase64'], validate=True).decode('utf-8')
    progress = dict(started=False)
    try:
        result = edit_file(request, progress)
    except (FileFailure, OSError, UnicodeError) as error:
        if isinstance(error, FileFailure):
            kind, message = error.kind, error.message
        elif isinstance(error, UnicodeError):
            kind, message = 'unsupported-encoding', 'The file is not valid UTF-8'
        else:
            kind = {errno.ENOENT: 'missing', errno.EACCES: 'permission-denied', errno.EPERM: 'permission-denied', errno.ELOOP: 'version-changed', errno.EEXIST: 'version-changed'}.get(error.errno, 'transport')
            message = str(error)
        status = 'unknown' if progress['started'] else 'conflict' if kind in ['version-changed', 'target-changed', 'missing'] else 'failed'
        result = dict(status=status, revision=None, contentHash=None, beforeAttributes=None, afterAttributes=None, error=dict(kind=kind, message=message))
    payload = base64.b64encode(json.dumps(dict(ok=True, value=result), ensure_ascii=False, separators=(',', ':')).encode('utf-8')).decode('ascii')
    print('AI_TERM_FILE_' + request['nonce'] + '_' + payload)


edit_main()
