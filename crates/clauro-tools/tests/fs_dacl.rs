//! audit 11 / D34 / D128 — a staged replacement must keep the TARGET's
//! security state: its explicit DACL, its file attributes, its named streams
//! (RED first: each assertion below fails against the rename-over swap,
//! which hands the target the staged file's directory-inherited descriptor).
//!
//! Windows-only by construction (`#![cfg(windows)]`): the claim under test
//! is Win32 semantics — §8a keeps the verdict Windows-only until someone
//! runs it elsewhere.

#![cfg(windows)]

use clauro_core::{ToolContext, ToolOutcome};
use clauro_store::Store;
use clauro_tools::{register_fs, FsHost, IncomingCall, Registry};
use serde_json::json;
use std::ffi::c_void;
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use windows_sys::Win32::Foundation::LocalFree;
use windows_sys::Win32::Security::Authorization::{
    GetNamedSecurityInfoW, SetNamedSecurityInfoW, SE_FILE_OBJECT,
};
use windows_sys::Win32::Security::{
    AddAccessAllowedAce, CreateWellKnownSid, EqualSid, GetAce, InitializeAcl, WinWorldSid,
    ACCESS_ALLOWED_ACE, ACE_HEADER, ACL, ACL_REVISION, DACL_SECURITY_INFORMATION, INHERITED_ACE,
    PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID,
};
use windows_sys::Win32::Storage::FileSystem::{
    GetFileAttributesW, SetFileAttributesW, FILE_ALL_ACCESS, FILE_ATTRIBUTE_HIDDEN,
};

// ── harness (same shape as fs_tool.rs: fresh tree per test, store first) ─────

static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

struct Trees {
    // Option'd so `Drop` can close the SQLite connection BEFORE the directory
    // sweep: a custom `Drop` body runs before field destructors, so field
    // order alone does not close the store in time, and Windows cannot delete
    // open files (error 32).
    store: Option<Arc<Mutex<Store>>>,
    tmp: PathBuf,
    session: PathBuf,
    project: PathBuf,
}

fn trees() -> Trees {
    let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let mut stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = loop {
        let candidate =
            std::env::temp_dir().join(format!("clauro-dacl-{}-{n}-{stamp}", std::process::id()));
        if std::fs::create_dir(&candidate).is_ok() {
            break candidate;
        }
        stamp += 1;
    };
    let session = tmp.join("sessions").join("s1-title");
    let project = tmp.join("projects").join("p1-proj");
    std::fs::create_dir_all(&session).expect("session dir");
    std::fs::create_dir_all(&project).expect("project dir");
    let store = Arc::new(Mutex::new(Store::open(&tmp.join("test.db")).expect("db")));
    Trees {
        store: Some(store),
        tmp,
        session,
        project,
    }
}

impl Drop for Trees {
    fn drop(&mut self) {
        // Close the store first — the Registry/FsHost that shared this Arc
        // were dropped before `t` (reverse declaration order), so this is the
        // last handle; only then can the directory be swept.
        drop(self.store.take());
        if let Err(e) = std::fs::remove_dir_all(&self.tmp) {
            eprintln!("TREES_DROP_FAILED {:?}: {e}", self.tmp);
        }
    }
}

fn host(t: &Trees) -> (Registry, Arc<FsHost>, u64) {
    let h = Arc::new(
        FsHost::new(
            &t.session,
            &t.project,
            None,
            t.store.clone().expect("store alive"),
        )
        .expect("host"),
    );
    let mut reg = Registry::with_eight();
    register_fs(&mut reg, h.clone());
    let epoch = reg.materialize().epoch;
    (reg, h, epoch)
}

fn ctx() -> ToolContext {
    ToolContext {
        thread_id: "t1".to_string(),
        call_id: "c1".to_string(),
        workspace_dir: PathBuf::from("/unused"),
    }
}

fn run(reg: &Registry, epoch: u64, input: serde_json::Value) -> ToolOutcome {
    reg.dispatch(
        &IncomingCall {
            name: "fs".to_string(),
            input,
            epoch,
        },
        &ctx(),
    )
}

fn ok_text(out: ToolOutcome) -> String {
    match out {
        ToolOutcome::Ok { preview, .. } => preview,
        other => panic!("expected ok, got: {other:?}"),
    }
}

// ── Win32 security helpers ───────────────────────────────────────────────────

/// `ACCESS_ALLOWED_ACE_TYPE` (0) from winnt.h — kept local so one constant
/// does not pull the whole `Win32_System_SystemServices` feature.
const ACE_TYPE_ACCESS_ALLOWED: u8 = 0;

/// 68 = `SECURITY_MAX_SID_SIZE`. 4-byte aligned: a SID carries `u32`
/// subauthorities, so the byte buffer handed to Win32 must be aligned.
#[repr(C, align(4))]
struct SidBuf([u8; 68]);

/// 4-byte aligned for the same reason: `ACL` is a u16-fieldded struct.
#[repr(C, align(4))]
struct AclBuf([u8; 512]);

fn wide(p: &Path) -> Vec<u16> {
    let mut v: Vec<u16> = p.as_os_str().encode_wide().collect();
    v.push(0);
    v
}

/// The Everyone (World) SID — the identity the explicit grant below is about.
fn world_sid() -> SidBuf {
    let mut sid = SidBuf([0; 68]);
    let mut len = 68u32;
    let ok = unsafe {
        CreateWellKnownSid(
            WinWorldSid,
            std::ptr::null_mut(),
            sid.0.as_mut_ptr().cast::<c_void>(),
            &mut len,
        )
    };
    assert_ne!(
        ok,
        0,
        "CreateWellKnownSid failed: {}",
        std::io::Error::last_os_error()
    );
    sid
}

/// Break inheritance from the directory and grant Everyone Full Control as
/// ONE explicit (non-inherited) ACE. This is exactly the security state a
/// rename-over swap destroys: the staged file would carry only the
/// directory-inherited descriptor instead.
fn grant_explicit_everyone_full(path: &Path) {
    let mut sid = world_sid();
    let mut acl = AclBuf([0; 512]);
    // SAFETY: both buffers are aligned and large enough for the content the
    // calls write; the path is a NUL-terminated wide string; the owner/group
    // out-params are documented NULL when those SIDs are not being set.
    unsafe {
        assert_ne!(
            InitializeAcl(acl.0.as_mut_ptr().cast::<ACL>(), 512, ACL_REVISION),
            0,
            "InitializeAcl failed: {}",
            std::io::Error::last_os_error()
        );
        assert_ne!(
            AddAccessAllowedAce(
                acl.0.as_mut_ptr().cast::<ACL>(),
                ACL_REVISION,
                FILE_ALL_ACCESS,
                sid.0.as_mut_ptr().cast::<c_void>()
            ),
            0,
            "AddAccessAllowedAce failed: {}",
            std::io::Error::last_os_error()
        );
        let rc = SetNamedSecurityInfoW(
            wide(path).as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            acl.0.as_ptr().cast::<ACL>(),
            std::ptr::null_mut(),
        );
        assert_eq!(rc, 0, "SetNamedSecurityInfoW failed with {rc}");
    }
}

/// Does the file carry an explicit (non-inherited) Everyone:FULL ACE? The
/// semantic read-back: after a correct swap the replaced file's descriptor —
/// this ACE included — is the survivor's descriptor.
fn has_explicit_everyone_full(path: &Path) -> bool {
    let mut owner: PSID = std::ptr::null_mut();
    let mut group: PSID = std::ptr::null_mut();
    let mut dacl: *mut ACL = std::ptr::null_mut();
    let mut sacl: *mut ACL = std::ptr::null_mut();
    let mut sd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
    // SAFETY: path is NUL-terminated wide; the five out-params are exactly
    // what the API fills; the returned descriptor is LocalFree'd below.
    let rc = unsafe {
        GetNamedSecurityInfoW(
            wide(path).as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            &mut owner,
            &mut group,
            &mut dacl,
            &mut sacl,
            &mut sd,
        )
    };
    assert_eq!(rc, 0, "GetNamedSecurityInfoW failed with {rc}");
    let mut sid = world_sid();
    let mut found = false;
    // SAFETY: `dacl` points into the descriptor owned by `sd` (freed after
    // the loop); GetAce returns interior pointers into that same ACL.
    unsafe {
        if !dacl.is_null() {
            for i in 0..(*dacl).AceCount {
                let mut ace: *mut c_void = std::ptr::null_mut();
                assert_ne!(
                    GetAce(dacl, u32::from(i), &mut ace),
                    0,
                    "GetAce failed: {}",
                    std::io::Error::last_os_error()
                );
                let hdr = ace.cast::<ACE_HEADER>();
                // Skip anything that is not a plain allow-ACE, then anything
                // the directory handed down (inherited), then any allow that
                // is not OUR grant (wrong SID or a narrower mask).
                if (*hdr).AceType != ACE_TYPE_ACCESS_ALLOWED
                    || (*hdr).AceFlags & (INHERITED_ACE as u8) != 0
                {
                    continue;
                }
                let allow = ace.cast::<ACCESS_ALLOWED_ACE>();
                if (*allow).Mask != FILE_ALL_ACCESS {
                    continue;
                }
                let ace_sid = std::ptr::addr_of_mut!((*allow).SidStart).cast::<c_void>();
                if EqualSid(ace_sid, sid.0.as_mut_ptr().cast::<c_void>()) != 0 {
                    found = true;
                }
            }
        }
        LocalFree(sd);
    }
    found
}

// ── the tests ────────────────────────────────────────────────────────────────

#[test]
fn stage_write_keeps_the_targets_explicit_dacl() {
    // THE audit-11 test (D34/D128): `stage_write` over a target with a
    // protected, explicitly narrowed DACL. Rename-over (MoveFileExW
    // MOVEFILE_REPLACE_EXISTING) destroys the target's descriptor and the
    // survivor carries the staged file's directory-inherited one — so this
    // explicit ACE vanishes while the content changes happily.
    let t = trees();
    let (reg, _, epoch) = host(&t);
    let target = t.session.join("acl.txt");
    std::fs::write(&target, "old").expect("seed");
    grant_explicit_everyone_full(&target);
    // Precondition: the grant really landed — a later absence then means the
    // SWAP dropped the ACE, not that the setup never put it there.
    assert!(
        has_explicit_everyone_full(&target),
        "precondition: the seed file carries the explicit ACE"
    );

    let _ = ok_text(run(
        &reg,
        epoch,
        json!({"command": "write", "path": "acl.txt", "content": "new"}),
    ));

    assert_eq!(
        std::fs::read_to_string(&target).expect("read"),
        "new",
        "content must change"
    );
    assert!(
        has_explicit_everyone_full(&target),
        "the explicit (non-inherited) Everyone:FULL ACE must survive the swap — D34/D128"
    );
    // The swap must not leave staging litter either (audit 11 NIT, and
    // ReplaceFileW has its own partial-failure states to not litter in).
    let leftovers: Vec<String> = std::fs::read_dir(&t.session)
        .expect("list")
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with(".tmp-"))
        .collect();
    assert!(leftovers.is_empty(), "no staging leftovers: {leftovers:?}");
}

#[test]
fn stage_write_keeps_attributes_and_named_streams() {
    // The other two halves of the replaced file's identity (D128): file
    // attributes (HIDDEN — ARCHIVE would tautologically pass, both files get
    // it by default) and a named stream the staged file does not have.
    let t = trees();
    let (reg, _, epoch) = host(&t);
    let target = t.session.join("meta.txt");
    std::fs::write(&target, "old").expect("seed");
    let w = wide(&target);
    // SAFETY: NUL-terminated wide path, no out-params.
    unsafe {
        assert_ne!(
            SetFileAttributesW(w.as_ptr(), FILE_ATTRIBUTE_HIDDEN),
            0,
            "SetFileAttributesW failed: {}",
            std::io::Error::last_os_error()
        );
    }
    // A named stream beside the unnamed $DATA stream.
    std::fs::write(t.session.join("meta.txt:extra"), "ads-data").expect("seed ADS");
    // Precondition guard: if the ADS never became readable, the post-swap
    // assertion below would prove nothing about the swap.
    assert_eq!(
        std::fs::read_to_string(t.session.join("meta.txt:extra")).expect("ADS seed readable"),
        "ads-data"
    );

    let _ = ok_text(run(
        &reg,
        epoch,
        json!({"command": "write", "path": "meta.txt", "content": "new"}),
    ));

    assert_eq!(
        std::fs::read_to_string(&target).expect("read"),
        "new",
        "content must change"
    );
    // SAFETY: same NUL-terminated path; the returned attribute set is a plain
    // DWORD (u32::MAX == INVALID_FILE_ATTRIBUTES == failure).
    let attrs = unsafe { GetFileAttributesW(w.as_ptr()) };
    assert_ne!(attrs, u32::MAX, "GetFileAttributesW failed");
    assert_ne!(
        attrs & FILE_ATTRIBUTE_HIDDEN, 0,
        "HIDDEN must survive the swap — replaced-file attributes are merged onto the replacement (D128)"
    );
    assert_eq!(
        std::fs::read_to_string(t.session.join("meta.txt:extra")).expect("ADS readable"),
        "ads-data",
        "named streams of the replaced file must survive the swap (D128)"
    );
}
