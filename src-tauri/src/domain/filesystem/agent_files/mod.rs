//! Bounded file-tool data access. Routing and approval belong to the application
//! layer; these readers never guess another host or download to a temporary file.
mod edits;
mod environment;
mod extended_metadata;
mod local;
mod local_edits;
mod operation;
mod policy;
mod reader;
mod terminal;
mod terminal_edits;
mod types;

pub use edits::*;
pub use environment::{
    linux_credentials, linux_root_mount, local_file_environment, read_bounded_evidence,
    FileEnvironment, MAX_MOUNTINFO_BYTES,
};
pub use local::{
    inspect_local_agent_file, list_local_directory, list_local_directory_with_permit,
    read_local_file, read_local_file_with_permit,
};
pub use local_edits::edit_local_file;
pub use operation::{
    FileAccessPermit, FileDispatch, FileOperation, FileOperationReference, FileOperationStore,
    FileProvider, FileToolData, FileToolRequest, FileToolResponse,
};
pub use policy::{check_file_path, check_file_path_syntax, sensitive_file_path};
pub use reader::{directory_page, read_text_page};
pub use terminal::{FileInspection, TerminalFileRequest, TERMINAL_FILE_OUTPUT_LIMIT};
pub use terminal_edits::TerminalFileEditRequest;
pub use types::*;
