# Bounded metadata snapshots accompany approved text changes. SFTP providers
# without this capability must not advertise deletion as fully restorable.
def metadata_library():
    import ctypes
    lib = ctypes.CDLL(None, use_errno=True)
    lib.flistxattr.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_size_t, ctypes.c_int]
    lib.flistxattr.restype = ctypes.c_ssize_t
    lib.fgetxattr.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_void_p, ctypes.c_size_t, ctypes.c_uint32, ctypes.c_int]
    lib.fgetxattr.restype = ctypes.c_ssize_t
    lib.fsetxattr.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_void_p, ctypes.c_size_t, ctypes.c_uint32, ctypes.c_int]
    lib.fremovexattr.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int]
    lib.acl_get_fd.argtypes = [ctypes.c_int]
    lib.acl_get_fd.restype = ctypes.c_void_p
    lib.acl_to_text.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ssize_t)]
    lib.acl_to_text.restype = ctypes.c_void_p
    lib.acl_from_text.argtypes = [ctypes.c_char_p]
    lib.acl_from_text.restype = ctypes.c_void_p
    lib.acl_set_fd.argtypes = [ctypes.c_int, ctypes.c_void_p]
    lib.acl_delete_fd_np.argtypes = [ctypes.c_int, ctypes.c_int]
    lib.acl_free.argtypes = [ctypes.c_void_p]
    return lib


def capture_metadata(fd):
    try:
        acl, attributes, total = None, {}, 0
        if sys.platform.startswith('linux'):
            for name in os.listxattr(fd):
                data = os.getxattr(fd, name)
                total += len(name.encode()) + len(data)
                if total > MAX_BYTES:
                    return None
                attributes[name] = base64.b64encode(data).decode('ascii')
            return dict(platform='linux', xattrs=attributes, acl=None)
        if sys.platform != 'darwin':
            return None
        import ctypes
        lib = metadata_library()
        count = lib.flistxattr(fd, None, 0, 0)
        if not 0 <= count <= MAX_BYTES:
            return None
        names = ctypes.create_string_buffer(count)
        if lib.flistxattr(fd, names, count, 0) != count:
            return None
        total += count
        for name in filter(None, names.raw.split(b'\0')):
            length = lib.fgetxattr(fd, name, None, 0, 0, 0)
            if not 0 <= length <= MAX_BYTES - total:
                return None
            total += length
            data = ctypes.create_string_buffer(length)
            if lib.fgetxattr(fd, name, data, length, 0, 0) != length:
                return None
            attributes[name.decode('utf-8')] = base64.b64encode(data.raw).decode('ascii')
        handle = lib.acl_get_fd(fd)
        if handle:
            pointer = None
            try:
                length = ctypes.c_ssize_t()
                pointer = lib.acl_to_text(handle, ctypes.byref(length))
                if not pointer or not 0 <= length.value <= MAX_BYTES - total:
                    return None
                acl = ctypes.string_at(pointer, length.value).rstrip(b'\0').decode('utf-8')
            finally:
                if pointer:
                    lib.acl_free(pointer)
                lib.acl_free(handle)
        elif ctypes.get_errno() != errno.ENOENT:
            return None
        return dict(platform='darwin', xattrs=attributes, acl=acl)
    except (OSError, UnicodeError):
        return None


def restore_metadata(fd, backup):
    current = capture_metadata(fd)
    if current is None or current['platform'] != backup['platform']:
        fail('unavailable', 'Cannot restore the recorded extended metadata on this provider')
    desired = backup['xattrs']
    if sys.platform.startswith('linux'):
        for name in current['xattrs']:
            if name not in desired:
                os.removexattr(fd, name)
        for name, encoded in desired.items():
            if current['xattrs'].get(name) != encoded:
                os.setxattr(fd, name, base64.b64decode(encoded, validate=True))
    else:
        import ctypes
        lib = metadata_library()
        for name in current['xattrs']:
            if name not in desired and lib.fremovexattr(fd, name.encode('utf-8'), 0):
                raise OSError(ctypes.get_errno(), 'Cannot remove inherited extended metadata')
        for name, encoded in desired.items():
            if current['xattrs'].get(name) != encoded:
                data = base64.b64decode(encoded, validate=True)
                if lib.fsetxattr(fd, name.encode('utf-8'), data, len(data), 0, 0):
                    raise OSError(ctypes.get_errno(), 'Cannot restore extended metadata')
        if current['acl'] != backup['acl']:
            if backup['acl'] is None:
                if lib.acl_delete_fd_np(fd, 0x100):
                    raise OSError(ctypes.get_errno(), 'Cannot remove inherited ACL')
            else:
                acl = lib.acl_from_text(backup['acl'].encode('utf-8'))
                if not acl:
                    fail('unavailable', 'Cannot decode the recorded ACL')
                try:
                    if lib.acl_set_fd(fd, acl):
                        raise OSError(ctypes.get_errno(), 'Cannot restore the recorded ACL')
                finally:
                    lib.acl_free(acl)
    if capture_metadata(fd) != backup:
        fail('unavailable', 'Extended metadata did not match its backup after restoration')


def edit_attributes(meta, fd):
    backup = capture_metadata(fd)
    return dict(mode=stat.S_IMODE(meta.st_mode), uid=meta.st_uid, gid=meta.st_gid,
                extendedMetadata=None if backup is None else bool(backup['xattrs'] or backup['acl']), metadataBackup=backup)
