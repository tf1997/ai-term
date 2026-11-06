use super::{FileError, FileErrorKind, FileResult};
use serde::{Deserialize, Serialize};
use std::io::Read;

pub const MAX_MOUNTINFO_BYTES: usize = 262_144;

/// Evidence from the process that actually resolves and opens paths. Hostname
/// and login configuration alone cannot establish this mapping. Missing fields
/// are deliberately not treated as equivalent evidence.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "platform", rename_all = "lowercase", deny_unknown_fields)]
pub enum FileEnvironment {
    Linux {
        boot: String,
        mount: String,
        root: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        root_mount: Option<String>,
        credentials: String,
        security: String,
    },
    Darwin {
        device: u64,
        inode: u64,
        uid: u32,
        gid: u32,
        groups: Vec<u32>,
    },
}
impl FileEnvironment {
    pub fn validate(&self) -> FileResult<()> {
        let valid = match self {
            Self::Linux {
                boot,
                mount,
                root,
                root_mount,
                credentials,
                security,
            } => {
                uuid::Uuid::parse_str(boot).is_ok()
                    && mount.starts_with("mnt:[")
                    && mount.ends_with(']')
                    && mount.len() > 6
                    && mount[5..mount.len() - 1]
                        .bytes()
                        .all(|b| b.is_ascii_digit())
                    && mount.len() <= 64
                    && root.starts_with('/')
                    && root.len() <= 4096
                    && !root.chars().any(char::is_control)
                    && root_mount.as_ref().is_some_and(|value| {
                        value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
                    })
                    && !credentials.is_empty()
                    && credentials.len() <= 4096
                    && !security.is_empty()
                    && security.len() <= 4096
            }
            Self::Darwin { inode, groups, .. } => *inode > 0 && groups.len() <= 256,
        };
        if valid {
            Ok(())
        } else {
            Err(FileError::new(
                FileErrorKind::Unavailable,
                "文件环境证据不完整，必须从当前终端读取",
            ))
        }
    }
    pub fn matches(&self, other: &Self) -> bool {
        self.validate().is_ok() && other.validate().is_ok() && self == other
    }
}

/// Only fields affecting file access are compared; pid/name vary by process.
/// Active syscall filters are not enough evidence for native file access.
pub fn linux_credentials(status: &str) -> FileResult<String> {
    let fields = ["Uid", "Gid", "Groups", "CapEff", "NoNewPrivs", "Seccomp"];
    let mut normalized = Vec::new();
    for field in fields {
        let line = status
            .lines()
            .find_map(|line| line.strip_prefix(&format!("{field}:")))
            .ok_or_else(|| FileError::new(FileErrorKind::Unavailable, "无法核对文件访问身份"))?;
        let value = line.split_whitespace().collect::<Vec<_>>().join(" ");
        if field == "Seccomp" && value != "0" {
            return Err(FileError::new(
                FileErrorKind::Unavailable,
                "当前进程有独立访问限制，使用当前终端读取",
            ));
        }
        normalized.push(format!("{field}:{value}"));
    }
    Ok(normalized.join(";"))
}

/// `/proc/self/root` is rendered relative to each process's own root. Its
/// string value alone cannot distinguish chroots in the same mount namespace.
/// The kernel omits mounts outside the process root from mountinfo. Require a
/// unique mount visible exactly at `/`; a non-mountpoint chroot has no such
/// proof and must retain current-terminal access. Keep only a digest, since
/// filesystem mount options can contain private configuration.
pub fn linux_root_mount(mountinfo: &str) -> FileResult<String> {
    use sha2::{Digest, Sha256};
    let unavailable = || {
        FileError::new(
            FileErrorKind::Unavailable,
            "无法确定当前进程的根挂载，使用当前终端读取",
        )
    };
    if mountinfo.len() > MAX_MOUNTINFO_BYTES {
        return Err(unavailable());
    }
    let mut root = None;
    for line in mountinfo.lines() {
        let fields: Vec<&str> = line.split_ascii_whitespace().collect();
        if fields.get(4) != Some(&"/") {
            continue;
        }
        let separator = fields.iter().position(|field| *field == "-");
        let valid = separator.is_some_and(|index| index >= 6 && fields.len() == index + 4)
            && fields[0].parse::<u64>().is_ok_and(|id| id > 0)
            && fields[1].parse::<u64>().is_ok()
            && fields[2].split_once(':').is_some_and(|(major, minor)| {
                !major.is_empty()
                    && !minor.is_empty()
                    && major
                        .bytes()
                        .chain(minor.bytes())
                        .all(|byte| byte.is_ascii_digit())
            })
            && fields[3].starts_with('/');
        if !valid || root.is_some() {
            return Err(unavailable());
        }
        root = Some(format!("{:x}", Sha256::digest(fields.join(" ").as_bytes())));
    }
    root.ok_or_else(unavailable)
}

pub fn read_bounded_evidence(reader: impl Read, limit: usize) -> FileResult<String> {
    let mut data = Vec::new();
    reader.take((limit + 1) as u64).read_to_end(&mut data)?;
    if data.len() > limit {
        return Err(FileError::new(
            FileErrorKind::Unavailable,
            "文件环境证据超过预算",
        ));
    }
    String::from_utf8(data)
        .map(|value| value.trim_matches(['\0', '\n', '\r']).into())
        .map_err(|_| FileError::new(FileErrorKind::Unavailable, "文件环境证据编码不受支持"))
}

pub fn local_file_environment() -> FileResult<FileEnvironment> {
    #[cfg(target_os = "linux")]
    {
        let evidence = |path, limit| read_bounded_evidence(std::fs::File::open(path)?, limit);
        let link = |path| -> FileResult<String> {
            std::fs::read_link(path)?
                .to_str()
                .map(str::to_owned)
                .ok_or_else(|| FileError::new(FileErrorKind::Unavailable, "文件环境路径不是 UTF-8"))
        };
        let environment = FileEnvironment::Linux {
            boot: evidence("/proc/sys/kernel/random/boot_id", 64)?,
            mount: link("/proc/self/ns/mnt")?,
            root: link("/proc/self/root")?,
            root_mount: Some(linux_root_mount(&evidence(
                "/proc/self/mountinfo",
                MAX_MOUNTINFO_BYTES,
            )?)?),
            credentials: linux_credentials(&evidence("/proc/self/status", 16384)?)?,
            security: evidence("/proc/self/attr/current", 4096)?,
        };
        environment.validate()?;
        return Ok(environment);
    }
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::fs::MetadataExt;
        let metadata = std::fs::metadata("/")?;
        let count = unsafe { libc::getgroups(0, std::ptr::null_mut()) };
        if !(0..=256).contains(&count) {
            return Err(FileError::new(
                FileErrorKind::Unavailable,
                "无法核对本地用户组",
            ));
        }
        let mut groups = vec![0; count as usize];
        if unsafe { libc::getgroups(count, groups.as_mut_ptr()) } != count {
            return Err(std::io::Error::last_os_error().into());
        }
        groups.sort_unstable();
        groups.dedup();
        return Ok(FileEnvironment::Darwin {
            device: metadata.dev(),
            inode: metadata.ino(),
            uid: unsafe { libc::geteuid() },
            gid: unsafe { libc::getegid() },
            groups,
        });
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    Err(FileError::new(
        FileErrorKind::Unavailable,
        "此平台需要通过当前终端访问文件",
    ))
}
