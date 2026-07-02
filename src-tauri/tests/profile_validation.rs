use ai_term_lib::models::{AuthEndpoint, AuthMode, ConnectionProfile, FileTransferMode, JumpMode};
use ai_term_lib::profiles::validate_profile;

fn endpoint(host: &str, username: &str) -> AuthEndpoint {
    AuthEndpoint {
        host: host.to_string(),
        port: Some(22),
        username: username.to_string(),
        auth_mode: AuthMode::Auto,
        credential_ref: None,
        password: None,
    }
}

#[test]
fn valid_profile_passes() {
    let profile = ConnectionProfile {
        id: "prod-app-01".into(),
        name: "prod-app-01".into(),
        gateway: endpoint("ssh.company.com", "company.user"),
        target: endpoint("10.12.8.21", "app"),
        jump_mode: JumpMode::InteractiveMenu,
        menu_profile_id: "company-default".into(),
        file_transfer_mode: FileTransferMode::Auto,
    };

    assert!(validate_profile(&profile).is_ok());
}

#[test]
fn empty_gateway_host_fails() {
    let profile = ConnectionProfile {
        id: "prod-app-01".into(),
        name: "prod-app-01".into(),
        gateway: endpoint("", "company.user"),
        target: endpoint("10.12.8.21", "app"),
        jump_mode: JumpMode::InteractiveMenu,
        menu_profile_id: "company-default".into(),
        file_transfer_mode: FileTransferMode::Auto,
    };

    assert_eq!(
        validate_profile(&profile).unwrap_err().to_string(),
        "gateway host is required"
    );
}

#[test]
fn direct_profile_without_gateway_passes() {
    let profile = ConnectionProfile {
        id: "direct-prod-app-01".into(),
        name: "direct-prod-app-01".into(),
        gateway: endpoint("", ""),
        target: endpoint("10.12.8.21", "app"),
        jump_mode: JumpMode::Direct,
        menu_profile_id: "".into(),
        file_transfer_mode: FileTransferMode::Auto,
    };

    assert!(validate_profile(&profile).is_ok());
}

#[test]
fn interactive_profile_without_menu_id_fails() {
    let profile = ConnectionProfile {
        id: "prod-app-01".into(),
        name: "prod-app-01".into(),
        gateway: endpoint("ssh.company.com", "company.user"),
        target: endpoint("10.12.8.21", "app"),
        jump_mode: JumpMode::InteractiveMenu,
        menu_profile_id: "".into(),
        file_transfer_mode: FileTransferMode::Auto,
    };

    assert_eq!(
        validate_profile(&profile).unwrap_err().to_string(),
        "menu profile id is required"
    );
}
