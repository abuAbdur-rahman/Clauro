//! Per-thread follow-up queue and chip operations (D98, D105).
//!
//! Sending mid-turn appends instead of blocking: the queue is a per-thread
//! FIFO in the host. It drains as in-order turns, never merged — N intents
//! stay N turns. Chips remove, edit, or send-now; send-now extracts one item
//! without draining the rest. No new block kinds.

use std::collections::VecDeque;

/// One queued follow-up: a chip in the composer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueuedItem {
    pub id: String,
    pub text: String,
}

/// Offered when stopping with unsent input waiting.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopOffer {
    DrainOrDiscard,
}

/// FIFO of unsent follow-ups for one thread.
pub struct ThreadQueue {
    items: VecDeque<QueuedItem>,
    next: u64,
}

impl ThreadQueue {
    #[must_use]
    pub fn new() -> Self {
        Self {
            items: VecDeque::new(),
            next: 0,
        }
    }

    /// Append; returns the chip id.
    pub fn enqueue(&mut self, text: &str) -> String {
        self.next += 1;
        let id = format!("q{}", self.next);
        self.items.push_back(QueuedItem {
            id: id.clone(),
            text: text.to_string(),
        });
        id
    }

    /// Chip: drop one item. False when the id is unknown.
    pub fn remove(&mut self, id: &str) -> bool {
        let before = self.items.len();
        self.items.retain(|item| item.id != id);
        self.items.len() != before
    }

    /// Chip: reword one item. False when the id is unknown.
    pub fn edit(&mut self, id: &str, text: &str) -> bool {
        match self.items.iter_mut().find(|item| item.id == id) {
            Some(item) => {
                item.text = text.to_string();
                true
            }
            None => false,
        }
    }

    /// Chip: extract one item without draining the rest.
    pub fn send_now(&mut self, id: &str) -> Option<QueuedItem> {
        self.items
            .iter()
            .position(|item| item.id == id)
            .and_then(|pos| self.items.remove(pos))
    }

    /// Next turn's input, if any. One item, never merged.
    pub fn drain_next(&mut self) -> Option<QueuedItem> {
        self.items.pop_front()
    }

    /// Drop all unsent input. Returns the count dropped.
    pub fn discard_unsent(&mut self) -> usize {
        let n = self.items.len();
        self.items.clear();
        n
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.items.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    /// Offered on stop exactly when unsent input waits.
    #[must_use]
    pub fn stop_offer(&self) -> Option<StopOffer> {
        if self.is_empty() {
            None
        } else {
            Some(StopOffer::DrainOrDiscard)
        }
    }
}

impl Default for ThreadQueue {
    fn default() -> Self {
        Self::new()
    }
}
