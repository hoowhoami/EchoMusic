//! AirPlay TUI - Terminal user interface for AirPlay 2 audio streaming.

mod action;
mod app;
mod audio_info;
#[cfg(feature = "bluetooth")]
mod bluetooth_helper;
mod file_browser;
#[cfg(feature = "usb-audio")]
mod usb_audio;
mod spatial_config;
mod state;
mod ui;

use std::io;
use std::path::PathBuf;

use anyhow::Result;
use crossterm::{
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use ratatui::{backend::CrosstermBackend, Terminal};
use tracing::info;

use app::App;

/// Command-line arguments
struct Args {
    /// Enable debug logging to file
    debug: bool,
    /// Log file path (default: airplay-tui.log)
    log_file: PathBuf,
}

impl Default for Args {
    fn default() -> Self {
        Self {
            debug: false,
            log_file: PathBuf::from("airplay-tui.log"),
        }
    }
}

fn parse_args() -> Args {
    let mut args = Args::default();
    let mut iter = std::env::args().skip(1);

    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--debug" | "-d" => {
                args.debug = true;
            }
            "--log-file" | "-l" => {
                if let Some(path) = iter.next() {
                    args.log_file = PathBuf::from(path);
                }
            }
            "--help" | "-h" => {
                print_help();
                std::process::exit(0);
            }
            _ => {
                eprintln!("Unknown argument: {}", arg);
                print_help();
                std::process::exit(1);
            }
        }
    }

    args
}

fn print_help() {
    println!("AirPlay TUI - Terminal user interface for AirPlay 2 audio streaming");
    println!();
    println!("Usage: airplay-tui [OPTIONS]");
    println!();
    println!("Options:");
    println!("  -d, --debug          Enable debug logging to file");
    println!("  -l, --log-file PATH  Set log file path (default: airplay-tui.log)");
    println!("  -h, --help           Show this help message");
    println!();
    println!("Debug logging writes to a file to avoid interfering with the TUI.");
    println!("Use 'tail -f airplay-tui.log' in another terminal to watch logs.");
}

fn setup_logging(args: &Args) -> Option<tracing_appender::non_blocking::WorkerGuard> {
    if !args.debug {
        return None;
    }

    // Create a file appender that doesn't interfere with the TUI
    let file = std::fs::File::create(&args.log_file).ok()?;
    let (non_blocking, guard) = tracing_appender::non_blocking(file);

    tracing_subscriber::fmt()
        .with_writer(non_blocking)
        .with_ansi(false)
        .with_target(true)
        .with_thread_ids(true)
        .with_file(true)
        .with_line_number(true)
        .with_max_level(tracing::Level::DEBUG)
        .init();

    info!("Debug logging enabled, writing to: {:?}", args.log_file);

    Some(guard)
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = parse_args();

    // Setup logging before anything else
    let _guard = setup_logging(&args);

    info!("Starting AirPlay TUI");

    // Setup terminal
    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen)?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;

    // Create and run app
    let result = run_app(&mut terminal).await;

    // Restore terminal
    disable_raw_mode()?;
    execute!(terminal.backend_mut(), LeaveAlternateScreen)?;
    terminal.show_cursor()?;

    info!("AirPlay TUI exiting");

    // Handle any errors
    if let Err(e) = result {
        eprintln!("Error: {}", e);
        std::process::exit(1);
    }

    Ok(())
}

async fn run_app(terminal: &mut Terminal<CrosstermBackend<io::Stdout>>) -> Result<()> {
    let mut app = App::new()?;
    app.run(terminal).await
}
