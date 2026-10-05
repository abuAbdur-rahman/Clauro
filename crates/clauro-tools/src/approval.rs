//! Approval: a typed state machine (D109).
//!
//! Ask-mode approval walks queued → pending → approved, resuming and draining
//! approved siblings in FIFO order; a rejection becomes a typed `error`
//! result and the loop continues with nothing deleted. Tests assert the
//! states, not just that approval exists.

use clauro_core::{ToolOutcome, ToolStatus};
use serde_json::Value;
use std::collections::VecDeque;
use std::fmt;

/// Ask-mode states. Terminal: approved (dispatches) and rejected (typed
/// error). Nothing else leaves the queue.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalState {
    Queued,
    Pending,
    Approved,
    Rejected,
}

/// One held call.
#[derive(Debug, Clone, PartialEq)]
pub struct HeldCall {
    pub id: String,
    pub tool: String,
    pub input: Value,
    pub state: ApprovalState,
}

/// Why an approval step failed. Setup and sequencing mistakes, typed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApprovalError {
    UnknownId(String),
    WrongState { id: String, state: ApprovalState },
    Store(String),
}

impl fmt::Display for ApprovalError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnknownId(id) => write!(f, "no held call: {id}"),
            Self::WrongState { id, state } => {
                write!(f, "call {id} cannot advance from {state:?}")
            }
            Self::Store(e) => write!(f, "approval persist failed: {e}"),
        }
    }
}

impl std::error::Error for ApprovalError {}

/// FIFO queue of held calls.
pub struct ApprovalQueue {
    calls: VecDeque<HeldCall>,
}

impl ApprovalQueue {
    #[must_use]
    pub fn new() -> Self {
        Self {
            calls: VecDeque::new(),
        }
    }

    /// Hold a call for approval. Enters as queued. Re-holding an id the
    /// queue already knows resets it to a fresh queued entry: a repeated call
    /// id is a new decision, never a second row for the old verdict.
    pub fn hold(&mut self, id: &str, tool: &str, input: Value) -> ApprovalState {
        if let Some(existing) = self.calls.iter_mut().find(|c| c.id == id) {
            existing.tool = tool.to_string();
            existing.input = input;
            existing.state = ApprovalState::Queued;
        } else {
            self.calls.push_back(HeldCall {
                id: id.to_string(),
                tool: tool.to_string(),
                input,
                state: ApprovalState::Queued,
            });
        }
        ApprovalState::Queued
    }

    fn find_mut(&mut self, id: &str) -> Result<&mut HeldCall, ApprovalError> {
        self.calls
            .iter_mut()
            .find(|c| c.id == id)
            .ok_or_else(|| ApprovalError::UnknownId(id.to_string()))
    }

    /// Hold and present in one step: the loop's ask path. Total after the
    /// reset-in-hold above — no caller needs to handle a mid-step failure.
    pub fn hold_pending(
        &mut self,
        id: &str,
        tool: &str,
        input: Value,
    ) -> Result<ApprovalState, ApprovalError> {
        self.hold(id, tool, input);
        self.mark_pending(id)
    }

    /// Present the call for a decision. Queued → pending.
    pub fn mark_pending(&mut self, id: &str) -> Result<ApprovalState, ApprovalError> {
        let call = self.find_mut(id)?;
        if call.state != ApprovalState::Queued {
            return Err(ApprovalError::WrongState {
                id: id.to_string(),
                state: call.state,
            });
        }
        call.state = ApprovalState::Pending;
        Ok(ApprovalState::Pending)
    }

    /// Approve and resume. Returns the newly resumable call; siblings drain
    /// in order via `drain_approved`.
    pub fn approve(&mut self, id: &str) -> Result<Vec<HeldCall>, ApprovalError> {
        let call = self.find_mut(id)?;
        if call.state != ApprovalState::Pending {
            return Err(ApprovalError::WrongState {
                id: id.to_string(),
                state: call.state,
            });
        }
        call.state = ApprovalState::Approved;
        Ok(vec![call.clone()])
    }

    /// Reject: a typed `error` result for this call. Siblings stay held —
    /// the loop continues with nothing deleted.
    pub fn reject(&mut self, id: &str) -> Result<ToolOutcome, ApprovalError> {
        let call = self.find_mut(id)?;
        if call.state != ApprovalState::Pending {
            return Err(ApprovalError::WrongState {
                id: id.to_string(),
                state: call.state,
            });
        }
        call.state = ApprovalState::Rejected;
        Ok(ToolOutcome::Error {
            message: format!("{} declined by the user", call.tool),
        })
    }

    /// Release every approved call in FIFO order, removing them.
    pub fn drain_approved(&mut self) -> Vec<HeldCall> {
        let mut out = Vec::new();
        self.calls.retain(|c| {
            if c.state == ApprovalState::Approved {
                out.push(c.clone());
                false
            } else {
                true
            }
        });
        out
    }

    /// What `tool_result.status` a held call's outcome maps to. Reused by the
    /// loop when persisting approval results.
    #[must_use]
    pub fn status_of(state: ApprovalState) -> ToolStatus {
        match state {
            ApprovalState::Approved => ToolStatus::Ok,
            ApprovalState::Rejected => ToolStatus::Rejected,
            ApprovalState::Queued | ApprovalState::Pending => ToolStatus::Error,
        }
    }
}

impl Default for ApprovalQueue {
    fn default() -> Self {
        Self::new()
    }
}
