//! One dedicated SSH transport per explicitly scoped task. Interactive PTYs are
//! never reused and a dispatched task is never replayed on another route.
mod executor;
mod protocol;
mod store;
mod types;

pub use executor::{execute_ssh_task, SshTaskControl};
pub use store::{SshTaskDispatch, SshTaskStore};
pub use types::*;

#[cfg(test)]
mod tests;
