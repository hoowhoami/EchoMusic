//! Now playing / player view.

use ratatui::{
    layout::{Alignment, Constraint, Direction, Layout},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Gauge, Paragraph},
    Frame,
};
use ratatui::layout::Rect;
use airplay_client::{PlaybackState, MAX_GAIN_DB};

use crate::state::{AppState, EqState};
use crate::ui::format_duration;

/// Render the player view.
pub fn render_player(frame: &mut Frame, area: Rect, state: &AppState) {
    // Adjust layout based on whether EQ is expanded
    let eq_height = if state.eq.expanded { 12 } else { 0 };

    let per_device_lines = state.stream_stats.devices.iter()
        .filter(|d| d.rtx_requested > 0 || d.rtx_fulfilled > 0)
        .count() as u16;
    let stats_height = if state.stream_stats.packets_sent > 0 {
        6 + per_device_lines
    } else {
        5
    };
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(stats_height), // Now playing info (+ stats line when streaming)
            Constraint::Length(3),        // Progress bar
            Constraint::Length(5),        // Controls / volume
            Constraint::Length(eq_height), // EQ (if expanded)
            Constraint::Min(0),           // Empty space
        ])
        .split(area);

    // Now playing info
    render_now_playing(frame, chunks[0], state);

    // Progress bar
    render_progress(frame, chunks[1], state);

    // Volume and controls
    render_controls(frame, chunks[2], state);

    // EQ visualization (if expanded)
    if state.eq.expanded {
        render_eq(frame, chunks[3], &state.eq);
    }
}

fn render_now_playing(frame: &mut Frame, area: Rect, state: &AppState) {
    let (title, status_style) = match state.playback_state {
        PlaybackState::Playing => ("▶ Playing", Style::default().fg(Color::Green)),
        PlaybackState::Paused => ("⏸ Paused", Style::default().fg(Color::Yellow)),
        PlaybackState::Stopped => ("⏹ Stopped", Style::default().fg(Color::DarkGray)),
        PlaybackState::Buffering => ("⟳ Buffering", Style::default().fg(Color::Cyan)),
        PlaybackState::Error => ("✕ Error", Style::default().fg(Color::Red)),
    };

    let file_name = state
        .current_file
        .as_ref()
        .map(|f| {
            std::path::Path::new(f)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| f.clone())
        })
        .unwrap_or_else(|| "No file selected".to_string());

    let device_name = state
        .connected_device
        .as_ref()
        .map(|d| d.name.as_str())
        .unwrap_or("Not connected");

    let mut content = vec![
        Line::from(Span::styled(title, status_style.add_modifier(Modifier::BOLD))),
        Line::from(vec![
            Span::styled("File: ", Style::default().fg(Color::DarkGray)),
            Span::styled(file_name, Style::default().fg(Color::White)),
        ]),
        Line::from(vec![
            Span::styled("Device: ", Style::default().fg(Color::DarkGray)),
            Span::styled(device_name, Style::default().fg(Color::Cyan)),
        ]),
    ];

    // Show stream stats when actively streaming
    let stats = &state.stream_stats;
    if stats.packets_sent > 0 {
        let loss = stats.loss_percent();
        let loss_color = if loss > 1.0 {
            Color::Red
        } else if loss > 0.1 {
            Color::Yellow
        } else {
            Color::Green
        };
        let underrun_color = if stats.underruns > 10 {
            Color::Red
        } else if stats.underruns > 0 {
            Color::Yellow
        } else {
            Color::Green
        };
        content.push(Line::from(vec![
            Span::styled("Sent: ", Style::default().fg(Color::DarkGray)),
            Span::styled(format!("{}", stats.packets_sent), Style::default().fg(Color::White)),
            Span::styled("  RTX: ", Style::default().fg(Color::DarkGray)),
            Span::styled(
                format!("{}/{}", stats.rtx_fulfilled, stats.rtx_requested),
                Style::default().fg(loss_color),
            ),
            Span::styled(
                format!("  ({:.2}% loss)", loss),
                Style::default().fg(loss_color),
            ),
            Span::styled("  Underruns: ", Style::default().fg(Color::DarkGray)),
            Span::styled(
                format!("{}", stats.underruns),
                Style::default().fg(underrun_color),
            ),
        ]));

        // Show per-device RTX stats for group streaming
        if !stats.devices.is_empty() {
            // Get device names from group state
            let device_names: Vec<&str> = if let Some(ref group) = state.group {
                let mut names = vec![group.leader.name.as_str()];
                for m in &group.members {
                    if !m.is_leader {
                        names.push(m.device.name.as_str());
                    }
                }
                names
            } else {
                Vec::new()
            };

            for (i, dev) in stats.devices.iter().enumerate() {
                if dev.rtx_requested == 0 && dev.rtx_fulfilled == 0 {
                    continue;
                }
                let dev_loss = stats.device_loss_percent(i);
                let dev_color = if dev_loss > 1.0 {
                    Color::Red
                } else if dev_loss > 0.1 {
                    Color::Yellow
                } else {
                    Color::Green
                };
                let name = device_names.get(i).copied().unwrap_or("??");
                content.push(Line::from(vec![
                    Span::styled(format!("  {}: ", name), Style::default().fg(Color::DarkGray)),
                    Span::styled(
                        format!("{}/{}", dev.rtx_fulfilled, dev.rtx_requested),
                        Style::default().fg(dev_color),
                    ),
                    Span::styled(
                        format!("  ({:.2}%)", dev_loss),
                        Style::default().fg(dev_color),
                    ),
                ]));
            }
        }
    }

    let para = Paragraph::new(content)
        .block(Block::default().borders(Borders::ALL).title(" Now Playing "))
        .alignment(Alignment::Center);

    frame.render_widget(para, area);
}

fn render_progress(frame: &mut Frame, area: Rect, state: &AppState) {
    let position = state.position;
    let duration = state.duration.unwrap_or(0.0);

    let ratio = if duration > 0.0 {
        (position / duration).min(1.0) as f64
    } else {
        0.0
    };

    let position_str = format_duration(position);
    let duration_str = if duration > 0.0 {
        format_duration(duration)
    } else {
        "--:--".to_string()
    };

    let label = format!("{} / {}", position_str, duration_str);

    let gauge = Gauge::default()
        .block(Block::default().borders(Borders::ALL).title(" Progress "))
        .gauge_style(
            Style::default()
                .fg(Color::Cyan)
                .bg(Color::DarkGray),
        )
        .ratio(ratio)
        .label(Span::styled(
            label,
            Style::default().fg(Color::White).add_modifier(Modifier::BOLD),
        ));

    frame.render_widget(gauge, area);
}

fn render_controls(frame: &mut Frame, area: Rect, state: &AppState) {
    let volume_percent = (state.volume * 100.0) as u16;
    let volume_bar = "█".repeat((volume_percent / 5) as usize);
    let volume_empty = "░".repeat(20 - (volume_percent / 5) as usize);

    // EQ status indicator with hint
    let eq_status = if state.eq.is_bypassed() {
        Span::styled("EQ: OFF", Style::default().fg(Color::DarkGray))
    } else {
        Span::styled("EQ: ON", Style::default().fg(Color::Green))
    };

    let eq_hint = if state.eq.expanded {
        Span::styled(" [e] hide", Style::default().fg(Color::DarkGray))
    } else {
        Span::styled(" [e] show EQ", Style::default().fg(Color::Yellow))
    };

    let controls = vec![
        Line::from(vec![
            Span::styled("Volume: ", Style::default().fg(Color::DarkGray)),
            Span::styled(&volume_bar, Style::default().fg(Color::Green)),
            Span::styled(&volume_empty, Style::default().fg(Color::DarkGray)),
            Span::styled(format!(" {}%", volume_percent), Style::default().fg(Color::White)),
            Span::raw("    "),
            eq_status,
            eq_hint,
        ]),
        Line::from(vec![
            Span::styled("[Space]", Style::default().fg(Color::Yellow)),
            Span::raw(" Play/Pause  "),
            Span::styled("[s]", Style::default().fg(Color::Yellow)),
            Span::raw(" Stop  "),
            Span::styled("[←/→]", Style::default().fg(Color::Yellow)),
            Span::raw(" Seek  "),
            Span::styled("[+/-]", Style::default().fg(Color::Yellow)),
            Span::raw(" Volume  "),
            Span::styled("[b]", Style::default().fg(Color::Yellow)),
            Span::raw(" Bypass EQ"),
        ]),
    ];

    let para = Paragraph::new(controls)
        .block(Block::default().borders(Borders::ALL).title(" Controls "));

    frame.render_widget(para, area);
}

/// Render the equalizer visualization.
fn render_eq(frame: &mut Frame, area: Rect, eq: &EqState) {
    let num_bands = eq.config.num_bands();
    let gains = eq.all_gains_db();

    // Calculate column widths for bands
    let band_width = (area.width.saturating_sub(2)) / num_bands as u16;
    let bar_height = area.height.saturating_sub(4); // Leave room for labels and controls

    let mut lines = Vec::new();

    // Band labels row
    let mut label_spans = Vec::new();
    for i in 0..num_bands {
        let label = eq.band_label(i);

        let style = if i == eq.selected_band {
            Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(Color::DarkGray)
        };

        let label_text = format!("{:^width$}", label, width = band_width as usize);
        label_spans.push(Span::styled(label_text, style));
    }
    lines.push(Line::from(label_spans));

    // Frequency row
    let mut freq_spans = Vec::new();
    for i in 0..num_bands {
        let freq = eq.band_freq(i);
        let freq_str = EqState::format_freq(freq);

        let style = if i == eq.selected_band {
            Style::default().fg(Color::Cyan)
        } else {
            Style::default().fg(Color::DarkGray)
        };

        let freq_text = format!("{:^width$}", freq_str, width = band_width as usize);
        freq_spans.push(Span::styled(freq_text, style));
    }
    lines.push(Line::from(freq_spans));

    // Empty line
    lines.push(Line::from(""));

    // Render vertical bars (from top to bottom: +12dB to -12dB)
    // Each bar row represents ~3dB (for 8 rows of bar = 24dB range)
    let bar_rows = bar_height.saturating_sub(2).max(1) as usize;
    let db_per_row = (MAX_GAIN_DB * 2.0) / bar_rows as f32;

    for row in 0..bar_rows {
        let mut row_spans = Vec::new();
        let db_threshold = MAX_GAIN_DB - (row as f32 * db_per_row);

        for i in 0..num_bands {
            let gain = gains[i];
            let is_selected = i == eq.selected_band;

            // Determine if this cell should be filled
            let (char, style) = if db_threshold > 0.0 {
                // Positive gain region
                if gain >= db_threshold {
                    let color = if is_selected { Color::Cyan } else { Color::Green };
                    ("█", Style::default().fg(color))
                } else {
                    let color = if is_selected { Color::DarkGray } else { Color::Black };
                    ("░", Style::default().fg(color))
                }
            } else {
                // Negative gain region
                if gain <= db_threshold {
                    let color = if is_selected { Color::Cyan } else { Color::Yellow };
                    ("█", Style::default().fg(color))
                } else {
                    let color = if is_selected { Color::DarkGray } else { Color::Black };
                    ("░", Style::default().fg(color))
                }
            };

            // Add 0dB line marker
            let is_zero_line = db_threshold.abs() < db_per_row / 2.0;
            let display = if is_zero_line && gain.abs() < db_threshold.abs() {
                "─"
            } else {
                char
            };

            let cell_text = format!("{:^width$}", display, width = band_width as usize);
            row_spans.push(Span::styled(cell_text, style));
        }
        lines.push(Line::from(row_spans));
    }

    // Gain values row
    let mut gain_spans = Vec::new();
    for i in 0..num_bands {
        let gain = gains[i];
        let style = if i == eq.selected_band {
            Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(Color::White)
        };

        let gain_str = if gain >= 0.0 {
            format!("+{:.0}dB", gain)
        } else {
            format!("{:.0}dB", gain)
        };
        let gain_text = format!("{:^width$}", gain_str, width = band_width as usize);
        gain_spans.push(Span::styled(gain_text, style));
    }
    lines.push(Line::from(gain_spans));

    // Controls hint row
    lines.push(Line::from(vec![
        Span::styled("[,]", Style::default().fg(Color::Yellow)),
        Span::styled("[.]", Style::default().fg(Color::Yellow)),
        Span::styled(" Band  ", Style::default().fg(Color::DarkGray)),
        Span::styled("[[]", Style::default().fg(Color::Yellow)),
        Span::styled("[]]", Style::default().fg(Color::Yellow)),
        Span::styled(" Gain  ", Style::default().fg(Color::DarkGray)),
        Span::styled("[b]", Style::default().fg(Color::Yellow)),
        Span::styled(" Bypass  ", Style::default().fg(Color::DarkGray)),
        Span::styled("[r]", Style::default().fg(Color::Yellow)),
        Span::styled(" Reset  ", Style::default().fg(Color::DarkGray)),
        Span::styled("[e]", Style::default().fg(Color::Yellow)),
        Span::styled(" Hide", Style::default().fg(Color::DarkGray)),
    ]));

    let title = if eq.is_bypassed() {
        " Equalizer (Bypassed) "
    } else {
        " Equalizer "
    };

    let para = Paragraph::new(lines)
        .block(Block::default().borders(Borders::ALL).title(title));

    frame.render_widget(para, area);
}
