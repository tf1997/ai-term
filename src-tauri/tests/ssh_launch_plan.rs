use ai_term_lib::domain::connection::models::{
    AuthEndpoint, AuthMode, ConnectionProfile, FileTransferMode, JumpMode,
};
use ai_term_lib::domain::terminal::ssh::{
    build_ssh_launch_plan, host_key_warning_hint, known_hosts_line_matches_endpoint,
    output_contains_host_key_warning, output_contains_password_prompt, password_prompt_hint,
    should_fallback_native_direct_error, ssh_connection_backend, SshConnectionBackend,
};

fn assert_system_ssh_tail(args: &[String], port: &str, destination: &str) {
    assert_eq!(
        &args[args.len() - 3..],
        &["-p".to_string(), port.to_string(), destination.to_string()]
    );
}

fn assert_uses_ai_term_known_hosts(args: &[String]) {
    assert!(args
        .windows(2)
        .any(|pair| pair[0] == "-o" && pair[1] == "StrictHostKeyChecking=accept-new"));
    assert!(args.iter().any(|arg| {
        arg.starts_with("UserKnownHostsFile=") && arg.contains("ai-term_known_hosts")
    }));
}
fn endpoint(host: &str, port: u16, username: &str) -> AuthEndpoint {
    AuthEndpoint {
        host: host.into(),
        port: Some(port),
        username: username.into(),
        auth_mode: AuthMode::Auto,
        credential_ref: None,
        password: None,
    }
}

fn profile(jump_mode: JumpMode) -> ConnectionProfile {
    ConnectionProfile {
        id: "prod-1".into(),
        name: "prod-1".into(),
        gateway: endpoint("ssh.company.com", 2222, "company.user"),
        target: endpoint("10.12.8.21", 2201, "app"),
        jump_mode,
        menu_profile_id: "company-default".into(),
        file_transfer_mode: FileTransferMode::Auto,
    }
}

#[test]
fn direct_profile_launches_target_ssh() {
    let plan = build_ssh_launch_plan(&profile(JumpMode::Direct));

    assert_eq!(plan.program, "ssh");
    assert_system_ssh_tail(&plan.args, "2201", "app@10.12.8.21");
    assert_uses_ai_term_known_hosts(&plan.args);
    assert!(plan.passwords.is_empty());
}

#[test]
fn interactive_menu_profile_launches_gateway_ssh() {
    let plan = build_ssh_launch_plan(&profile(JumpMode::InteractiveMenu));

    assert_eq!(plan.program, "ssh");
    assert_system_ssh_tail(&plan.args, "2222", "company.user@ssh.company.com");
    assert_uses_ai_term_known_hosts(&plan.args);
    assert!(plan.passwords.is_empty());
}

#[test]
fn direct_profile_uses_target_plaintext_password() {
    let mut profile = profile(JumpMode::Direct);
    profile.gateway.password = Some("gateway-secret".into());
    profile.target.password = Some("target-secret".into());

    let plan = build_ssh_launch_plan(&profile);

    assert_eq!(plan.passwords, vec!["target-secret"]);
}

#[test]
fn interactive_menu_profile_with_menu_uses_system_ssh_backend() {
    let profile = profile(JumpMode::InteractiveMenu);

    assert_eq!(
        ssh_connection_backend(&profile),
        SshConnectionBackend::SystemSsh
    );
}

#[test]
fn interactive_gateway_without_menu_uses_native_bastion_backend() {
    let mut profile = profile(JumpMode::InteractiveMenu);
    profile.menu_profile_id = String::new();

    assert_eq!(
        ssh_connection_backend(&profile),
        SshConnectionBackend::NativeBastion
    );
}

#[test]
fn direct_profile_uses_native_direct_backend() {
    let profile = profile(JumpMode::Direct);

    assert_eq!(
        ssh_connection_backend(&profile),
        SshConnectionBackend::NativeDirect
    );
}
#[test]
fn ai_term_known_hosts_line_matching_is_scoped_to_host_and_port() {
    assert!(known_hosts_line_matches_endpoint(
        "23.238.39.4 ssh-rsa AAA old-key",
        "23.238.39.4",
        22
    ));
    assert!(known_hosts_line_matches_endpoint(
        "[ag.hirain.com]:2222 ssh-ed25519 AAA old-key",
        "ag.hirain.com",
        2222
    ));
    assert!(known_hosts_line_matches_endpoint(
        "23.238.39.4,[23.238.39.4]:22 ssh-rsa AAA old-key",
        "23.238.39.4",
        22
    ));
    assert!(!known_hosts_line_matches_endpoint(
        "23.238.39.5 ssh-rsa AAA old-key",
        "23.238.39.4",
        22
    ));
    assert!(!known_hosts_line_matches_endpoint(
        "# 23.238.39.4 ssh-rsa AAA old-key",
        "23.238.39.4",
        22
    ));
}

#[test]
fn native_direct_fallback_only_covers_connect_and_handshake_failures() {
    let connect_error = anyhow::anyhow!(
        "failed to connect root@server:22: failed to connect server:22: connection timed out"
    );
    let handshake_error = anyhow::anyhow!("failed to connect root@server:22: SSH handshake failed");
    let auth_error = anyhow::anyhow!("SSH authentication failed for root@server:22");
    let host_key_error = anyhow::anyhow!("SSH host key verification failed for root@server:22");

    assert!(should_fallback_native_direct_error(&connect_error));
    assert!(should_fallback_native_direct_error(&handshake_error));
    assert!(!should_fallback_native_direct_error(&auth_error));
    assert!(!should_fallback_native_direct_error(&host_key_error));
}

#[test]
fn legacy_interactive_plan_only_submits_gateway_plaintext_password() {
    let mut profile = profile(JumpMode::InteractiveMenu);
    profile.gateway.password = Some("gateway-secret".into());
    profile.target.password = Some("target-secret".into());

    let plan = build_ssh_launch_plan(&profile);

    assert_eq!(plan.passwords, vec!["gateway-secret"]);
}

#[test]
fn key_auth_endpoints_do_not_auto_submit_plaintext_passwords() {
    let mut profile = profile(JumpMode::InteractiveMenu);
    profile.gateway.auth_mode = AuthMode::Key;
    profile.gateway.password = Some("gateway-secret".into());
    profile.target.auth_mode = AuthMode::Password;
    profile.target.password = Some("target-secret".into());

    let plan = build_ssh_launch_plan(&profile);

    assert!(plan.passwords.is_empty());
}

#[test]
fn ssh_password_prompt_detection_matches_common_prompts() {
    assert!(output_contains_password_prompt(
        "app@10.12.8.21's password:"
    ));
    assert!(output_contains_password_prompt(
        "Password for company.user:"
    ));
    assert!(!output_contains_password_prompt("Last login: Thu Jul 2"));
}

#[test]
fn password_hint_explains_unsaved_manual_passwords() {
    let hint = password_prompt_hint(0, 0);

    assert!(hint.contains("没有保存密码"));
    assert!(hint.contains("不会记住上次手动输入"));
}

#[test]
fn password_hint_explains_rejected_saved_passwords() {
    let hint = password_prompt_hint(1, 1);

    assert!(hint.contains("已保存密码没有通过认证"));
    assert!(hint.contains("远端仍在请求密码"));
}

#[test]
fn host_key_warning_detection_explains_known_hosts_conflict() {
    let output = "WARNING: POSSIBLE DNS SPOOFING DETECTED!\nWARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!\nThe fingerprint for the RSA key sent by the remote host is SHA256:4rFUMED4VYR0qbFkEXL5tx9dvrkAZmlderkLxntUTg4.\nOffending RSA key in C:\\Users\\tengfei.chu\\.ssh\\known_hosts:1\nHost key verification failed.";

    assert!(output_contains_host_key_warning(output));
    let hint = host_key_warning_hint(output);

    assert!(hint.contains("SSH 主机密钥校验失败"));
    assert!(hint.contains("SHA256:4rFUMED4VYR0qbFkEXL5tx9dvrkAZmlderkLxntUTg4"));
    assert!(hint.contains("known_hosts:1"));
}
