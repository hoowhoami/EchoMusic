//! Spatial audio placement view.
//!
//! Renders a 2D room map with speaker and listener positions, plus
//! an info panel showing spatial parameters and controls.

use ratatui::{
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph},
    Frame,
};

use crate::state::{AppState, SpatialState};
use airplay_client::SpatialMode;

/// Render the spatial audio view.
pub fn render_spatial(frame: &mut Frame, area: Rect, state: &AppState) {
    let spatial = &state.spatial;

    if spatial.speakers.is_empty() {
        render_no_group(frame, area);
        return;
    }

    // Split into room map (60%) and info panel (40%)
    let chunks = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Percentage(60),
            Constraint::Percentage(40),
        ])
        .split(area);

    render_room_map(frame, chunks[0], spatial);
    render_info_panel(frame, chunks[1], spatial);
}

/// Render placeholder when no group is connected.
fn render_no_group(frame: &mut Frame, area: Rect) {
    let content = vec![
        Line::from(""),
        Line::from(Span::styled(
            "No group connected",
            Style::default().fg(Color::DarkGray).add_modifier(Modifier::BOLD),
        )),
        Line::from(""),
        Line::from(Span::styled(
            "Connect 2+ devices as a group to use spatial audio.",
            Style::default().fg(Color::DarkGray),
        )),
        Line::from(Span::styled(
            "Go to Devices tab, select devices with Space, then press Enter.",
            Style::default().fg(Color::DarkGray),
        )),
    ];

    let para = Paragraph::new(content)
        .block(Block::default().borders(Borders::ALL).title(" Spatial Audio "))
        .alignment(ratatui::layout::Alignment::Center);

    frame.render_widget(para, area);
}

/// Render the 2D room map with speakers and listener.
fn render_room_map(frame: &mut Frame, area: Rect, spatial: &SpatialState) {
    let block = Block::default()
        .borders(Borders::ALL)
        .title(format!(
            " Room ({:.0}m x {:.0}m) ",
            spatial.room_width, spatial.room_height
        ));
    let inner = block.inner(area);
    frame.render_widget(block, area);

    if inner.width < 4 || inner.height < 4 {
        return;
    }

    let map_w = inner.width as f64;
    let map_h = inner.height as f64;

    // Convert world coordinates to screen coordinates.
    // World: x is left-right, y is front-back (positive = forward/up on screen).
    // Screen: col goes left-right, row goes top-bottom (row 0 = top = far end of room).
    let world_to_screen = |wx: f64, wy: f64| -> (u16, u16) {
        // Map world [-w/2, w/2] → [0, map_w-1]
        let col = ((wx + spatial.room_width / 2.0) / spatial.room_width * (map_w - 1.0))
            .round()
            .clamp(0.0, map_w - 1.0) as u16;
        // Map world [-h/2, h/2] → [map_h-1, 0] (invert Y so +Y is up)
        let row = (((spatial.room_height / 2.0 - wy) / spatial.room_height) * (map_h - 1.0))
            .round()
            .clamp(0.0, map_h - 1.0) as u16;
        (col, row)
    };

    // Build a character buffer for the map
    let w = inner.width as usize;
    let h = inner.height as usize;
    let mut chars: Vec<Vec<(char, Style)>> = vec![vec![(' ', Style::default()); w]; h];

    // Draw grid dots every ~1 meter
    for gx in 0..=(spatial.room_width as i32) {
        for gy in 0..=(spatial.room_height as i32) {
            let wx = gx as f64 - spatial.room_width / 2.0;
            let wy = gy as f64 - spatial.room_height / 2.0;
            let (col, row) = world_to_screen(wx, wy);
            if (col as usize) < w && (row as usize) < h {
                chars[row as usize][col as usize] = ('.', Style::default().fg(Color::DarkGray));
            }
        }
    }

    // Draw speakers
    for (i, speaker) in spatial.speakers.iter().enumerate() {
        let (col, row) = world_to_screen(speaker.position.0, speaker.position.1);
        let is_selected = i == spatial.selected_index;
        let style = if is_selected {
            Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(Color::Yellow)
        };

        // Place speaker marker
        if (col as usize) < w && (row as usize) < h {
            chars[row as usize][col as usize] = ('*', style);
        }

        // Place label: " Name" to the right, or "Name " to the left if near right edge
        let name = truncate_name(&speaker.device_name, 12);
        let label = format!(" {}", name);
        let label_len = label.chars().count();

        if (row as usize) < h {
            let right_space = w.saturating_sub(col as usize + 1);
            if right_space >= label_len {
                // Place to the right
                for (j, ch) in label.chars().enumerate() {
                    let c = col as usize + 1 + j;
                    if c < w {
                        chars[row as usize][c] = (ch, style);
                    }
                }
            } else {
                // Place to the left
                let left_label = format!("{} ", name);
                let left_len = left_label.chars().count();
                let start = (col as usize).saturating_sub(left_len);
                for (j, ch) in left_label.chars().enumerate() {
                    let c = start + j;
                    if c < col as usize && c < w {
                        chars[row as usize][c] = (ch, style);
                    }
                }
            }
        }
    }

    // Draw listener
    {
        let (col, row) = world_to_screen(spatial.listener_pos.0, spatial.listener_pos.1);
        let is_selected = spatial.is_listener_selected();
        let style = if is_selected {
            Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(Color::Magenta)
        };

        // [@] marker for listener
        if (col as usize) < w && (row as usize) < h {
            chars[row as usize][col as usize] = ('@', style);
            if col > 0 {
                chars[row as usize][col as usize - 1] = ('[', style);
            }
            if (col as usize + 1) < w {
                chars[row as usize][col as usize + 1] = (']', style);
            }
        }
    }

    // Render the character buffer as lines
    let lines: Vec<Line> = chars.iter().map(|row| {
        let spans: Vec<Span> = row.iter().map(|(ch, style)| {
            Span::styled(ch.to_string(), *style)
        }).collect();
        Line::from(spans)
    }).collect();

    let para = Paragraph::new(lines);
    frame.render_widget(para, inner);
}

/// Render the info panel with spatial parameters and controls.
fn render_info_panel(frame: &mut Frame, area: Rect, spatial: &SpatialState) {
    let mut lines = Vec::new();

    // Status line
    let enabled_span = if spatial.enabled {
        Span::styled("ON", Style::default().fg(Color::Green).add_modifier(Modifier::BOLD))
    } else {
        Span::styled("OFF", Style::default().fg(Color::Red).add_modifier(Modifier::BOLD))
    };
    let mode_str = match spatial.mode {
        SpatialMode::StereoPan => "Stereo Pan",
        SpatialMode::Stft51 => "STFT 5.1",
    };
    lines.push(Line::from(vec![
        Span::styled("Spatial: ", Style::default().fg(Color::DarkGray)),
        enabled_span,
        Span::raw("  "),
        Span::styled("Mode: ", Style::default().fg(Color::DarkGray)),
        Span::styled(mode_str, Style::default().fg(Color::White)),
    ]));
    lines.push(Line::from(""));

    // Speaker list
    for (i, speaker) in spatial.speakers.iter().enumerate() {
        let is_selected = i == spatial.selected_index;
        let prefix = if is_selected { "> " } else { "  " };
        let style = if is_selected {
            Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(Color::White)
        };
        lines.push(Line::from(Span::styled(
            format!("{}{:<16} ({:+.1}, {:+.1})",
                prefix,
                truncate_name(&speaker.device_name, 16),
                speaker.position.0,
                speaker.position.1,
            ),
            style,
        )));
    }

    // Listener entry
    {
        let is_selected = spatial.is_listener_selected();
        let prefix = if is_selected { "> " } else { "  " };
        let style = if is_selected {
            Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(Color::Magenta)
        };
        lines.push(Line::from(Span::styled(
            format!("{}[@] Listener  ({:+.1}, {:+.1})",
                prefix,
                spatial.listener_pos.0,
                spatial.listener_pos.1,
            ),
            style,
        )));
    }

    lines.push(Line::from(""));

    // Selected item details
    if let Some(dist) = spatial.selected_distance() {
        let delay_ms = dist / 343.0 * 1000.0; // speed of sound
        let gain = 1.0 / dist.max(0.3);
        lines.push(Line::from(vec![
            Span::styled("Distance: ", Style::default().fg(Color::DarkGray)),
            Span::styled(format!("{:.2}m", dist), Style::default().fg(Color::White)),
        ]));
        lines.push(Line::from(vec![
            Span::styled("Gain: ", Style::default().fg(Color::DarkGray)),
            Span::styled(format!("{:.2}", gain), Style::default().fg(Color::White)),
            Span::styled("  Delay: ", Style::default().fg(Color::DarkGray)),
            Span::styled(format!("{:.1}ms", delay_ms), Style::default().fg(Color::White)),
        ]));
    }

    lines.push(Line::from(""));

    // Movement mode indicator
    let step_str = if spatial.fine_mode { "0.05m (fine)" } else { "0.25m" };
    lines.push(Line::from(vec![
        Span::styled("Step: ", Style::default().fg(Color::DarkGray)),
        Span::styled(step_str, Style::default().fg(Color::White)),
    ]));

    lines.push(Line::from(""));

    // Controls
    lines.push(Line::from(vec![
        Span::styled("Arrows", Style::default().fg(Color::Yellow)),
        Span::styled(" Move  ", Style::default().fg(Color::DarkGray)),
        Span::styled("n/p", Style::default().fg(Color::Yellow)),
        Span::styled(" Select", Style::default().fg(Color::DarkGray)),
    ]));
    lines.push(Line::from(vec![
        Span::styled("f", Style::default().fg(Color::Yellow)),
        Span::styled(" Fine  ", Style::default().fg(Color::DarkGray)),
        Span::styled("b", Style::default().fg(Color::Yellow)),
        Span::styled(" Toggle  ", Style::default().fg(Color::DarkGray)),
        Span::styled("m", Style::default().fg(Color::Yellow)),
        Span::styled(" Mode", Style::default().fg(Color::DarkGray)),
    ]));
    lines.push(Line::from(vec![
        Span::styled("r", Style::default().fg(Color::Yellow)),
        Span::styled(" Reset layout", Style::default().fg(Color::DarkGray)),
    ]));

    let para = Paragraph::new(lines)
        .block(Block::default().borders(Borders::ALL).title(" Spatial Info "));

    frame.render_widget(para, area);
}

/// Truncate a name with middle ellipsis so both prefix and suffix are visible.
/// e.g. "Luke's HomePod Mini" → "Luke's..Mini" at max_len=12
fn truncate_name(name: &str, max_len: usize) -> String {
    if name.chars().count() <= max_len {
        name.to_string()
    } else if max_len < 5 {
        name.chars().take(max_len).collect()
    } else {
        let ellipsis = "..";
        let avail = max_len - ellipsis.len();
        let prefix_len = (avail + 1) / 2;
        let suffix_len = avail / 2;
        let prefix: String = name.chars().take(prefix_len).collect();
        let suffix: String = name.chars().rev().take(suffix_len).collect::<Vec<_>>().into_iter().rev().collect();
        format!("{}{}{}", prefix, ellipsis, suffix)
    }
}
