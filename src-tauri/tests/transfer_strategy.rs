use ai_term_lib::models::FileTransferMode;
use ai_term_lib::transfer::{choose_transfer_mode, TransferCapabilities};

#[test]
fn chooses_direct_sftp_first() {
    let capabilities = TransferCapabilities {
        sftp_direct: true,
        sftp_gateway: true,
        scp_available: true,
    };

    assert_eq!(
        choose_transfer_mode(&capabilities),
        FileTransferMode::SftpDirect
    );
}

#[test]
fn falls_back_to_inline_small_file_when_no_transfer_subsystem_exists() {
    let capabilities = TransferCapabilities {
        sftp_direct: false,
        sftp_gateway: false,
        scp_available: false,
    };

    assert_eq!(
        choose_transfer_mode(&capabilities),
        FileTransferMode::InlineSmallFile
    );
}
