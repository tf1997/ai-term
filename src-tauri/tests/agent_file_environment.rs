use ai_term_lib::domain::filesystem::agent_files::*;

const ROOT: &str =
    "25 1 8:1 / / rw,relatime - ext4 /dev/fixture rw\n26 25 0:5 / /proc rw - proc proc rw\n";

#[test]
fn native_mapping_requires_a_unique_visible_root_mount_under_a_scan_budget() {
    let root = linux_root_mount(ROOT).unwrap();
    assert_eq!(root.len(), 64);
    assert_ne!(
        root,
        linux_root_mount(&ROOT.replace("8:1 / /", "8:1 /jail / ")).unwrap()
    );
    assert_ne!(
        root,
        linux_root_mount(&ROOT.replace("25 1 8:1", "30 1 8:2")).unwrap()
    );
    for value in [
        "".into(),
        "26 25 0:5 / /proc rw - proc proc rw\n".into(),
        format!("{ROOT}{ROOT}"),
        ROOT.replace("25 1 8:1", "x 1 8:1"),
        ROOT.replace("8:1", "invalid-device"),
        ROOT.replace(" - ext4", " ext4"),
        " ".repeat(MAX_MOUNTINFO_BYTES + 1),
    ] {
        assert_eq!(
            linux_root_mount(&value).unwrap_err().kind,
            FileErrorKind::Unavailable
        );
    }
}

#[test]
fn old_environment_records_still_decode_but_cannot_prove_native_equivalence() {
    let mut value = serde_json::json!({
        "platform":"linux", "boot":"91aa2343-556d-4cd1-b33c-63406c4a146f",
        "mount":"mnt:[4026531841]", "root":"/", "credentials":"Uid:1000", "security":"unconfined"
    });
    let old: FileEnvironment = serde_json::from_value(value.clone()).unwrap();
    assert!(old.validate().is_err());
    assert!(!old.matches(&old));
    value["root_mount"] = linux_root_mount(ROOT).unwrap().into();
    let current: FileEnvironment = serde_json::from_value(value.clone()).unwrap();
    assert!(current.validate().is_ok());
    assert!(!current.matches(&old));
    assert!(current.matches(&current));
    value["root_mount"] = linux_root_mount(&ROOT.replace("8:1 / /", "8:1 /jail / "))
        .unwrap()
        .into();
    let different_root: FileEnvironment = serde_json::from_value(value).unwrap();
    assert!(!current.matches(&different_root));
}

#[test]
#[cfg(unix)]
fn terminal_root_proof_agrees_with_native_and_preserves_saved_scope_identity() {
    let cases = vec![
        ROOT.to_owned(),
        ROOT.replace("8:1 / /", "8:1 /jail\\040space /"),
        "26 25 0:5 / /proc rw - proc proc rw\n".into(),
        format!("{ROOT}{ROOT}"),
        ROOT.replace("25 1 8:1", "x 1 8:1"),
    ];
    let script = r#"
import json, runpy, sys
from types import SimpleNamespace
from unittest.mock import patch
helpers = runpy.run_path(sys.argv[1], run_name='ai_term_file_helpers')
helpers = helpers['environment'].__globals__
cases = json.loads(sys.argv[2])
results = []
for value in cases:
    try:
        results.append(helpers['linux_root_mount'](value))
    except helpers['FileFailure']:
        results.append(None)
try:
    helpers['linux_root_mount']('x' * (helpers['MAX_MOUNTINFO'] + 1))
    raise AssertionError('oversized mountinfo must fail')
except helpers['FileFailure']:
    pass
files = {
    '/proc/sys/kernel/random/boot_id': '91aa2343-556d-4cd1-b33c-63406c4a146f',
    '/proc/self/status': 'Uid: 1000 1000 1000 1000\nGid: 1000 1000 1000 1000\nGroups: 1000 1001\nCapEff: 0000000000000000\nNoNewPrivs: 0\nSeccomp: 0\n',
    '/proc/self/attr/current': 'unconfined', '/proc/self/mountinfo': cases[0],
}
helpers['bounded'] = lambda path, limit: files[path]
os = helpers['os']
root = SimpleNamespace(st_dev=99, st_ino=2)
with patch.object(sys, 'platform', 'linux'), patch.multiple(os,
    stat=lambda path: root, getuid=lambda: 1000, geteuid=lambda: 1000,
    getgid=lambda: 1000, getegid=lambda: 1000, getgroups=lambda: [1001, 1000],
    readlink=lambda path: 'mnt:[4026531841]' if path.endswith('/mnt') else '/'):
    normal = helpers['environment']()
    files['/proc/self/mountinfo'] = cases[2]
    fallback = helpers['environment']()
    root.st_ino = 3
    changed_root = helpers['environment']()
print(json.dumps(dict(results=results, normal=normal, fallback=fallback, changed=changed_root)))
"#;
    let output = std::process::Command::new("python3")
        .args(["-I", "-c", script])
        .arg(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("src/domain/filesystem/agent_files/terminal.py"),
        )
        .arg(serde_json::to_string(&cases).unwrap())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let observed: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    for (index, value) in cases.iter().enumerate() {
        assert_eq!(
            observed["results"][index],
            serde_json::to_value(linux_root_mount(value).ok()).unwrap()
        );
    }
    let environment: FileEnvironment =
        serde_json::from_value(observed["normal"][0].clone()).unwrap();
    assert!(environment.validate().is_ok());
    let legacy_scope = "db35d379e0fc85b38c2422644d16b1a2cbfa77c622e8528c8832f5cd1a9086f4";
    assert_eq!(observed["normal"][1], legacy_scope);
    assert!(observed["fallback"][0].is_null());
    assert_eq!(observed["fallback"][1], legacy_scope);
    assert_ne!(observed["changed"][1], legacy_scope);
}
