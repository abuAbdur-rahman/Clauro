//! The swap half of `stage_write`, Windows (D34, D128, audit 11).
//!
//! `std::fs::rename` on Windows is `MoveFileExW(MOVEFILE_REPLACE_EXISTING)`.
//! It deletes the replaced file and lets the staged file take its name —
//! carrying the staged file's own descriptor, inherited from `dirname(target)`
//! at creation — so the target's explicit (possibly narrower) DACL, its file
//! attributes and its named streams were all silently discarded. D34 claims
//! "replacement writes preserve the target's existing DACL"; this module is
//! what makes that claim true.
//!
//! `ReplaceFileW` merges the other way: the survivor keeps the **replaced**
//! file's creation time, short file name, object identifier, DACLs, security
//! resource attributes, encryption, compression and named streams (the
//! replacement's content becomes the file's). Adopted over hand-rolled FFI
//! and over in-place writes — the rejected alternatives and the dependency
//! record live in `TECH_STACK.md` §6.1 and D128.

use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use windows_sys::Win32::Storage::FileSystem::ReplaceFileW;

/// Swap `staged` over an existing `target`, preserving the replaced file's
/// security state. All three paths must be on one volume — guaranteed here
/// because staging lives in `dirname(target)` (D34). `target` must exist;
/// `stage_write` picks plain rename for a target that does not.
///
/// No ignore-flags are passed: `REPLACEFILE_IGNORE_MERGE_ERRORS` /
/// `..._ACL_ERRORS` would let the swap succeed while quietly dropping the
/// DACL — the exact failure D34 forbids. A merge failure surfaces instead as
/// the returned error, captured from `last_os_error` immediately after the
/// call (D55: typed, never a panic).
pub(crate) fn replace_preserving(target: &Path, staged: &Path) -> std::io::Result<()> {
    let target: Vec<u16> = target
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let staged: Vec<u16> = staged
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    // SAFETY: both buffers are NUL-terminated wide strings; the excluded/
    // reserved out-params are documented NULL; nothing else runs between the
    // failed call and the `last_os_error` capture below.
    let ok = unsafe {
        ReplaceFileW(
            target.as_ptr(),
            staged.as_ptr(),
            std::ptr::null(),
            0,
            std::ptr::null(),
            std::ptr::null(),
        )
    };
    if ok == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}
