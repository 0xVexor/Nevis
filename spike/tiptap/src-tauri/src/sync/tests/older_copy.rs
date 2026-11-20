//! An older copy of the workspace folder (same vault id) is synced, and symlinks under the synced folders.
//! Included from the `tests` module of sync/mod.rs. Run: cargo test older_copy -- --nocapture
use super::*;

fn copy_dir(from: &Path, to: &Path) {
    fs::create_dir_all(to).unwrap();
    for e in fs::read_dir(from).unwrap().flatten() {
        let (src, dst) = (e.path(), to.join(e.file_name()));
        if e.file_type().unwrap().is_dir() {
            copy_dir(&src, &dst);
        } else {
            fs::copy(&src, &dst).unwrap();
        }
    }
}

fn attachment(d: &Device, content: &[u8]) -> String {
    let id = crate::vault::sha256_hex(content);
    d.vault.file_put(&id, content, "image/png", "pic.png", 1).unwrap();
    id
}

/// BH4: a copy of the workspace folder (same vault id) taken earlier and opened later — "Open folder" on a backup, a
/// copy-pasted folder — is synced with the bookkeeping of the original (one state file per vault id; `local_root` is
/// informational). Everything that happened after the copy was taken is then misread:
/// - a page another device deleted since then has no base any more and no tombstone in the copy: it is uploaded again
///   (resurrected everywhere), and `find_resurrected` does not look because the bookkeeping is not empty;
/// - an attachment added since then is "deleted here, untouched elsewhere": it is trashed in the cloud and then on every
///   other device, without being held (attachments are not tombstone-gated and the count is under the threshold).
#[test]
fn bh4_an_older_copy_of_the_folder_with_the_same_id_neither_resurrects_nor_deletes() {
    let (mut a, mut b) = pair();
    a.save(P1, "kept", 100);
    a.save(P2, "deleted later", 100);
    for i in 0..6 {
        a.save(&format!("3333333{i}-3333-4333-8333-333333333333"), "filler", 100);
    }
    a.sync();
    b.sync();
    // the copy is taken now
    let copy_root = a.vault.root.with_file_name(format!("{}-copy", a.vault.root.file_name().unwrap().to_string_lossy()));
    copy_dir(&a.vault.root, &copy_root);
    // life goes on in the original: a page is deleted the app's way, an image is added to a page
    a.vault.save_pages(&[], &[P2.to_string()], false).unwrap();
    let img = attachment(&a, b"\x89PNG a picture added after the copy");
    a.save(P1, "kept, now with the picture", 200);
    a.sync();
    b.sync();
    assert!(b.page(P2).is_none(), "precondition: the deletion reached b");
    let img_rel = format!("files/{}/{}", &img[..2], img);
    assert!(b.vault.root.join(&img_rel).exists(), "precondition: the picture reached b");

    // the person opens the copy (same id: the registry entry and the state file are the original's) and syncs it
    let mut copy = Device { vault: Vault::open_as(copy_root.clone(), &a.vault.id()).unwrap(), state: a.state.clone(), remote: a.remote.clone(), ps: false };
    drop(a);
    let rep = copy.try_sync().unwrap();
    eprintln!("copy round: {rep:?}");
    b.sync();
    let remote = remote_paths(&b.remote);
    let mut problems = vec![];
    if remote.iter().any(|p| p == &format!("pages/{P2}.json")) || b.page(P2).is_some() {
        problems.push("the page deleted on another device came back everywhere");
    }
    if !remote.iter().any(|p| p == &img_rel) {
        problems.push("the picture added after the copy was trashed in the cloud");
    }
    if !b.vault.root.join(&img_rel).exists() {
        problems.push("the picture is gone from the other device too (only its sync trash has it)");
    }
    assert!(problems.is_empty(), "{problems:?}; copy report: held={} deleted={} uploaded={}", rep.held, rep.deleted, rep.uploaded);
}

/// BH4b: as BH4, but the picture was added with a NEW page (no page that both copies have was edited, so nothing looks
/// like a restore). The new page is held (tombstone rule), the picture is not: it is trashed in the cloud and on the
/// other device, whose copy of the new page now shows a broken image.
#[test]
fn bh4b_an_older_copy_does_not_trash_a_picture_of_a_page_made_after_it() {
    let (mut a, mut b) = pair();
    a.save(P1, "kept", 100);
    for i in 0..6 {
        a.save(&format!("3333333{i}-3333-4333-8333-333333333333"), "filler", 100);
    }
    a.sync();
    b.sync();
    let copy_root = a.vault.root.with_file_name(format!("{}-copy", a.vault.root.file_name().unwrap().to_string_lossy()));
    copy_dir(&a.vault.root, &copy_root);
    let img = attachment(&a, b"\x89PNG a picture of a new page");
    a.save(P2, "new page with the picture", 200);
    a.sync();
    b.sync();
    let img_rel = format!("files/{}/{}", &img[..2], img);
    assert!(b.vault.root.join(&img_rel).exists() && b.page(P2).is_some(), "precondition");
    let mut copy = Device { vault: Vault::open_as(copy_root.clone(), &a.vault.id()).unwrap(), state: a.state.clone(), remote: a.remote.clone(), ps: false };
    drop(a);
    let rep = copy.try_sync().unwrap();
    eprintln!("copy round: {rep:?}");
    b.sync();
    let gone_remote = !remote_paths(&b.remote).iter().any(|p| p == &img_rel);
    let gone_on_b = !b.vault.root.join(&img_rel).exists();
    assert!(!gone_remote && !gone_on_b, "picture trashed in the cloud: {gone_remote}, gone on the other device: {gone_on_b}, while its page P2 still exists on b: {}", b.page(P2).is_some());
}

/// A move of the folder (the old one is gone) keeps the bookkeeping: a page deleted here and not yet synced stays deleted.
#[test]
fn a_moved_folder_keeps_its_bookkeeping() {
    let (mut a, mut b) = pair();
    a.save(P1, "kept", 100);
    a.save(P2, "deleted here", 100);
    a.sync();
    b.sync();
    a.vault.save_pages(&[], &[P2.to_string()], false).unwrap();
    let new_root = a.vault.root.with_file_name(format!("{}-moved", a.vault.root.file_name().unwrap().to_string_lossy()));
    let id = a.vault.id();
    let old = a.vault.root.clone();
    drop(a.vault);
    fs::rename(&old, &new_root).unwrap();
    let mut moved = Device { vault: Vault::open_as(new_root, &id).unwrap(), state: a.state.clone(), remote: a.remote.clone(), ps: false };
    moved.sync();
    b.sync();
    assert!(b.page(P2).is_none() && moved.page(P2).is_none(), "the deletion made before the move must still be synced");
    assert!(b.page(P1).is_some());
}

/// A symlink under a synced folder is left alone (reported, never followed) and does not stop the sync of the rest.
#[cfg(unix)]
#[test]
fn a_symlink_is_skipped_not_fatal() {
    let (mut a, mut b) = pair();
    a.save(P1, "kept", 100);
    let outside = a.vault.root.with_file_name("outside-target.txt");
    fs::write(&outside, b"secret").unwrap();
    std::os::unix::fs::symlink(&outside, a.vault.root.join("files/link.bin")).unwrap();
    std::os::unix::fs::symlink(a.vault.root.parent().unwrap(), a.vault.root.join("kv/dirlink")).unwrap();
    let rep = a.try_sync().unwrap();
    assert!(rep.errors.is_empty(), "{:?}", rep.errors);
    assert!(rep.skipped_paths.contains(&"files/link.bin".to_string()) && rep.skipped_paths.contains(&"kv/dirlink".to_string()), "{:?}", rep.skipped_paths);
    assert!(!remote_paths(&a.remote).iter().any(|p| p.contains("link")), "a symlink must not travel");
    b.sync();
    assert!(b.page(P1).is_some());
    let _ = fs::remove_file(outside);
}
