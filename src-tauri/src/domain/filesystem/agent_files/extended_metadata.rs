use super::FileExtendedMetadata;
#[cfg(unix)]
use super::MAX_FILE_BYTES;

/// A bounded snapshot is optional. Unknown/oversized metadata never becomes a
/// claim that a deleted file can be recreated with its original permissions.
#[cfg(unix)]
pub(super) fn capture(file: &std::fs::File) -> Option<FileExtendedMetadata> {
    use base64::Engine;
    use std::collections::BTreeMap;
    use std::os::fd::AsRawFd;
    let fd = file.as_raw_fd();
    #[cfg(target_os = "macos")]
    let list = |buffer: *mut libc::c_char, size| unsafe { libc::flistxattr(fd, buffer, size, 0) };
    #[cfg(target_os = "linux")]
    let list = |buffer: *mut libc::c_char, size| unsafe { libc::flistxattr(fd, buffer, size) };
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        let count = list(std::ptr::null_mut(), 0);
        if count < 0 || count as usize > MAX_FILE_BYTES {
            return None;
        }
        let mut names = vec![0u8; count as usize];
        if list(names.as_mut_ptr().cast(), names.len()) != count {
            return None;
        }
        let mut total = names.len();
        let mut xattrs = BTreeMap::new();
        for name in names
            .split(|byte| *byte == 0)
            .filter(|name| !name.is_empty())
        {
            let text = std::str::from_utf8(name).ok()?;
            let name = std::ffi::CString::new(name).ok()?;
            #[cfg(target_os = "macos")]
            let get = |buffer: *mut libc::c_void, size| unsafe {
                libc::fgetxattr(fd, name.as_ptr(), buffer, size, 0, 0)
            };
            #[cfg(target_os = "linux")]
            let get = |buffer: *mut libc::c_void, size| unsafe {
                libc::fgetxattr(fd, name.as_ptr(), buffer, size)
            };
            let count = get(std::ptr::null_mut(), 0);
            if count < 0 || count as usize > MAX_FILE_BYTES - total {
                return None;
            }
            total += count as usize;
            let mut value = vec![0u8; count as usize];
            if get(value.as_mut_ptr().cast(), value.len()) != count {
                return None;
            }
            xattrs.insert(
                text.to_owned(),
                base64::engine::general_purpose::STANDARD.encode(value),
            );
        }
        #[cfg(target_os = "linux")]
        let (platform, acl) = ("linux", None);
        #[cfg(target_os = "macos")]
        let (platform, acl) = ("darwin", mac_acl(fd, MAX_FILE_BYTES - total)?);
        return Some(FileExtendedMetadata {
            platform: platform.into(),
            xattrs,
            acl,
        });
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = fd;
        None
    }
}
#[cfg(not(unix))]
pub(super) fn capture(_: &std::fs::File) -> Option<FileExtendedMetadata> {
    None
}

#[cfg(target_os = "macos")]
fn mac_acl(fd: libc::c_int, budget: usize) -> Option<Option<String>> {
    unsafe {
        extern "C" {
            fn acl_get_fd(fd: libc::c_int) -> *mut libc::c_void;
            fn acl_to_text(acl: *mut libc::c_void, length: *mut libc::ssize_t)
                -> *mut libc::c_char;
            fn acl_free(acl: *mut libc::c_void) -> libc::c_int;
        }
        let acl = acl_get_fd(fd);
        if acl.is_null() {
            return if std::io::Error::last_os_error().raw_os_error() == Some(libc::ENOENT) {
                Some(None)
            } else {
                None
            };
        }
        let mut length = 0;
        let pointer = acl_to_text(acl, &mut length);
        let value = if pointer.is_null() || length < 0 || length as usize > budget {
            None
        } else {
            std::str::from_utf8(std::slice::from_raw_parts(pointer.cast(), length as usize))
                .ok()
                .map(|value| Some(value.trim_end_matches('\0').to_owned()))
        };
        if !pointer.is_null() {
            acl_free(pointer.cast());
        }
        acl_free(acl);
        value
    }
}
