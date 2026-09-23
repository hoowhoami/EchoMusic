//! USB Audio input view renderer.

use ratatui::{
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Gauge, List, ListItem, ListState, Paragraph},
    Frame,
};

use crate::state::{AppState, UsbAudioState};

/// Render the USB Audio view.
pub fn render_usb_audio(frame: &mut Frame, area: Rect, state: &AppState) {
    let usb = &state.usb_audio;

    // Split into devices list and connection/status panel
    let chunks = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(50), Constraint::Percentage(50)])
        .split(area);

    render_devices_list(frame, chunks[0], usb);
    render_status_panel(frame, chunks[1], usb);
}

/// Render the input devices list.
fn render_devices_list(frame: &mut Frame, area: Rect, usb: &UsbAudioState) {
    let title = if usb.devices.is_empty() {
        " Input Devices (press r to scan) "
    } else {
        " Input Devices "
    };

    let items: Vec<ListItem> = usb
        .devices
        .iter()
        .enumerate()
        .map(|(i, device)| {
            let is_highlighted = i == usb.device_index;
            let is_selected = usb.selected_device.as_ref()
                .map(|d| d.device_index == device.device_index)
                .unwrap_or(false);

            let mut spans = vec![];

            // Selection indicator
            if is_highlighted {
                spans.push(Span::styled(
                    "> ",
                    Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD),
                ));
            } else {
                spans.push(Span::raw("  "));
            }

            // Device name
            let name_style = if is_selected {
                Style::default().fg(Color::Green).add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(Color::White)
            };
            spans.push(Span::styled(&device.name, name_style));

            // Config info
            spans.push(Span::styled(
                format!(" ({}Hz, {}ch)", device.sample_rate, device.channels),
                Style::default().fg(Color::DarkGray),
            ));

            if is_selected {
                spans.push(Span::styled(
                    " [selected]",
                    Style::default().fg(Color::Green),
                ));
            }

            ListItem::new(Line::from(spans))
        })
        .collect();

    let list = List::new(items).block(Block::default().borders(Borders::ALL).title(title));

    let mut list_state = ListState::default();
    if !usb.devices.is_empty() {
        list_state.select(Some(usb.device_index));
    }

    frame.render_stateful_widget(list, area, &mut list_state);
}

/// Render the status panel with connection info and audio meter.
fn render_status_panel(frame: &mut Frame, area: Rect, usb: &UsbAudioState) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Min(0), Constraint::Length(5)])
        .split(area);

    // Status info
    let mut lines: Vec<Line> = vec![];

    if let Some(ref device) = usb.selected_device {
        lines.push(Line::from(vec![
            Span::styled("Device: ", Style::default().fg(Color::Gray)),
            Span::styled(
                &device.name,
                Style::default().fg(Color::Green).add_modifier(Modifier::BOLD),
            ),
        ]));

        lines.push(Line::from(vec![
            Span::styled("Sample Rate: ", Style::default().fg(Color::Gray)),
            Span::styled(
                format!("{} Hz", device.sample_rate),
                Style::default().fg(Color::White),
            ),
        ]));

        lines.push(Line::from(vec![
            Span::styled("Channels: ", Style::default().fg(Color::Gray)),
            Span::styled(
                format!("{}", device.channels),
                Style::default().fg(Color::White),
            ),
        ]));

        lines.push(Line::from(""));

        let (status_text, status_color) = if usb.streaming {
            ("Streaming to AirPlay", Color::Green)
        } else {
            ("Ready (press u to stream)", Color::Yellow)
        };

        lines.push(Line::from(vec![
            Span::styled("Status: ", Style::default().fg(Color::Gray)),
            Span::styled(status_text, Style::default().fg(status_color)),
        ]));

        if usb.streaming {
            lines.push(Line::from(""));
            lines.push(Line::from(vec![
                Span::styled("Samples: ", Style::default().fg(Color::Gray)),
                Span::styled(
                    format_samples(usb.samples_received),
                    Style::default().fg(Color::White),
                ),
            ]));
        }
    } else {
        lines.push(Line::from(Span::styled(
            "No device selected",
            Style::default().fg(Color::Gray),
        )));
        lines.push(Line::from(""));
        lines.push(Line::from(Span::styled(
            "Press Enter to select a device",
            Style::default().fg(Color::DarkGray),
        )));
    }

    let info = Paragraph::new(lines).block(
        Block::default()
            .borders(Borders::ALL)
            .title(" Status "),
    );

    frame.render_widget(info, chunks[0]);

    // Audio level meter
    render_audio_meter(frame, chunks[1], usb);
}

/// Render audio level meter.
fn render_audio_meter(frame: &mut Frame, area: Rect, usb: &UsbAudioState) {
    let level = usb.audio_level;
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
