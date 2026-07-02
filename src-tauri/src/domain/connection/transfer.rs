use super::models::FileTransferMode;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransferCapabilities {
    pub sftp_direct: bool,
    pub sftp_gateway: bool,
    pub scp_available: bool,
}

pub fn choose_transfer_mode(capabilities: &TransferCapabilities) -> FileTransferMode {
    if capabilities.sftp_direct {
        FileTransferMode::SftpDirect
    } else if capabilities.sftp_gateway {
        FileTransferMode::SftpGateway
    } else if capabilities.scp_available {
        FileTransferMode::ScpThroughTerminal
    } else {
        FileTransferMode::InlineSmallFile
    }
}
