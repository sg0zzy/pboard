//! `--check-config` must be a dry run.
//!
//! The defect these cover: the binary used to build the [`pboard_signaling::App`]
//! — which opens the operation log and runs the schema migration — *before*
//! looking at its argument, so a pre-flight check against a production data
//! directory created `sync-log.db` when it was absent and upgraded it to the
//! current schema when it was not. Both are activations, and the second is worse
//! than it used to be: an older binary refuses a database whose schema it does
//! not know, so a check run silently made the deployed rollback path unusable.
//!
//! Each test therefore inspects the filesystem, not the process output.
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use pboard_signaling::sync_log::{SUPPORTED_SCHEMA_VERSION, SyncLogLimits};

/// A fresh directory. `label` only makes failures readable.
fn directory(label: &str) -> PathBuf {
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let unique = COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let path = std::env::temp_dir().join(format!(
        "pboard-check-config-{label}-{}-{nanos}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&path).expect("temporary directory");
    path
}

/// A valid deny-all grants file. `--check-config` requires it to exist and parse,
/// and nothing here depends on any room being authorized.
fn grants(label: &str) -> PathBuf {
    let path = directory(label).join("grants.json");
    std::fs::write(&path, br#"{"rooms":{}}"#).expect("grants file");
    path
}

/// Runs the binary with a clean environment: the host's own `PBOARD_SIGNALING_*`
/// and `RUST_LOG` values must not decide what these tests observe.
fn run(args: &[&str], envs: &[(&str, &OsStr)]) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_pboard-signaling"));
    command.args(args).env_clear();
    for (key, value) in envs {
        command.env(key, value);
    }
    command.output().expect("run binary")
}

fn check_config(grants: &Path, sync_dir: Option<&Path>) -> Output {
    let mut envs: Vec<(&str, &OsStr)> = vec![("PBOARD_SIGNALING_GRANTS", grants.as_os_str())];
    if let Some(directory) = sync_dir {
        envs.push(("PBOARD_SIGNALING_SYNC_DIR", directory.as_os_str()));
    }
    run(&["--check-config"], &envs)
}

/// Every entry of a directory, sorted, so "nothing was created" is an exact
/// comparison rather than a spot check for three filenames.
fn entries(path: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(path)
        .expect("read directory")
        .map(|entry| entry.expect("directory entry").file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

/// The version-1 schema, written out exactly as [`sync_log::SyncLog::migrate`]
/// creates it on a fresh file. This is the oldest shape a deployment can be in:
/// version 2 and 3 are the *later* steps, so a fixture at v1 is the one that
/// would suffer the most from a check that migrates.
const V1_SCHEMA: &str = "
    CREATE TABLE sync_schema (version INTEGER NOT NULL);
    CREATE TABLE board (
        board_id         TEXT PRIMARY KEY,
        next_seq         INTEGER NOT NULL,
        checkpoint_seq   INTEGER NOT NULL DEFAULT 0,
        checkpoint_epoch INTEGER NOT NULL DEFAULT 0,
        fence_epoch      INTEGER NOT NULL DEFAULT 0,
        retained_ops     INTEGER NOT NULL DEFAULT 0,
        retained_bytes   INTEGER NOT NULL DEFAULT 0,
        updated_at       INTEGER NOT NULL
    );
    CREATE TABLE operation (
        board_id         TEXT NOT NULL,
        seq              INTEGER NOT NULL,
        op_id            TEXT NOT NULL,
        actor_id         TEXT NOT NULL,
        protocol_version INTEGER NOT NULL,
        logical_clock    INTEGER NOT NULL,
        enqueued_at      INTEGER NOT NULL,
        payload          TEXT NOT NULL,
        PRIMARY KEY (board_id, seq)
    );
    CREATE UNIQUE INDEX operation_by_board_id ON operation (board_id, op_id);
    CREATE TABLE checkpoint (
        board_id      TEXT PRIMARY KEY,
        seq           INTEGER NOT NULL,
        epoch         INTEGER NOT NULL,
        snapshot_seq  INTEGER NOT NULL,
        drive_etag    TEXT NOT NULL,
        writer        TEXT NOT NULL,
        committed_at  INTEGER NOT NULL,
        stale         INTEGER NOT NULL
    );
    CREATE TABLE lease (
        board_id   TEXT PRIMARY KEY,
        holder     TEXT NOT NULL,
        epoch      INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
    );
    INSERT INTO sync_schema (version) VALUES (1);
";

/// Builds a schema-v1 `sync-log.db` (plus whatever WAL/SHM pair SQLite leaves
/// behind) and returns the database path.
///
/// The file is created with raw SQL rather than by `SyncLog::open`, because
/// opening is the migration: there is no supported way to ask this build for an
/// older file, which is precisely why the check must not open one.
fn v1_database(directory: &Path) -> PathBuf {
    let path = directory.join("sync-log.db");
    let connection = rusqlite::Connection::open(&path).expect("create v1 database");
    connection.execute_batch(V1_SCHEMA).expect("v1 schema");
    connection
        .execute_batch("PRAGMA journal_mode = WAL; PRAGMA wal_checkpoint(TRUNCATE);")
        .expect("wal");
    drop(connection);
    path
}

fn schema_version(path: &Path) -> i64 {
    let connection = rusqlite::Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
    )
    .expect("open for inspection");
    connection
        .query_row("SELECT COALESCE(MAX(version), 0) FROM sync_schema", [], |row| row.get(0))
        .expect("schema version")
}

fn tables(path: &Path) -> Vec<String> {
    let connection = rusqlite::Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
    )
    .expect("open for inspection");
    let mut statement = connection
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .expect("prepare");
    statement
        .query_map([], |row| row.get::<_, String>(0))
        .expect("query")
        .map(|name| name.expect("table name"))
        .collect()
}

fn has_column(path: &Path, table: &str, column: &str) -> bool {
    let connection = rusqlite::Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
    )
    .expect("open for inspection");
    let mut statement = connection
        .prepare("SELECT name FROM pragma_table_info(?1)")
        .expect("prepare");
    statement
        .query_map([table], |row| row.get::<_, String>(0))
        .expect("query")
        .any(|name| name.expect("column name") == column)
}

#[test]
fn check_config_does_not_create_the_operation_log() {
    let sync = directory("empty");
    let grants = grants("empty");
    assert_eq!(entries(&sync), Vec::<String>::new(), "fixture starts empty");

    let output = check_config(&grants, Some(&sync));

    assert!(
        output.status.success(),
        "check should pass: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        entries(&sync),
        Vec::<String>::new(),
        "a check must leave no sync-log.db, -wal or -shm behind"
    );
    assert!(!sync.join("sync-log.db").exists());
    assert!(!sync.join("sync-log.db-wal").exists());
    assert!(!sync.join("sync-log.db-shm").exists());
}

#[test]
fn check_config_leaves_an_old_schema_untouched() {
    let sync = directory("v1");
    let grants = grants("v1");
    let database = v1_database(&sync);

    assert_eq!(schema_version(&database), 1, "fixture is at schema version 1");
    let tables_before = tables(&database);
    assert_eq!(
        tables_before,
        vec!["board", "checkpoint", "lease", "operation", "sync_schema"],
        "fixture has exactly the v1 tables"
    );
    assert!(!has_column(&database, "checkpoint", "evidence_kind"));
    let bytes_before = std::fs::read(&database).expect("read database");
    let entries_before = entries(&sync);

    let output = check_config(&grants, Some(&sync));

    assert!(
        output.status.success(),
        "check should pass against an existing log: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    // Asserted before any inspection connection below, so this is about what the
    // check wrote and not about what the test's own reads may touch.
    assert_eq!(
        std::fs::read(&database).expect("read database"),
        bytes_before,
        "the database file must be byte-identical after a check"
    );
    assert_eq!(
        entries(&sync),
        entries_before,
        "a check must not add or remove any file beside the database"
    );
    // The production-safety property: an older binary must still be able to open
    // this file after a check has run, which is only true if the schema was not
    // upgraded behind its back.
    assert_eq!(
        schema_version(&database),
        1,
        "check must not migrate the shared schema version"
    );
    assert_eq!(tables(&database), tables_before, "check must not add tables");
    assert!(
        !has_column(&database, "checkpoint", "evidence_kind"),
        "check must not add the v3 checkpoint column"
    );

    // A control: opening the log the way startup does *does* migrate this file,
    // which is what makes the assertions above meaningful rather than vacuous.
    drop(pboard_signaling::sync_log::SyncLog::open(&database, SyncLogLimits::default()));
    assert_eq!(
        schema_version(&database),
        SUPPORTED_SCHEMA_VERSION,
        "control: opening the log migrates it, so a check that opened it would too"
    );
    // And a control on the fixture itself: the hand-written v1 DDL above must
    // still be what this build's v1 step creates, or the test would be proving
    // that a check leaves an imaginary database alone. Opening added exactly the
    // v3 and v4 tables, so the v1 table set came from the fixture, not from drift.
    let mut expected = tables_before.clone();
    expected.push("coverage".into());
    expected.push("migration_fence".into());
    expected.sort();
    assert_eq!(
        tables(&database),
        expected,
        "control: opening a v1 file adds the v3 and v4 tables"
    );
}

#[test]
fn check_config_reports_a_missing_sync_directory() {
    let grants = grants("missing");
    let sync = directory("missing").join("absent");

    let output = check_config(&grants, Some(&sync));

    assert_eq!(output.status.code(), Some(1), "a failing check must exit non-zero");
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("FAILED  sync directory"), "{stdout}");
    assert!(!sync.exists(), "the check must not create the directory either");
}

#[test]
fn check_config_parses_the_same_environment_as_startup() {
    let grants = grants("env");
    let sync = directory("env");

    for (name, value) in [
        ("PBOARD_SIGNALING_MAX_CONNECTIONS", "999999"),
        ("PBOARD_SIGNALING_BOARD_GRANTS", "yes"),
        ("PBOARD_SIGNALING_BIND", "0.0.0.0:8787"),
        ("PBOARD_SIGNALING_GOOGLE_IDENTITIES", "1"),
    ] {
        let mut envs: Vec<(&str, &OsStr)> = vec![
            ("PBOARD_SIGNALING_GRANTS", grants.as_os_str()),
            ("PBOARD_SIGNALING_SYNC_DIR", sync.as_os_str()),
            (name, OsStr::new(value)),
        ];
        if name == "PBOARD_SIGNALING_GOOGLE_IDENTITIES" {
            // Isolate the prerequisite rule from the rest of the environment.
            envs.push(("PBOARD_SIGNALING_BOARD_GRANTS", OsStr::new("0")));
        }
        let output = run(&["--check-config"], &envs);
        assert_eq!(output.status.code(), Some(1), "{name}={value} must be refused");
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(stdout.contains("FAILED"), "{name}={value}: {stdout}");
        assert_eq!(
            entries(&sync),
            Vec::<String>::new(),
            "{name}={value}: a failing check must still not create the log"
        );
    }
}

#[test]
fn usage_paths_have_scriptable_exit_codes() {
    let help = run(&["--help"], &[]);
    assert_eq!(help.status.code(), Some(0));
    let stdout = String::from_utf8_lossy(&help.stdout);
    assert!(stdout.contains("--check-config"), "{stdout}");
    assert!(stdout.contains("PBOARD_SIGNALING_SYNC_DIR"), "{stdout}");

    let unknown = run(&["--bogus"], &[]);
    assert_eq!(unknown.status.code(), Some(2), "usage errors are distinguishable");
    let stderr = String::from_utf8_lossy(&unknown.stderr);
    assert!(stderr.contains("usage: pboard-signaling"), "{stderr}");

    let missing = run(&["--check-config"], &[]);
    assert_eq!(missing.status.code(), Some(1), "a failed check exits 1");
}
