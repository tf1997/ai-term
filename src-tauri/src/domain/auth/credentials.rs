use anyhow::{bail, Result};

pub trait CredentialStore: Send + Sync {
    fn set_secret(&self, key: &str, value: &str) -> Result<()>;
    fn get_secret(&self, key: &str) -> Result<Option<String>>;
    fn delete_secret(&self, key: &str) -> Result<()>;
}

#[derive(Debug, Default)]
pub struct MemoryCredentialStore {
    values: std::sync::Mutex<std::collections::HashMap<String, String>>,
}

impl CredentialStore for MemoryCredentialStore {
    fn set_secret(&self, key: &str, value: &str) -> Result<()> {
        self.values
            .lock()
            .expect("credential store lock poisoned")
            .insert(key.to_string(), value.to_string());
        Ok(())
    }

    fn get_secret(&self, key: &str) -> Result<Option<String>> {
        Ok(self
            .values
            .lock()
            .expect("credential store lock poisoned")
            .get(key)
            .cloned())
    }

    fn delete_secret(&self, key: &str) -> Result<()> {
        self.values
            .lock()
            .expect("credential store lock poisoned")
            .remove(key);
        Ok(())
    }
}

#[derive(Debug, Default, Clone, Copy)]
pub struct SystemCredentialStore;

impl SystemCredentialStore {
    pub fn new() -> Self {
        Self
    }
}

impl CredentialStore for SystemCredentialStore {
    fn set_secret(&self, key: &str, value: &str) -> Result<()> {
        platform_set_secret(key, value)
    }

    fn get_secret(&self, key: &str) -> Result<Option<String>> {
        platform_get_secret(key)
    }

    fn delete_secret(&self, key: &str) -> Result<()> {
        platform_delete_secret(key)
    }
}

const SERVICE_NAME: &str = "ai-term";

fn validate_key(key: &str) -> Result<&str> {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        bail!("credential key is empty");
    }
    if trimmed.contains('\0') {
        bail!("credential key contains NUL byte");
    }
    Ok(trimmed)
}

#[cfg(windows)]
mod platform {
    use super::{validate_key, SERVICE_NAME};
    use anyhow::{anyhow, Context, Result};
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;
    use std::ptr;

    const CRED_TYPE_GENERIC: u32 = 1;
    const CRED_PERSIST_LOCAL_MACHINE: u32 = 2;
    const ERROR_NOT_FOUND: i32 = 1168;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct FileTime {
        dw_low_date_time: u32,
        dw_high_date_time: u32,
    }

    #[repr(C)]
    struct CredentialAttributeW {
        keyword: *mut u16,
        flags: u32,
        value_size: u32,
        value: *mut u8,
    }

    #[repr(C)]
    struct CredentialW {
        flags: u32,
        credential_type: u32,
        target_name: *mut u16,
        comment: *mut u16,
        last_written: FileTime,
        credential_blob_size: u32,
        credential_blob: *mut u8,
        persist: u32,
        attribute_count: u32,
        attributes: *mut CredentialAttributeW,
        target_alias: *mut u16,
        user_name: *mut u16,
    }

    #[link(name = "Advapi32")]
    extern "system" {
        fn CredWriteW(credential: *const CredentialW, flags: u32) -> i32;
        fn CredReadW(
            target_name: *const u16,
            credential_type: u32,
            flags: u32,
            credential: *mut *mut CredentialW,
        ) -> i32;
        fn CredDeleteW(target_name: *const u16, credential_type: u32, flags: u32) -> i32;
        fn CredFree(buffer: *mut c_void);
    }

    pub fn platform_set_secret(key: &str, value: &str) -> Result<()> {
        let key = validate_key(key)?;
        let mut target_name = wide_null(&credential_target(key));
        let mut user_name = wide_null(SERVICE_NAME);
        let mut blob = value.as_bytes().to_vec();
        let credential_blob_size = u32::try_from(blob.len())
            .context("credential secret is too large for Windows Credential Manager")?;
        let credential = CredentialW {
            flags: 0,
            credential_type: CRED_TYPE_GENERIC,
            target_name: target_name.as_mut_ptr(),
            comment: ptr::null_mut(),
            last_written: FileTime {
                dw_low_date_time: 0,
                dw_high_date_time: 0,
            },
            credential_blob_size,
            credential_blob: blob.as_mut_ptr(),
            persist: CRED_PERSIST_LOCAL_MACHINE,
            attribute_count: 0,
            attributes: ptr::null_mut(),
            target_alias: ptr::null_mut(),
            user_name: user_name.as_mut_ptr(),
        };

        let ok = unsafe { CredWriteW(&credential, 0) };
        if ok == 0 {
            return Err(std::io::Error::last_os_error())
                .context("failed to write Windows Credential Manager secret");
        }
        Ok(())
    }

    pub fn platform_get_secret(key: &str) -> Result<Option<String>> {
        let key = validate_key(key)?;
        let target_name = wide_null(&credential_target(key));
        let mut credential: *mut CredentialW = ptr::null_mut();
        let ok = unsafe { CredReadW(target_name.as_ptr(), CRED_TYPE_GENERIC, 0, &mut credential) };
        if ok == 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() == Some(ERROR_NOT_FOUND) {
                return Ok(None);
            }
            return Err(error).context("failed to read Windows Credential Manager secret");
        }
        if credential.is_null() {
            return Ok(None);
        }

        let result = unsafe {
            let size = (*credential).credential_blob_size as usize;
            let ptr = (*credential).credential_blob;
            if ptr.is_null() || size == 0 {
                Ok(Some(String::new()))
            } else {
                let bytes = std::slice::from_raw_parts(ptr, size);
                String::from_utf8(bytes.to_vec())
                    .map(Some)
                    .map_err(|error| anyhow!("stored Windows credential is not UTF-8: {error}"))
            }
        };
        unsafe { CredFree(credential as *mut c_void) };
        result
    }

    pub fn platform_delete_secret(key: &str) -> Result<()> {
        let key = validate_key(key)?;
        let target_name = wide_null(&credential_target(key));
        let ok = unsafe { CredDeleteW(target_name.as_ptr(), CRED_TYPE_GENERIC, 0) };
        if ok == 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() == Some(ERROR_NOT_FOUND) {
                return Ok(());
            }
            return Err(error).context("failed to delete Windows Credential Manager secret");
        }
        Ok(())
    }

    fn credential_target(key: &str) -> String {
        format!("{SERVICE_NAME}:{key}")
    }

    fn wide_null(value: &str) -> Vec<u16> {
        std::ffi::OsStr::new(value)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::{run_command, validate_key, SERVICE_NAME};
    use anyhow::Result;

    pub fn platform_set_secret(key: &str, value: &str) -> Result<()> {
        let key = validate_key(key)?;
        run_command(
            "security",
            &[
                "add-generic-password",
                "-s",
                SERVICE_NAME,
                "-a",
                key,
                "-w",
                value,
                "-U",
            ],
            None,
            false,
        )?;
        Ok(())
    }

    pub fn platform_get_secret(key: &str) -> Result<Option<String>> {
        let key = validate_key(key)?;
        let output = run_command(
            "security",
            &["find-generic-password", "-s", SERVICE_NAME, "-a", key, "-w"],
            None,
            true,
        )?;
        Ok(output.map(|value| value.trim_end_matches(['\r', '\n']).to_string()))
    }

    pub fn platform_delete_secret(key: &str) -> Result<()> {
        let key = validate_key(key)?;
        run_command(
            "security",
            &["delete-generic-password", "-s", SERVICE_NAME, "-a", key],
            None,
            true,
        )?;
        Ok(())
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
mod platform {
    use super::{run_command, validate_key, SERVICE_NAME};
    use anyhow::Result;

    pub fn platform_set_secret(key: &str, value: &str) -> Result<()> {
        let key = validate_key(key)?;
        run_command(
            "secret-tool",
            &[
                "store",
                "--label",
                &format!("AI Term {key}"),
                "service",
                SERVICE_NAME,
                "key",
                key,
            ],
            Some(value),
            false,
        )?;
        Ok(())
    }

    pub fn platform_get_secret(key: &str) -> Result<Option<String>> {
        let key = validate_key(key)?;
        let output = run_command(
            "secret-tool",
            &["lookup", "service", SERVICE_NAME, "key", key],
            None,
            true,
        )?;
        Ok(output.map(|value| value.trim_end_matches(['\r', '\n']).to_string()))
    }

    pub fn platform_delete_secret(key: &str) -> Result<()> {
        let key = validate_key(key)?;
        run_command(
            "secret-tool",
            &["clear", "service", SERVICE_NAME, "key", key],
            None,
            true,
        )?;
        Ok(())
    }
}

#[cfg(not(any(windows, unix)))]
mod platform {
    use anyhow::{bail, Result};

    pub fn platform_set_secret(_key: &str, _value: &str) -> Result<()> {
        bail!("system credential store is not supported on this platform")
    }

    pub fn platform_get_secret(_key: &str) -> Result<Option<String>> {
        bail!("system credential store is not supported on this platform")
    }

    pub fn platform_delete_secret(_key: &str) -> Result<()> {
        bail!("system credential store is not supported on this platform")
    }
}

#[cfg(any(target_os = "macos", all(unix, not(target_os = "macos"))))]
fn run_command(
    program: &str,
    args: &[&str],
    stdin: Option<&str>,
    missing_is_ok: bool,
) -> Result<Option<String>> {
    use anyhow::{anyhow, bail, Context};
    use std::io::Write;
    use std::process::{Command, Stdio};

    let mut command = Command::new(program);
    command
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if stdin.is_some() {
        command.stdin(Stdio::piped());
    }
    let mut child = command.spawn().with_context(|| {
        format!("failed to launch {program}; install the system credential helper")
    })?;
    if let Some(input) = stdin {
        let mut child_stdin = child
            .stdin
            .take()
            .ok_or_else(|| anyhow!("failed to open {program} stdin"))?;
        child_stdin.write_all(input.as_bytes())?;
    }
    let output = child.wait_with_output()?;
    if output.status.success() {
        return Ok(Some(String::from_utf8_lossy(&output.stdout).into_owned()));
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if missing_is_ok
        && (stderr.is_empty()
            || stderr.contains("could not be found")
            || stderr.contains("No such secret"))
    {
        return Ok(None);
    }
    bail!("{program} failed: {stderr}")
}

#[cfg(windows)]
use platform::{platform_delete_secret, platform_get_secret, platform_set_secret};
#[cfg(target_os = "macos")]
use platform::{platform_delete_secret, platform_get_secret, platform_set_secret};
#[cfg(all(unix, not(target_os = "macos")))]
use platform::{platform_delete_secret, platform_get_secret, platform_set_secret};
#[cfg(not(any(windows, unix)))]
use platform::{platform_delete_secret, platform_get_secret, platform_set_secret};
