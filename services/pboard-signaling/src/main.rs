use pboard_signaling::{App, Config, Limits};
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let action = std::env::args().nth(1);
    if action.as_deref() == Some("--generate-authority") {
        use p256::elliptic_curve::rand_core::OsRng;
        use std::io::Write;
        let path = std::env::args().nth(2).ok_or("authority path required")?;
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
        file.sync_all()?;
        return Ok(());
    }
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    let path = std::env::var("PBOARD_SIGNALING_GRANTS")
        .map_err(|_| "PBOARD_SIGNALING_GRANTS must name an operator-approved grants file")?;
    let config: Config = serde_json::from_slice(&std::fs::read(path)?)?;
    let automatic = match std::env::var("PBOARD_SIGNALING_AUTOMATIC_ADMISSION").as_deref() {
        Ok("1") => true,
        Ok("0") | Err(std::env::VarError::NotPresent) => false,
        _ => return Err("PBOARD_SIGNALING_AUTOMATIC_ADMISSION must be 0 or 1".into()),
    };
    let limits = Limits::from_env()?;
    let policy = pboard_signaling::policy::TransportPolicy::from_env()?;
    let mut app = App::new(config, limits)?
        .with_transport_policy(policy)
        .with_automatic_admission(automatic);
    let board_grants = match std::env::var("PBOARD_SIGNALING_BOARD_GRANTS").as_deref() {
        Ok("1") => true,
        Ok("0") | Err(std::env::VarError::NotPresent) => false,
        _ => return Err("PBOARD_SIGNALING_BOARD_GRANTS must be 0 or 1".into()),
    };
    app = app.with_board_grants(board_grants);
    if let Ok(emails) = std::env::var("PBOARD_SIGNALING_GOOGLE_EMAILS") {
        let key_path = std::env::var("PBOARD_SIGNALING_AUTHORITY_KEY")?;
        let key = p256::ecdsa::SigningKey::from_slice(&std::fs::read(key_path)?)?;
        let state = std::env::var("PBOARD_SIGNALING_ENROLLMENT_STATE")?;
        let enrollment = pboard_signaling::google_enrollment::GoogleEnrollment::new(
            key,
            emails.split(',').map(str::to_owned).collect(),
            state.into(),
        )?;
        #[cfg(feature = "test-google-fixture")]
        let enrollment = if let Ok(base) = std::env::var("PBOARD_TEST_GOOGLE_BASE") {
            enrollment.with_test_google_base(base)?
        } else {
            enrollment
        };
        #[cfg(feature = "test-google-fixture")]
        let enrollment = if let Ok(ms) = std::env::var("PBOARD_TEST_MANIFEST_LIFETIME_MS") {
            enrollment.with_test_lifetime(ms.parse()?)?
        } else {
            enrollment
        };
        if action.as_deref() == Some("--public-authority") {
            println!("{}", serde_json::to_string(&enrollment.authority())?);
            return Ok(());
        }
        app = app.with_google_enrollment(enrollment);
    }
    let identity = match std::env::var("PBOARD_SIGNALING_GOOGLE_IDENTITIES").as_deref() {
        Ok("1") => true,
        Ok("0") | Err(std::env::VarError::NotPresent) => false,
        _ => return Err("PBOARD_SIGNALING_GOOGLE_IDENTITIES must be 0 or 1".into()),
    };
    if identity && (!board_grants || std::env::var("PBOARD_SIGNALING_GOOGLE_EMAILS").is_err()) {
        return Err(
            "Google identity enrollment requires board grants and a configured identity verifier"
                .into(),
        );
    }
    app = app.with_identity_enrollment(identity);
    app.validate_service_policy()?;
    match action.as_deref() {
        Some("--check-config") => return Ok(()),
        Some(_) => return Err("usage: pboard-signaling [--check-config]".into()),
        None => {}
    }
    let bind: std::net::SocketAddr = std::env::var("PBOARD_SIGNALING_BIND")
        .unwrap_or_else(|_| "127.0.0.1:8787".into())
        .parse()?;
    if !bind.ip().is_loopback() {
        return Err("bind must be loopback; use a TLS reverse proxy".into());
    }
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
        })
        .await?;
    Ok(())
}
