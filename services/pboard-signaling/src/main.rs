use pboard_signaling::google_enrollment::GoogleEnrollment;
use pboard_signaling::google_identity::GoogleDriveVerifier;
use pboard_signaling::{App, Config, Limits};
use std::io::ErrorKind;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::atomic::{AtomicU64, Ordering};

const USAGE: &str =
    "usage: pboard-signaling [--check-config | --help | --public-authority | --generate-authority PATH]";

/// Why the schema version is not read. Printed rather than passed over: an
/// operator must be able to tell "validated" from "could not validate".
const SKIPPED_SCHEMA: &str = "reading sync_schema requires opening sync-log.db, which creates it \
     and runs the schema migration; --check-config does not open the database";

/// Every limit `Limits::from_env` reads, printed by `--help`. Kept beside the
/// usage text rather than derived, because the parser is a macro over string
/// literals and has no runtime list to hand out.
const LIMIT_VARIABLES: [&str; 21] = [
    "MAX_CONNECTIONS",
    "MAX_PEERS_PER_ROOM",
    "MAX_ROOMS",
    "MAX_MESSAGE_BYTES",
    "MESSAGES_PER_SECOND",
    "BYTES_PER_SECOND",
    "MAX_SESSION_WINDOW_BYTES",
    "MAX_ROOM_WINDOW_BYTES",
    "MAX_SESSION_SIGNALS",
    "GLOBAL_MESSAGES_PER_SECOND",
    "GLOBAL_BYTES_PER_SECOND",
    "AUTH_PER_SECOND",
    "MAX_AUTHORIZATION_SCOPES",
    "HTTP_CONCURRENCY",
    "HTTP_PER_SECOND",
    "MAX_GRANT_BYTES",
    "MAX_GRANT_CACHE_BYTES",
    "MAX_GRANT_HISTORY",
    "MAX_REPLAY_ENTRIES",
    "AUTH_TIMEOUT_SECONDS",
    "IDLE_TIMEOUT_SECONDS",
];

/// What the operator asked the binary to do.
///
/// Parsed before anything else runs, so no argument — including a mistyped one —
/// can cause the operation log to be opened, created or migrated. `--check-config`
/// used to be decided only *after* the whole [`App`] was built, and building it
/// opened the database and ran the schema migration: a pre-flight check was an
/// activation.
enum Mode {
    Serve,
    CheckConfig,
    Help,
    PublicAuthority,
    GenerateAuthority(String),
}

impl Mode {
    fn parse(args: &[String]) -> Result<Self, String> {
        match args {
            [] => Ok(Self::Serve),
            [flag] if flag.as_str() == "--check-config" => Ok(Self::CheckConfig),
            [flag] if matches!(flag.as_str(), "--help" | "-h") => Ok(Self::Help),
            [flag] if flag.as_str() == "--public-authority" => Ok(Self::PublicAuthority),
            [flag, path] if flag.as_str() == "--generate-authority" => {
                Ok(Self::GenerateAuthority(path.clone()))
            }
            [flag, ..] if flag.as_str() == "--generate-authority" => {
                Err("--generate-authority takes exactly one path".into())
            }
            _ => Err(format!("unsupported arguments: {}", args.join(" "))),
        }
    }
}

#[tokio::main]
async fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mode = match Mode::parse(&args) {
        Ok(mode) => mode,
        Err(error) => {
            eprintln!("Error: {error}");
            eprintln!("{USAGE}");
            return ExitCode::from(2);
        }
    };
    match run(mode).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("Error: {error}");
            ExitCode::FAILURE
        }
    }
}

async fn run(mode: Mode) -> Result<(), Box<dyn std::error::Error>> {
    let public_authority = match mode {
        Mode::Help => {
            print_usage();
            return Ok(());
        }
        Mode::GenerateAuthority(path) => {
            generate_authority(Path::new(&path))?;
            return Ok(());
        }
        Mode::CheckConfig => return check_config(),
        Mode::Serve => false,
        Mode::PublicAuthority => true,
    };
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    // Everything below this line that touches a file is a read; the only writes
    // are the durable stores opened after `in_memory_app`, and those run only in
    // the serving mode. `--check-config` returned above, before any of it.
    let mut settings = Settings::from_env()?;
    if public_authority {
        let enrollment = settings
            .google
            .take()
            .ok_or("--public-authority requires PBOARD_SIGNALING_GOOGLE_EMAILS")?;
        println!("{}", serde_json::to_string(&enrollment.authority())?);
        return Ok(());
    }
    let bind = settings.bind;
    let mut app = settings.in_memory_app()?;
    // Durable WebSocket synchronization (Sync v3). Off unless a directory is
    // configured: acknowledging an operation the service cannot store is the one
    // failure mode this protocol is not allowed to have.
    if let Some(directory) = &settings.sync_dir {
        app = app.with_sync(directory)?;
        // One greppable line at startup, and its counterpart below. Without them,
        // a misspelled variable and a service started before the unit change were
        // indistinguishable from a working activation: the protocol simply stays
        // silent until a client asks for it, which is the worst time to discover it.
        tracing::info!(directory = %directory.display(), "operation log enabled");
    } else {
        tracing::info!("operation log disabled; set PBOARD_SIGNALING_SYNC_DIR to enable");
    }
    if let Some(directory) = &settings.buffer_dir {
        std::fs::create_dir_all(directory)?;
        app = app.with_op_buffer(directory)?;
    }
    let (stop, stop_signal) = tokio::sync::watch::channel(false);
    spawn_retention(&app, stop_signal);
    let listener = tokio::net::TcpListener::bind(bind).await?;
    tracing::info!(%bind, "signaling service listening");
    let shutdown_app = app.clone();
    axum::serve(listener, app.router())
        .with_graceful_shutdown(async move {
            #[cfg(unix)]
            {
                let mut term =
                    tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                        .expect("signal handler");
                tokio::select! { _=tokio::signal::ctrl_c()=>{}, _=term.recv()=>{} }
            }
            #[cfg(not(unix))]
            {
                let _ = tokio::signal::ctrl_c().await;
            }
            shutdown_app.shutdown();
            // Told rather than merely killed: a pass in flight is one SQLite
            // transaction, and letting it finish is why the sweeper is stopped
            // here rather than left to the runtime tearing the task down.
            let _ = stop.send(true);
        })
        .await?;
    Ok(())
}

fn print_usage() {
    println!("{USAGE}");
    println!();
    println!("Modes:");
    println!("  --check-config        validate configuration and environment, then exit;");
    println!("                        never opens, creates or migrates the operation log");
    println!("  --help, -h            print this message and exit 0");
    println!("  --public-authority    print the configured Google authority public JWK and exit");
    println!("  --generate-authority PATH");
    println!("                        create a new authority key at PATH (mode 0600) and exit");
    println!("  (no arguments)        serve");
    println!();
    println!("Exit codes: 0 success, 1 configuration/runtime failure, 2 usage error.");
    println!();
    println!("Environment:");
    println!("  PBOARD_SIGNALING_GRANTS               grants file (required)");
    println!("  PBOARD_SIGNALING_BIND                 listener address, default 127.0.0.1:8787");
    println!("  PBOARD_SIGNALING_SYNC_DIR             durable operation log directory");
    println!("  PBOARD_SIGNALING_BUFFER_DIR           legacy op buffer directory");
    println!("  PBOARD_SIGNALING_AUTOMATIC_ADMISSION  0 or 1");
    println!("  PBOARD_SIGNALING_BOARD_GRANTS         0 or 1");
    println!("  PBOARD_SIGNALING_GOOGLE_EMAILS        comma-separated verifier email allowlist");
    println!("  PBOARD_SIGNALING_GOOGLE_IDENTITIES    0 or 1");
    println!("  PBOARD_SIGNALING_AUTHORITY_KEY        raw 32-byte authority key file");
    println!("  PBOARD_SIGNALING_ENROLLMENT_STATE     enrollment registry state file");
    println!("  PBOARD_SIGNALING_REQUIRE_TLS_PROXY    0 or 1");
    println!("  PBOARD_SIGNALING_ALLOW_LOOPBACK_ORIGINS  0 or 1");
    println!("  PBOARD_SIGNALING_ALLOWED_ORIGINS      comma-separated https origins");
    println!("  RUST_LOG                              tracing filter");
    println!();
    println!("Resource limits (see src/policy.rs for bounds):");
    for names in LIMIT_VARIABLES.chunks(4) {
        let line: Vec<String> = names.iter().map(|name| format!("PBOARD_SIGNALING_{name}")).collect();
        println!("  {}", line.join(", "));
    }
    #[cfg(any(test, feature = "test-google-fixture"))]
    println!(
        "  PBOARD_TEST_GOOGLE_BASE, PBOARD_TEST_MANIFEST_LIFETIME_MS (local fixture build only)"
    );
}

fn generate_authority(path: &Path) -> std::io::Result<()> {
    use p256::elliptic_curve::rand_core::OsRng;
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let key = p256::ecdsa::SigningKey::random(&mut OsRng);
    let mut file = options.open(path)?;
    file.write_all(&key.to_bytes())?;
    file.sync_all()
}

fn grants_path() -> Result<PathBuf, String> {
    std::env::var("PBOARD_SIGNALING_GRANTS").map(PathBuf::from).map_err(|_| {
        "PBOARD_SIGNALING_GRANTS must name an operator-approved grants file".to_string()
    })
}

fn read_config(path: &Path) -> Result<Config, String> {
    let bytes = std::fs::read(path).map_err(|error| format!("{}: {error}", path.display()))?;
    serde_json::from_slice(&bytes).map_err(|error| format!("{}: {error}", path.display()))
}

fn env_flag(name: &str) -> Result<bool, String> {
    match std::env::var(name).as_deref() {
        Ok("1") => Ok(true),
        Ok("0") | Err(std::env::VarError::NotPresent) => Ok(false),
        _ => Err(format!("{name} must be 0 or 1")),
    }
}

/// Builds the Google enrollment verifier, which reads the authority key and the
/// enrollment registry state file. Both are reads; nothing here writes.
fn google_enrollment() -> Result<Option<GoogleEnrollment>, String> {
    let Ok(emails) = std::env::var("PBOARD_SIGNALING_GOOGLE_EMAILS") else {
        return Ok(None);
    };
    let key_path = std::env::var("PBOARD_SIGNALING_AUTHORITY_KEY").map_err(|_| {
        "PBOARD_SIGNALING_AUTHORITY_KEY must name the authority key file".to_string()
    })?;
    let key_bytes = std::fs::read(&key_path).map_err(|error| format!("{key_path}: {error}"))?;
    let key = p256::ecdsa::SigningKey::from_slice(&key_bytes)
        .map_err(|_| format!("{key_path}: not a raw 32-byte P-256 signing key"))?;
    let state = std::env::var("PBOARD_SIGNALING_ENROLLMENT_STATE").map_err(|_| {
        "PBOARD_SIGNALING_ENROLLMENT_STATE must name the enrollment registry file".to_string()
    })?;
    let enrollment = GoogleEnrollment::new(
        key,
        emails.split(',').map(str::to_owned).collect(),
        state.into(),
    )
    .map_err(str::to_string)?;
    #[cfg(feature = "test-google-fixture")]
    let enrollment = if let Ok(base) = std::env::var("PBOARD_TEST_GOOGLE_BASE") {
        enrollment.with_test_google_base(base)?
    } else {
        enrollment
    };
    #[cfg(feature = "test-google-fixture")]
    let enrollment = if let Ok(ms) = std::env::var("PBOARD_TEST_MANIFEST_LIFETIME_MS") {
        enrollment.with_test_lifetime(ms.parse().map_err(|_| {
            "PBOARD_TEST_MANIFEST_LIFETIME_MS must be an integer".to_string()
        })?)?
    } else {
        enrollment
    };
    Ok(Some(enrollment))
}

/// Explicit opt-in; public OAuth client IDs are configuration, not secrets.
fn google_drive_verifier() -> Result<Option<GoogleDriveVerifier>, String> {
    let Ok(audiences) = std::env::var("PBOARD_SIGNALING_GOOGLE_AUDIENCES") else { return Ok(None) };
    let ids = audiences.split(',').map(|id| id.trim().to_owned()).collect();
    GoogleDriveVerifier::new(ids).map(Some).map_err(str::to_string)
}

fn bind_address() -> Result<SocketAddr, String> {
    let raw = std::env::var("PBOARD_SIGNALING_BIND").unwrap_or_else(|_| "127.0.0.1:8787".into());
    let bind: SocketAddr = raw
        .parse()
        .map_err(|_| format!("PBOARD_SIGNALING_BIND={raw} is not an IP:port address"))?;
    if !bind.ip().is_loopback() {
        return Err("bind must be loopback; use a TLS reverse proxy".into());
    }
    Ok(bind)
}

/// Everything the service derives from its environment *before* a durable store
/// exists. Constructing this touches only files it reads.
struct Settings {
    config: Config,
    limits: Limits,
    policy: pboard_signaling::policy::TransportPolicy,
    automatic: bool,
    board_grants: bool,
    identity: bool,
    google: Option<GoogleEnrollment>,
    google_drive: Option<GoogleDriveVerifier>,
    sync_dir: Option<PathBuf>,
    buffer_dir: Option<PathBuf>,
    /// Defaulted when unusable; the `bind address` check reports that
    /// separately, so one bad variable is not counted twice.
    bind: SocketAddr,
}

impl Settings {
    fn from_env() -> Result<Self, String> {
        let config = read_config(&grants_path()?)?;
        let automatic = env_flag("PBOARD_SIGNALING_AUTOMATIC_ADMISSION")?;
        let limits = Limits::from_env().map_err(str::to_string)?;
        let policy =
            pboard_signaling::policy::TransportPolicy::from_env().map_err(str::to_string)?;
        let board_grants = env_flag("PBOARD_SIGNALING_BOARD_GRANTS")?;
        let google = google_enrollment()?;
        let google_drive = google_drive_verifier()?;
        let identity = env_flag("PBOARD_SIGNALING_GOOGLE_IDENTITIES")?;
        if identity && (!board_grants || google.is_none()) {
            return Err(
                "Google identity enrollment requires board grants and a configured identity verifier"
                    .into(),
            );
        }
        Ok(Self {
            config,
            limits,
            policy,
            automatic,
            board_grants,
            identity,
            google,
            google_drive,
            sync_dir: std::env::var("PBOARD_SIGNALING_SYNC_DIR").ok().map(PathBuf::from),
            buffer_dir: std::env::var("PBOARD_SIGNALING_BUFFER_DIR").ok().map(PathBuf::from),
            bind: bind_address().unwrap_or_else(|_| SocketAddr::from(([127, 0, 0, 1], 8787))),
        })
    }

    /// The service object without any durable store attached.
    ///
    /// Pure: [`App::new`] allocates and validates, it does not open a file. Only
    /// the serving path then calls `with_sync`/`with_op_buffer`, which are the
    /// calls that create and migrate the database. `&mut self` only because
    /// [`GoogleEnrollment`] is not `Clone` — the verifier is moved into the
    /// application rather than duplicated.
    fn in_memory_app(&mut self) -> Result<App, String> {
        let app = App::new(self.config.clone(), self.limits.clone())
            .map_err(str::to_string)?
            .with_transport_policy(self.policy.clone())
            .with_automatic_admission(self.automatic)
            .with_board_grants(self.board_grants)
            .with_identity_enrollment(self.identity);
        let app = match self.google.take() {
            Some(enrollment) => app.with_google_enrollment(enrollment),
            None => app,
        };
        let app = match self.google_drive.take() {
            Some(verifier) => app.with_google_drive_verifier(verifier),
            None => app,
        };
        app.validate_service_policy().map_err(str::to_string)?;
        Ok(app)
    }
}

/// Per-check tally for `--check-config`.
#[derive(Default)]
struct Checks {
    failed: usize,
    skipped: usize,
}

impl Checks {
    fn pass(&self, label: &str, detail: impl std::fmt::Display) {
        println!("ok      {label}: {detail}");
    }

    fn record<T>(
        &mut self,
        label: &str,
        result: Result<T, String>,
        detail: impl FnOnce(&T) -> String,
    ) -> Option<T> {
        match result {
            Ok(value) => {
                println!("ok      {label}: {}", detail(&value));
                Some(value)
            }
            Err(error) => {
                self.failed += 1;
                println!("FAILED  {label}: {error}");
                None
            }
        }
    }

    fn skip(&mut self, label: &str, detail: impl std::fmt::Display) {
        self.skipped += 1;
        println!("skipped {label}: {detail}");
    }
}

/// A directory the service will have to write into, proven writable without
/// opening the database: create one uniquely-named file and remove it again.
fn probe_writable(path: &Path) -> Result<(), String> {
    static PROBES: AtomicU64 = AtomicU64::new(0);
    let metadata =
        std::fs::metadata(path).map_err(|error| format!("{}: {error}", path.display()))?;
    if !metadata.is_dir() {
        return Err(format!("{} is not a directory", path.display()));
    }
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or(0);
    let probe = path.join(format!(
        ".pboard-check-config-{}-{nanos}-{}",
        std::process::id(),
        PROBES.fetch_add(1, Ordering::Relaxed)
    ));
    let file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)
        .map_err(|error| format!("{} is not writable: {error}", path.display()))?;
    drop(file);
    std::fs::remove_file(&probe)
        .map_err(|error| format!("{}: probe cleanup failed: {error}", path.display()))
}

/// Resolves whether a file the service will read is readable: `Ok(true)` when it
/// opens, `Ok(false)` when it is absent (a legitimate state for a file the
/// service creates on first write), `Err` when it exists but cannot be read.
fn probe_readable(path: &Path) -> Result<bool, String> {
    match std::fs::File::open(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("{}: {error}", path.display())),
    }
}

/// The pre-flight check. Validates the same environment and configuration the
/// serving path parses, and the filesystems it will need, but never opens the
/// operation log: opening it creates the file and runs the schema migration, so
/// a check would be indistinguishable from an activation — and to an older
/// binary, a database left at a newer schema is unreadable.
fn check_config() -> Result<(), Box<dyn std::error::Error>> {
    let mut checks = Checks::default();
    println!("pboard-signaling configuration check");

    let grants = checks.record("grants path", grants_path(), |path| path.display().to_string());
    let config = grants.and_then(|path| {
        checks.record("grants read", read_config(&path), |config| {
            format!("{} room(s)", config.rooms.len())
        })
    });
    let valid = match &config {
        Some(config) => checks
            .record("grant validity", config.validate().map_err(str::to_string), |_| {
                "all room structures and device keys valid".to_string()
            })
            .is_some(),
        None => {
            checks.skip("grant validity", "depends on a readable grants file");
            false
        }
    };

    let automatic = checks.record(
        "automatic admission",
        env_flag("PBOARD_SIGNALING_AUTOMATIC_ADMISSION"),
        |enabled| format!("{enabled}"),
    );
    let limits = checks.record("resource limits", Limits::from_env().map_err(str::to_string), |_| {
        "environment limits within bounds".to_string()
    });
    let policy = checks.record(
        "transport policy",
        pboard_signaling::policy::TransportPolicy::from_env().map_err(str::to_string),
        |policy| {
            format!(
                "require_tls_proxy={} allow_loopback_origins={} origins={}",
                policy.require_tls_proxy,
                policy.allow_loopback_origins,
                policy.allowed_origins.len()
            )
        },
    );
    let board_grants = checks.record(
        "board grants",
        env_flag("PBOARD_SIGNALING_BOARD_GRANTS"),
        |enabled| format!("{enabled}"),
    );
    let google = checks.record("google enrollment", google_enrollment(), |enrollment| {
        match enrollment {
            Some(_) => "authority key and enrollment state loaded".to_string(),
            None => "not configured".to_string(),
        }
    });
    let google_drive = checks.record("google drive verifier", google_drive_verifier(), |verifier| {
        if verifier.is_some() { "configured".to_string() } else { "not configured".to_string() }
    });
    let identity = checks.record(
        "google identities",
        env_flag("PBOARD_SIGNALING_GOOGLE_IDENTITIES"),
        |enabled| format!("{enabled}"),
    );
    // Same rule as startup, reported once: `identity` needs board grants *and* a
    // loaded verifier. When the verifier itself failed to load, that is already a
    // failure above, so this line defers to it rather than counting one cause twice.
    match (board_grants, google.as_ref(), identity) {
        (Some(board_grants), Some(google), Some(identity)) => {
            if identity && (!board_grants || google.is_none()) {
                checks.failed += 1;
                println!(
                    "FAILED  identity prerequisites: Google identity enrollment requires board \
                     grants and a configured identity verifier"
                );
            } else {
                checks.pass("identity prerequisites", format!("consistent (identity={identity})"));
            }
        }
        (_, None, _) => checks.skip(
            "identity prerequisites",
            "the google enrollment check failed, which is the same cause",
        ),
        _ => checks.skip("identity prerequisites", "depends on the checks that failed above"),
    }
    let bind = checks
        .record("bind address", bind_address(), |bind| format!("{bind} (loopback)"))
        .unwrap_or_else(|| SocketAddr::from(([127, 0, 0, 1], 8787)));

    // Paths the serving start will read before it accepts anything. Reported
    // separately from the enrollment load so an operator sees which file is
    // wrong, but not when that load already failed for the same file: one cause,
    // one failure. The enrollment state file is legitimately absent until the
    // first enrollment is written, so absence is reported, not failed.
    for (label, variable) in [
        ("authority key", "PBOARD_SIGNALING_AUTHORITY_KEY"),
        ("enrollment state", "PBOARD_SIGNALING_ENROLLMENT_STATE"),
    ] {
        match (google.is_some(), std::env::var(variable)) {
            (false, _) => checks.skip(label, "already reported by the google enrollment check"),
            (true, Ok(path)) => {
                let path = PathBuf::from(path);
                checks.record(label, probe_readable(&path), |present| match present {
                    true => format!("{} readable", path.display()),
                    false => format!("{} absent; the serving start will create it", path.display()),
                });
            }
            (true, Err(_)) => checks.skip(label, format!("{variable} is not set")),
        }
    }

    // The same object startup builds, minus the durable stores. Every failed input
    // above leaves a hole here, so this reports one failure rather than repeating
    // the ones already printed.
    if let (true, Some(config), Some(limits), Some(policy), Some(automatic)) =
        (valid, config, limits, policy, automatic)
    {
        let mut settings = Settings {
            config,
            limits,
            policy,
            automatic,
            board_grants: board_grants.unwrap_or(false),
            identity: identity.unwrap_or(false),
            google: google.unwrap_or(None),
            google_drive: google_drive.unwrap_or(None),
            sync_dir: None,
            buffer_dir: None,
            bind,
        };
        checks.record("service policy", settings.in_memory_app().map(|_| ()), |_| {
            "in-memory application accepts the configuration".to_string()
        });
    } else {
        checks.skip("service policy", "depends on the checks that failed above");
    }

    match std::env::var("PBOARD_SIGNALING_SYNC_DIR") {
        Ok(directory) => {
            let directory = PathBuf::from(directory);
            let usable = checks
                .record(
                    "sync directory",
                    probe_writable(&directory),
                    |_| format!("{} exists and is writable", directory.display()),
                )
                .is_some();
            let database = directory.join("sync-log.db");
            // Metadata only: `fs::metadata` stats the path, it does not open the
            // SQLite file, so this distinguishes "will be created" from "will be
            // migrated" without performing either. Skipped when the directory
            // itself is unusable, so one cause produces one failure.
            match (usable, std::fs::metadata(&database)) {
                (false, _) => checks.skip("sync log", "the sync directory is not usable"),
                (true, Ok(metadata)) => checks.pass(
                    "sync log",
                    format!(
                        "{} present ({} bytes); not opened",
                        database.display(),
                        metadata.len()
                    ),
                ),
                (true, Err(error)) if error.kind() == ErrorKind::NotFound => checks.pass(
                    "sync log",
                    format!("{} absent; the serving start will create it", database.display()),
                ),
                (true, Err(error)) => {
                    checks.failed += 1;
                    println!("FAILED  sync log: {}: {error}", database.display());
                }
            }
            checks.skip("sync log schema", SKIPPED_SCHEMA);
        }
        Err(_) => checks.skip(
            "sync directory",
            "PBOARD_SIGNALING_SYNC_DIR is not set; durable sync is disabled",
        ),
    }
    match std::env::var("PBOARD_SIGNALING_BUFFER_DIR") {
        Ok(directory) => {
            let directory = PathBuf::from(directory);
            if directory.exists() {
                checks.record(
                    "buffer directory",
                    probe_writable(&directory),
                    |_| format!("{} exists and is writable", directory.display()),
                );
            } else {
                let parent = directory
                    .parent()
                    .filter(|parent| !parent.as_os_str().is_empty())
                    .unwrap_or(Path::new("."));
                checks.record(
                    "buffer directory",
                    probe_writable(parent),
                    |_| {
                        format!(
                            "{} absent; {} is writable so it can be created at startup",
                            directory.display(),
                            parent.display()
                        )
                    },
                );
            }
        }
        Err(_) => checks.skip(
            "buffer directory",
            "PBOARD_SIGNALING_BUFFER_DIR is not set; the legacy buffer is disabled",
        ),
    }

    // Aggregate parity: the per-check path above exists to report *every* problem
    // instead of dying on the first, which risks the two paths drifting apart.
    // Run the serving path's own environment parse once at the end, so "the check
    // passed" cannot mean "the check passed while startup would still refuse".
    match Settings::from_env() {
        Ok(_) => checks.pass("startup parity", "the serving path parses this environment"),
        Err(error) if checks.failed == 0 => {
            checks.failed += 1;
            println!("FAILED  startup parity: serving startup rejects this environment: {error}");
        }
        Err(_) => checks.skip(
            "startup parity",
            "serving startup rejects this environment for the reasons reported above",
        ),
    }

    if checks.failed > 0 {
        println!(
            "configuration check failed: {} check(s) failed, {} skipped",
            checks.failed, checks.skipped
        );
        return Err("configuration check failed".into());
    }
    println!("configuration check passed ({} skipped)", checks.skipped);
    Ok(())
}

/// Starts the retention sweep, or does nothing when the operation log is off.
///
/// This is the production caller [`pboard_signaling::sync_log::SyncLog::prune`]
/// never had. Without it the seven-day window never elapsed, `snapshot_required`
/// could never fire, and a board that reached 200 000 operations or 64 MiB stayed
/// `log_full` forever — no append could succeed again, because nothing ever
/// removed an operation a published snapshot already covered.
///
/// Deliberately *not* load-bearing: the sweep runs as a detached task whose
/// database work is moved to the blocking pool, and every failure is logged and
/// retried on the next interval. If it never runs, nothing becomes incorrect —
/// the log simply keeps more than it needs to until capacity refuses a write,
/// which is exactly the behaviour before this change. It can also be stopped mid
/// flight by SIGTERM with no cleanup, because each pass is a self-contained
/// transaction: interrupted at shutdown, a pass either committed or rolled back,
/// and the next process start resumes.
///
/// Bounds, and where they come from: the interval, board count and row budget are
/// read from the log's own [`pboard_signaling::sync_log::SyncLogLimits`], never
/// redefined here, so there is one answer to "how much work may retention do".
/// With the defaults that is one pass per hour, at most 16 boards per pass and at
/// most 20 000 rows per board: a full 200 000-row board drains over ten passes
/// (ten hours), and because the pass is bounded the writer lock is never held
/// long enough to stall an append.
fn spawn_retention(app: &pboard_signaling::App, mut stop: tokio::sync::watch::Receiver<bool>) {
    let Some(log) = app.sync().cloned() else {
        return;
    };
    let interval = std::time::Duration::from_millis(log.limits().sweep_interval_ms.max(1_000));
    let boards = log.limits().sweep_boards;
    let rows = log.limits().sweep_rows_per_board;
    tracing::info!(
        interval_ms = interval.as_millis() as u64,
        boards,
        rows_per_board = rows,
        "operation log retention sweep started"
    );
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(interval);
        // The first tick completes immediately. Skipping it keeps a restart from
        // sweeping before the service is serving; `interval` then makes each
        // later tick one period after the previous one was issued, and the pass
        // itself is short enough that drift is bounded by its own work.
        ticker.tick().await;
        loop {
            tokio::select! {
                _ = ticker.tick() => {}
                _ = stop.changed() => break,
            }
            if *stop.borrow() {
                break;
            }
            // SQLite work is blocking and can take milliseconds; it must not run
            // on a runtime worker that is also driving sockets.
            let log = log.clone();
            let outcome = tokio::task::spawn_blocking(move || log.prune_batch(boards, rows)).await;
            match outcome {
                Ok(Ok(pruned)) if !pruned.is_empty() => {
                    let operations: u64 = pruned.iter().map(|(_, removed)| removed).sum();
                    tracing::info!(boards = pruned.len(), operations, "operation log pruned");
                    for (board, removed) in pruned {
                        tracing::debug!(%board, operations = removed, "operation log pruned board");
                    }
                }
                // Nothing eligible is the normal case on a quiet service, not an
                // event worth a line: one line per hour of "did nothing" is noise
                // that hides the passes that did something.
                Ok(Ok(_)) => {}
                Ok(Err(error)) => tracing::warn!(%error, "retention sweep query failed"),
                Err(error) => tracing::warn!(%error, "retention sweep task failed"),
            }
        }
    });
}
