//! UI rendering modules.

mod devices;
mod browser;
mod player;
mod help;
mod spatial;
#[cfg(feature = "usb-audio")]
mod usb_audio;
#[cfg(feature = "bluetooth")]
mod bluetooth;

pub use devices::render_devices;
pub use browser::render_browser;
pub use player::render_player;
pub use help::render_help;
pub use spatial::render_spatial;
#[cfg(feature = "usb-audio")]
pub use usb_audio::render_usb_audio;
#[cfg(feature = "bluetooth")]
pub use bluetooth::render_bluetooth;

use ratatui::{
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph, Tabs},
    Frame,
};

use crate::state::{AppState, View};
use crate::file_browser::FileBrowser;

/// Render the entire UI.
pub fn render(frame: &mut Frame, state: &AppState, browser: &FileBrowser) {
    let size = frame.area();

    // Main layout: header, content, footer
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3), // Header with tabs
            Constraint::Min(0),    // Content
            Constraint::Length(3), // Footer with status
        ])
        .split(size);

    // Render header with tabs
    render_header(frame, chunks[0], state);

    // Render main content based on current view
    match state.view {
        View::Devices => render_devices(frame, chunks[1], state),
        View::Browser => render_browser(frame, chunks[1], browser),
        View::Player => render_player(frame, chunks[1], state),
        #[cfg(feature = "usb-audio")]
        View::UsbAudio => render_usb_audio(frame, chunks[1], state),
        #[cfg(feature = "bluetooth")]
        View::Bluetooth => render_bluetooth(frame, chunks[1], state),
        View::Spatial => render_spatial(frame, chunks[1], state),
    }

    // Render footer with status
    render_footer(frame, chunks[2], state);

    // Render help overlay if shown
    if state.show_help {
        render_help(frame, state);
    }
}

/// Render the header with tab navigation.
fn render_header(frame: &mut Frame, area: Rect, state: &AppState) {
    let titles: Vec<Line> = View::all()
        .iter()
        .map(|v| {
            let style = if *v == state.view {
                Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(Color::Gray)
            };
            Line::from(Span::styled(v.name(), style))
        })
        .collect();

    let tabs = Tabs::new(titles)
        .block(
            Block::default()
                .borders(Borders::ALL)
                .title(" AirPlay TUI ")
                .title_style(Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)),
        )
        .select(state.view.index())
        .style(Style::default())
        .highlight_style(Style::default().fg(Color::Cyan));

    frame.render_widget(tabs, area);
}

/// Render the footer with status and key hints.
fn render_footer(frame: &mut Frame, area: Rect, state: &AppState) {
    let status_text = if let Some(ref status) = state.status {
        let style = if status.is_error {
            Style::default().fg(Color::Red)
        } else {
            Style::default().fg(Color::Green)
        };
        Span::styled(&status.text, style)
    } else {
        // Show key hints based on current view
        let hints = match state.view {
            View::Devices => {
                let selected = state.devices.iter().filter(|e| e.is_selected).count();
                if state.group.is_some() {
                    "r: Refresh  Space: Select  x: Disband  Enter: Connect  ?: Help  q: Quit"
                } else if selected >= 2 {
                    "r: Refresh  Space: Select  Enter: Connect group  ?: Help  q: Quit"
                } else {
                    "r: Refresh  Space: Select  Enter: Connect  ?: Help  q: Quit"
                }
            },
            View::Browser => "Enter: Select  Esc: Back  Tab: Next view  ?: Help",
            View::Player => "Space: Play/Pause  s: Stop  +/-: Volume  Tab: Next view",
            #[cfg(feature = "usb-audio")]
            View::UsbAudio => "r: Refresh  Enter: Select  u: Start streaming  x: Stop",
            #[cfg(feature = "bluetooth")]
            View::Bluetooth => "s: Scan  p: Pair  c: Connect  d: Disconnect  u: Source  o: Radio on/off",
            View::Spatial => "Arrows: Move  n/p: Select  b: Toggle  m: Mode  f: Fine  r: Reset",
        };
        Span::styled(hints, Style::default().fg(Color::DarkGray))
    };

    let footer = Paragraph::new(Line::from(status_text))
        .block(Block::default().borders(Borders::ALL));

    frame.render_widget(footer, area);
}

/// Create a centered rect for overlays.
pub fn centered_rect(percent_x: u16, percent_y: u16, r: Rect) -> Rect {
    let popup_layout = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Percentage((100 - percent_y) / 2),
            Constraint::Percentage(percent_y),
            Constraint::Percentage((100 - percent_y) / 2),
        ])
        .split(r);

    Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Percentage((100 - percent_x) / 2),
            Constraint::Percentage(percent_x),
            Constraint::Percentage((100 - percent_x) / 2),
        ])
        .split(popup_layout[1])[1]
}

/// Format duration as MM:SS or HH:MM:SS.
pub fn format_duration(secs: f64) -> String {
    let total_secs = secs as u64;
    let hours = total_secs / 3600;
    let minutes = (total_secs % 3600) / 60;
    let seconds = total_secs % 60;

    if hours > 0 {
        format!("{:02}:{:02}:{:02}", hours, minutes, seconds)
    } else {
        format!("{:02}:{:02}", minutes, seconds)
    }
}
