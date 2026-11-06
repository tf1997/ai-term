/** Standalone content changes for a reviewed Bash draft. No app capabilities,
 * old approvals or restoration tickets are embedded in the generated script. */
export interface TaskScriptFileChange {
  id: string
  path: string
  action: 'create' | 'replace' | 'delete' | 'verify'
  before: string | null
  after: string | null
  externalContent: boolean
  mode: number
}

// JSON arguments preserve CRLF/BOM/final newlines without introducing literal
// CR into the Bash template. Sensitive payloads come from explicitly supplied
// files on the target instead of being copied into a shareable script.
export const TASK_SCRIPT_FILE_PROGRAM = String.raw`import json, os, stat, sys
action, path, input_kind, before_arg, after_arg, mode_arg = sys.argv[1:]
limit = 65536
def fail(message):
    raise SystemExit(message)
def read_file(fd):
    value = os.fstat(fd)
    if not stat.S_ISREG(value.st_mode) or value.st_size > limit:
        fail("Expected a regular file of at most 64 KiB")
    os.lseek(fd, 0, os.SEEK_SET)
    data = bytearray()
    while len(data) <= limit:
        chunk = os.read(fd, min(8192, limit + 1 - len(data)))
        if not chunk:
            break
        data.extend(chunk)
    if len(data) > limit:
        fail("File exceeded the read budget")
    end = os.fstat(fd)
    if (value.st_size, value.st_mtime_ns, value.st_ctime_ns) != (end.st_size, end.st_mtime_ns, end.st_ctime_ns):
        fail("File changed during reading")
    return bytes(data)
def payload(argument):
    if input_kind == "json":
        text = json.loads(argument)
        if not isinstance(text, str):
            fail("Expected text content")
        data = text.encode("utf-8")
    else:
        if not os.path.isabs(argument):
            fail("External content needs an absolute input file path")
        fd = os.open(argument, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
        try:
            data = read_file(fd)
        finally:
            os.close(fd)
        data.decode("utf-8")
    if len(data) > limit or b"\x00" in data:
        fail("Invalid or oversized UTF-8 file input")
    return data
if not os.path.isabs(path) or any(ord(c) < 32 or ord(c) == 127 for c in path):
    fail("An absolute file path is required")
if action not in ("create", "replace", "delete", "verify") or input_kind not in ("json", "file"):
    fail("Unsupported file operation")
before = payload(before_arg) if action != "create" else None
after = payload(after_arg) if action in ("create", "replace") else None
mode = int(mode_arg)
if mode < 0 or mode > 4095:
    fail("Invalid creation mode")
parent = os.path.realpath(os.path.dirname(path))
name = os.path.basename(path)
if name in ("", ".", ".."):
    fail("Invalid filename")
directory = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
fd = None
try:
    def current():
        if os.path.realpath(os.path.dirname(path)) != parent:
            fail("Parent directory changed")
        item = os.stat(name, dir_fd=directory, follow_symlinks=False)
        if not stat.S_ISREG(item.st_mode) or action != "verify" and item.st_nlink != 1:
            fail("Refusing symlink, special file or hard-linked file")
        return item
    try:
        initial = current()
    except FileNotFoundError:
        if action == "delete":
            print("Already absent")
            raise SystemExit(0)
        if action != "create":
            fail("Baseline file is missing")
        fd = os.open(name, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
        initial = os.fstat(fd)
    else:
        flags = os.O_RDONLY if action in ("delete", "verify") else os.O_RDWR
        fd = os.open(name, flags | os.O_NONBLOCK | os.O_NOFOLLOW, dir_fd=directory)
        opened = os.fstat(fd)
        if (opened.st_dev, opened.st_ino) != (initial.st_dev, initial.st_ino):
            fail("File changed before opening")
        actual = read_file(fd)
        if after is not None and actual == after:
            checked = current()
            if (checked.st_dev, checked.st_ino) != (initial.st_dev, initial.st_ino):
                fail("Path changed during verification")
            if action == "create" and stat.S_IMODE(checked.st_mode) != mode:
                fail("Existing file permissions differ from the requested creation mode")
            print("Already matches the requested content")
            raise SystemExit(0)
        if action == "create" or actual != before:
            fail("Current content differs from the recorded baseline; nothing written")
    checked = current()
    if (checked.st_dev, checked.st_ino) != (initial.st_dev, initial.st_ino):
        fail("File changed before writing")
    if action != "create" and read_file(fd) != before:
        fail("Baseline changed before writing")
    if action == "create" and read_file(fd) != b"":
        fail("Newly created file was changed by another writer")
    if action == "verify":
        print("Recorded file content verified")
    elif action == "delete":
        os.unlink(name, dir_fd=directory)
        try:
            current()
        except FileNotFoundError:
            print("Deletion verified")
        else:
            fail("Path reappeared after deletion; check current state")
    else:
        os.lseek(fd, 0, os.SEEK_SET)
        remaining = memoryview(after)
        while remaining:
            count = os.write(fd, remaining)
            if count <= 0:
                fail("Write was not completed; check current state before retrying")
            remaining = remaining[count:]
        os.ftruncate(fd, len(after))
        if action == "create":
            os.fchmod(fd, mode)
        os.fsync(fd)
        checked = current()
        if (checked.st_dev, checked.st_ino) != (initial.st_dev, initial.st_ino) or read_file(fd) != after:
            fail("Write verification failed; check current state before retrying")
        print("File content verified")
finally:
    if fd is not None:
        os.close(fd)
    os.close(directory)
`
