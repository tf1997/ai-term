use anyhow::{bail, Result};

use super::models::{ConnectionProfile, FileTransferMode, JumpMode};

pub fn validate_profile(profile: &ConnectionProfile) -> Result<()> {
    if profile.id.trim().is_empty() {
        bail!("profile id is required");
    }
    if profile.name.trim().is_empty() {
        bail!("profile name is required");
    }
    if profile.target.host.trim().is_empty() {
        bail!("target host is required");
    }
    if profile.target.username.trim().is_empty() {
        bail!("target username is required");
    }

    if profile.file_transfer_mode == FileTransferMode::SftpGateway {
        if profile.gateway.host.trim().is_empty() {
            bail!("gateway host is required");
        }
        if profile.gateway.username.trim().is_empty() {
            bail!("gateway username is required");
        }
    }

    if profile.jump_mode == JumpMode::InteractiveMenu
        && profile.file_transfer_mode != FileTransferMode::SftpGateway
    {
        if profile.gateway.host.trim().is_empty() {
            bail!("gateway host is required");
        }
        if profile.gateway.username.trim().is_empty() {
            bail!("gateway username is required");
        }
        if profile.menu_profile_id.trim().is_empty() {
            bail!("menu profile id is required");
        }
    }
    Ok(())
}
