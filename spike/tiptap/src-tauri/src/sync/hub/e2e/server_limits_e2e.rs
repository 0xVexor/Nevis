//! Regressions found by a bug hunt, included from the `e2e` module of sync/hub.rs: a second account with the same vault id,
//! a server that rate-limits a big first sync, and downloads on a slow link. The first two need a server (ignored unless
//! asked for, like the rest of this module); the transfer tests use a small fake server and always run.
//! Run: NEVIS_TEST_SERVER=http://127.0.0.1:3142 cargo test server_limits -- --ignored --test-threads=1 --nocapture
use super::*;
use std::io::{Read, Write};
use std::time::{Duration, Instant};

/// The same vault id in a second account (a copied workspace folder synced by someone else, or the person accepting
/// "Send this workspace to this account" after signing in with another account on the same server): the sync pauses with
/// VAULT_TAKEN (nothing in the cloud is touched), and a new identity lets the workspace go up as a new one.
#[test]
#[ignore]
fn server_limits_same_vault_id_in_a_second_account_pauses_and_a_new_id_gets_it_going() {
    let id = uuid::Uuid::new_v4().to_string();
    let mut a = Dev::new(&signup(), &id);
    a.save(P1, "alice's page", 100);
    a.sync();
    let token_b = signup();
    let mut b = Dev::new(&token_b, &id); // the same folder (same vault id) synced by another account
    b.save(P2, "bob's page", 100);
    for round in 0..2 {
        assert_eq!(b.try_sync().map(|_| ()).unwrap_err(), VAULT_TAKEN, "round {round}");
    }
    // what `sync_new_identity` does to b's own folder: same files, another id, fresh bookkeeping
    let new_id = uuid::Uuid::new_v4().to_string();
    let root = b.vault.root.clone();
    crate::sync_app::rewrite_marker_id(&root, &id, &new_id).unwrap();
    b.vault = Vault::open_as(root, &new_id).unwrap();
    b.state = SyncState::default();
    b.id = new_id.clone();
    assert!(b.sync().uploaded >= 1);
    assert_eq!(b.page(P2).unwrap()["title"], "bob's page");
    assert!(b.try_sync().unwrap().errors.is_empty());
    let mut b_again = Dev::new(&token_b, &new_id); // another device of bob's gets it under the new id
    b_again.sync();
    assert_eq!(b_again.titles(), vec!["bob's page"]);
    assert!(a.sync().uploaded == 0 && a.titles() == vec!["alice's page"], "the first account's workspace is untouched");
}

/// The per-device limit is 1500 requests per minute and the server says how long to wait: a first sync of a big workspace
/// (2 requests per file) slows down instead of ending with errors and held deletions.
#[test]
#[ignore]
fn server_limits_a_first_sync_of_a_big_workspace_does_not_end_in_rate_limit_errors() {
    let id = uuid::Uuid::new_v4().to_string();
    let mut a = Dev::new(&signup(), &id);
    a.api = Api::new(&server(), a.api.token.clone()).unwrap(); // the patient client the app uses on a first round
    let pages: Vec<Value> = (0..900).map(|i| json!({ "id": format!("{:08x}-0000-4000-8000-000000000000", i), "title": format!("p{i}"), "content": {"type":"doc","content":[]}, "updatedAt": 100, "deletedAt": null })).collect();
    a.vault.save_pages(&pages, &[], false).unwrap();
    let started = Instant::now();
    let rep = a.try_sync().unwrap();
    let limited = rep.errors.iter().filter(|e| e.contains("rate_limited") || e.contains("http_429")).count();
    eprintln!("first round: {:?}, uploaded {}, {} errors ({limited} rate limited), e.g. {:?}", started.elapsed(), rep.uploaded, rep.errors.len(), rep.errors.first());
    assert!(rep.errors.is_empty(), "{limited} files failed with 429 in the first round");
}

// ───── downloads on slow links (a fake server) ─────

const FILE: &str = "files/ab/big";

fn remote_file() -> crate::sync::RemoteFile {
    crate::sync::RemoteFile { id: format!("1:{FILE}"), path: FILE.into(), md5: String::new(), modified_ms: 0 }
}

fn hub_for(base: &str, json: Duration, idle: Duration) -> Hub {
    let api = Api::new(base, Some("nvs_".to_string() + &"x".repeat(30))).unwrap().with_timeouts(json, idle);
    Hub::new(api, "v", Cache::default())
}

/// Serves every connection with `answer(request text, stream)` on its own thread.
fn fake_server(answer: impl Fn(String, std::net::TcpStream) + Send + Sync + 'static) -> String {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let answer = std::sync::Arc::new(answer);
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let answer = answer.clone();
            std::thread::spawn(move || {
                let mut s = stream;
                let mut buf = [0; 4096];
                let n = s.read(&mut buf).unwrap_or(0);
                answer(String::from_utf8_lossy(&buf[..n]).to_string(), s);
            });
        }
    });
    base
}

/// A steady download takes longer than the limit for a whole small request, and is not cut off for that.
#[test]
fn server_limits_a_slow_but_steady_download_is_not_cut_off_by_the_request_timeout() {
    const SIZE: usize = 80 << 10;
    let base = fake_server(|_, mut s| {
        let _ = write!(s, "HTTP/1.1 200 OK\r\nContent-Length: {SIZE}\r\n\r\n");
        for _ in 0..SIZE / 4096 {
            if s.write_all(&[7u8; 4096]).is_err() {
                return;
            }
            std::thread::sleep(Duration::from_millis(150)); // 3 s in all
        }
    });
    let mut hub = hub_for(&base, Duration::from_secs(1), Duration::from_secs(2));
    let started = Instant::now();
    let got = hub.download(&remote_file());
    assert!(started.elapsed() > Duration::from_secs(2), "the test must outlast the JSON timeout");
    assert_eq!(got.map(|b| b.len()), Ok(SIZE));
}

/// A download that stops receiving anything is given up on after the idle time, as "network" (the person's link, not the file).
#[test]
fn server_limits_a_stalled_download_gives_up_after_the_idle_time() {
    let base = fake_server(|_, mut s| {
        let _ = write!(s, "HTTP/1.1 200 OK\r\nContent-Length: 100000\r\n\r\n");
        let _ = s.write_all(&[1u8; 10_000]);
        std::thread::sleep(Duration::from_secs(60));
    });
    let mut hub = hub_for(&base, Duration::from_secs(1), Duration::from_secs(1));
    let started = Instant::now();
    let err = hub.download(&remote_file()).unwrap_err();
    assert!(is_network(&err) && !err.contains("127.0.0.1"), "{err}");
    assert!(started.elapsed() < Duration::from_secs(15), "{:?}", started.elapsed());
}

/// A download that broke off halfway continues where it stopped when the server can do ranges, and the result is checked.
#[test]
fn server_limits_a_broken_download_continues_with_a_range_and_is_checked() {
    use md5::Md5;
    let data: Vec<u8> = (0..60_000u32).map(|i| (i % 251) as u8).collect();
    let served = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let (d, log) = (data.clone(), served.clone());
    let base = fake_server(move |req, mut s| {
        let from = req.to_lowercase().split("range: bytes=").nth(1).and_then(|r| r.split('-').next()?.parse::<usize>().ok());
        log.lock().unwrap().push(format!("{from:?}"));
        match from {
            Some(f) => {
                let _ = write!(s, "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {f}-{}/{}\r\nContent-Length: {}\r\n\r\n", d.len() - 1, d.len(), d.len() - f);
                let _ = s.write_all(&d[f..]);
            }
            None => {
                let _ = write!(s, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", d.len());
                let _ = s.write_all(&d[..25_000]); // then the connection closes: the body is short
            }
        }
    });
    let mut hub = hub_for(&base, Duration::from_secs(5), Duration::from_secs(5));
    let mut f = remote_file();
    f.md5 = hex(&Md5::digest(&data));
    assert_eq!(hub.download(&f), Ok(data));
    assert_eq!(*served.lock().unwrap(), vec!["None".to_string(), "Some(25000)".to_string()]);
}

/// A server that ignores `Range` answers everything again: that replaces the part instead of being glued to it.
#[test]
fn server_limits_a_server_without_ranges_is_restarted_from_the_beginning() {
    let data: Vec<u8> = (0..40_000u32).map(|i| (i % 253) as u8).collect();
    let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let (d, n) = (data.clone(), calls.clone());
    let base = fake_server(move |_, mut s| {
        let first = n.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0;
        let _ = write!(s, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", d.len());
        let _ = s.write_all(if first { &d[..10_000] } else { &d });
    });
    let mut hub = hub_for(&base, Duration::from_secs(5), Duration::from_secs(5));
    assert_eq!(hub.download(&remote_file()), Ok(data));
}
