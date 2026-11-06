//! Deterministic command analysis and immutable execution intents.
//! Parsing success is not proof that a shell program is safe.
mod analysis;
mod intent;
mod reusable;
mod rules;
mod transport;
mod types;

pub use analysis::{analyze_command, AnalysisBudget};
pub use intent::{CommandIntent, IntentReference, IntentStore, OperationKind};
pub use reusable::{
    analyze_reusable_command, CommandExportAnalysis, CommandScriptSecret, CommandScriptSource,
};
pub use transport::{CaptureKind, CaptureTransport, InternalProbe};
pub use types::*;

pub const POLICY_VERSION: &str = "command-policy-v1";
