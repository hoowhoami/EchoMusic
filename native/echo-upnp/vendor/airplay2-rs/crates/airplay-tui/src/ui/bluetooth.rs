//! Bluetooth view renderer.

use ratatui::{
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Gauge, List, ListItem, ListState, Paragraph},
    Frame,
};

use crate::state::{AppState, BluetoothState};

/// Render the Bluetooth view.
pub fn render_bluetooth(frame: &mut Frame, area: Rect, state: &AppState) {
    let bt = &state.bluetooth;

    // Main layout: setup status, content (devices + connection), hints
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3), // Setup status
            Constraint::Min(0),    // Main content
        ])
        .split(area);

    // Render setup status bar
    render_setup_status(frame, chunks[0], bt);

    // If setup is not ready, show setup instructions
    if !bt.setup_ready && bt.setup_checked {
        render_setup_instructions(frame, chunks[1], bt);
        return;
    }

    // Split main content into devices list and connection info
    let content_chunks = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(50), Constraint::Percentage(50)])
        .split(chunks[1]);

    // Render devices list
    render_devices_list(frame, content_chunks[0], bt);

    // Render connection info / audio status
    render_connection_info(frame, content_chunks[1], bt);
}

/// Render setup status bar.
fn render_setup_status(frame: &mut Frame, area: Rect, bt: &BluetoothState) {
    let (status_text, style): (String, Style) = if !bt.setup_checked {
        ("Checking system setup...".to_string(), Style::default().fg(Color::Yellow))
    } else if bt.setup_ready {
        let adapter_info = bt
            .adapter_name
            .as_ref()
            .map(|n| format!("Adapter: {}", n))
            .unwrap_or_else(|| "Adapter ready".to_string());
        let power_status = if bt.adapter_powered { "ON" } else { "OFF" };
        (
            format!("{} ({})", adapter_info, power_status),
            Style::default().fg(Color::Green),
        )
    } else {
        ("Setup required - see below".to_string(), Style::default().fg(Color::Red))
    };

    let status = Paragraph::new(Line::from(Span::styled(status_text, style)))
        .block(
            Block::default()
                .borders(Borders::ALL)
                .title(" System Status "),
        );

    frame.render_widget(status, area);
}

/// Render setup instructions when system is not ready.
fn render_setup_instructions(frame: &mut Frame, area: Rect, bt: &BluetoothState) {
    let mut lines: Vec<Line> = vec![
        Line::from(Span::styled(
            "Bluetooth system setup is required",
            Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD),
        )),
        Line::from(""),
    ];

    for issue in &bt.setup_issues {
        lines.push(Line::from(Span::styled(
            format!("  - {}", issue),
            Style::default().fg(Color::Red),
        )));
    }

    lines.push(Line::from(""));
    lines.push(Line::from(Span::styled(
        "Press 'i' to attempt automatic setup (requires sudo)",
        Style::default().fg(Color::Cyan),
    )));
    lines.push(Line::from("Press 'c' to check setup again"));

    let instructions = Paragraph::new(lines).block(
        Block::default()
            .borders(Borders::ALL)
            .title(" Setup Instructions "),
    );

    frame.render_widget(instructions, area);
}

/// Render the Bluetooth devices list.
fn render_devices_list(frame: &mut Frame, area: Rect, bt: &BluetoothState) {
    let title = if bt.scanning {
        " Devices (scanning...) "
    } else {
        " Devices "
    };

    let items: Vec<ListItem> = bt
        .devices
        .iter()
        .enumerate()
        .map(|(i, device)| {
            let is_selected = i == bt.device_index;
            let is_connected = device.connected;

            // Build device line
            let mut spans = vec![];

            // Selection indicator
            if is_selected {
                spans.push(Span::styled(
                    "> ",
                    Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD),
                ));
            } else {
                spans.push(Span::raw("  "));
            }

            // Device name
            let name_style = if is_connected {
                Style::default().fg(Color::Green).add_modifier(Modifier::BOLD)
            } else if device.paired {
                Style::default().fg(Color::White)
            } else {
                Style::default().fg(Color::Gray)
            };
            spans.push(Span::styled(&device.name, name_style));

            // Status indicators
            let mut status_parts = vec![];
            if device.paired {
                status_parts.push("paired");
            }
            if device.connected {
                status_parts.push("connected");
            }
            if device.supports_a2dp {
                status_parts.push("A2DP");
            }

            if !status_parts.is_empty() {
                spans.push(Span::styled(
                    format!(" ({})", status_parts.join(", ")),
                    Style::default().fg(Color::DarkGray),
                ));
            }

            // RSSI
            if let Some(rssi) = device.rssi {
                let rssi_color = if rssi > -50 {
                    Color::Green
                } else if rssi > -70 {
                    Color::Yellow
                } else {
                    Color::Red
                };
                spans.push(Span::styled(
                    format!(" {}dBm", rssi),
                    Style::default().fg(rssi_color),
                ));
            }

            ListItem::new(Line::from(spans))
        })
        .collect();

    let list = List::new(items).block(Block::default().borders(Borders::ALL).title(title));

    // Render with selection state
    let mut list_state = ListState::default();
    if !bt.devices.is_empty() {
        list_state.select(Some(bt.device_index));
    }

    frame.render_stateful_widget(list, area, &mut list_state);
}

/// Render connection info and audio status.
fn render_connection_info(frame: &mut Frame, area: Rect, bt: &BluetoothState) {
    // Split into connection info and audio meter
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Min(0), Constraint::Length(5)])
        .split(area);

    // Connection info
    let mut lines: Vec<Line> = vec![];

    if let Some(ref device) = bt.connected_device {
        lines.push(Line::from(vec![
            Span::styled("Device: ", Style::default().fg(Color::Gray)),
            Span::styled(&device.name, Style::default().fg(Color::Green).add_modifier(Modifier::BOLD)),
        ]));

        lines.push(Line::from(vec![
            Span::styled("Address: ", Style::default().fg(Color::Gray)),
            Span::styled(&device.address, Style::default().fg(Color::White)),
        ]));

        lines.push(Line::from(""));

        let status = if bt.is_source_active {
            ("Streaming to AirPlay", Color::Green)
        } else if bt.streaming {
            ("Connected (not streaming)", Color::Yellow)
        } else {
            ("Connected", Color::Cyan)
        };

        lines.push(Line::from(vec![
            Span::styled("Status: ", Style::default().fg(Color::Gray)),
            Span::styled(status.0, Style::default().fg(status.1)),
        ]));

        if bt.is_source_active {
            lines.push(Line::from(""));
            lines.push(Line::from(vec![
                Span::styled("Samples: ", Style::default().fg(Color::Gray)),
                Span::styled(
                    format_samples(bt.samples_received),
                    Style::default().fg(Color::White),
                ),
            ]));
        }
    } else {
        lines.push(Line::from(Span::styled(
            "No device connected",
            Style::default().fg(Color::Gray),
        )));
        lines.push(Line::from(""));
        lines.push(Line::from(Span::styled(
            "Select a device and press Enter to connect",
            Style::default().fg(Color::DarkGray),
        )));
    }

    let info = Paragraph::new(lines).block(
        Block::default()
            .borders(Borders::ALL)
            .title(" Connection "),
    );

    frame.render_widget(info, chunks[0]);

    // Audio level meter
    render_audio_meter(frame, chunks[1], bt);
}

/// Render audio level meter.
fn render_audio_meter(frame: &mut Frame, area: Rect, bt: &BluetoothState) {
    let level = bt.audio_level;
    let percent = (level * 100.0).min(100.0) as u16;

    let color = if level > 0.8 {
        Color::Red
    } else if level > 0.5 {
        Color::Yellow
    } else {
        Color::Green
    };

    let gauge = Gauge::default()
        .block(Block::default().borders(Borders::ALL).title(" Audio Level "))
        .gauge_style(Style::default().fg(color))
        .percent(percent)
        .label(format!("{:.0}%", level * 100.0));

    frame.render_widget(gauge, area);
}

/// Format sample count for display.
fn format_samples(samples: u64) -> String {
    if samples >= 1_000_000 {
        format!("{:.1}M", samples as f64 / 1_000_000.0)
    } else if samples >= 1_000 {
        format!("{:.1}K", samples as f64 / 1_000.0)
    } else {
        format!("{}", samples)
    }
}
