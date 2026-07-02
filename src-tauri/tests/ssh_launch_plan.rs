use ai_term_lib::domain::connection::models::{
    AuthEndpoint, AuthMode, ConnectionProfile, FileTransferMode, JumpMode,
};
use ai_term_lib::domain::terminal::ssh::{build_ssh_launch_plan, output_contains_password_prompt};

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
    assert_eq!(plan.args, vec!["-tt", "-p", "2201", "app@10.12.8.21"]);
    assert!(plan.passwords.is_empty());
}

#[test]
fn interactive_menu_profile_launches_gateway_ssh() {
    let plan = build_ssh_launch_plan(&profile(JumpMode::InteractiveMenu));

    assert_eq!(plan.program, "ssh");
    assert_eq!(
        plan.args,
        vec!["-tt", "-p", "2222", "company.user@ssh.company.com"]
    );
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
fn interactive_menu_profile_uses_gateway_plaintext_password() {
    let mut profile = profile(JumpMode::InteractiveMenu);
    profile.gateway.password = Some("gateway-secret".into());
    profile.target.password = Some("target-secret".into());

    let plan = build_ssh_launch_plan(&profile);

    assert_eq!(plan.passwords, vec!["gateway-secret", "target-secret"]);
}

#[test]
fn key_auth_endpoints_do_not_auto_submit_plaintext_passwords() {
    let mut profile = profile(JumpMode::InteractiveMenu);
    profile.gateway.auth_mode = AuthMode::Key;
    profile.gateway.password = Some("gateway-secret".into());
    profile.target.auth_mode = AuthMode::Password;
    profile.target.password = Some("target-secret".into());

    let plan = build_ssh_launch_plan(&profile);

    assert_eq!(plan.passwords, vec!["target-secret"]);
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
