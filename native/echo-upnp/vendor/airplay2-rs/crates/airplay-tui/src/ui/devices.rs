//! Device discovery and list view.

use ratatui::{
    layout::{Constraint, Direction, Layout},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, List, ListItem, ListState, Paragraph},
    Frame,
};
use ratatui::layout::Rect;

use crate::state::AppState;

/// Render the devices view.
pub fn render_devices(frame: &mut Frame, area: Rect, state: &AppState) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3), // Connection status
            Constraint::Min(0),    // Device list
        ])
        .split(area);

    // Connection status (priority: scanning > connecting > group > connected > not connected)
    let status_text = if state.scanning {
        Line::from(vec![
            Span::styled("Scanning", Style::default().fg(Color::Yellow)),
            Span::raw("..."),
        ])
    } else if state.connecting {
        Line::from(Span::styled("Connecting...", Style::default().fg(Color::Yellow)))
    } else if let Some(ref group) = state.group {
        let member_count = group.members.len();
        let others = member_count.saturating_sub(1);
        Line::from(vec![
            Span::styled("Group: ", Style::default().fg(Color::Green)),
            Span::styled(&group.leader.name, Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)),
            Span::styled(
                format!(" + {} other{}", others, if others == 1 { "" } else { "s" }),
                Style::default().fg(Color::Green),
            ),
        ])
    } else if let Some(ref device) = state.connected_device {
        Line::from(vec![
            Span::styled("Connected to: ", Style::default().fg(Color::Green)),
            Span::styled(&device.name, Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)),
        ])
    } else {
        Line::from(Span::styled(
            "Not connected",
            Style::default().fg(Color::DarkGray),
        ))
    };

    let status = Paragraph::new(status_text)
        .block(Block::default().borders(Borders::ALL).title(" Status "));
    frame.render_widget(status, chunks[0]);

    // Determine group leader and member IDs for badge rendering
    let group_leader_id = state.group.as_ref().map(|g| &g.leader.id);
    let group_member_ids: Vec<_> = state.group.as_ref()
        .map(|g| g.members.iter().map(|m| &m.device.id).collect())
        .unwrap_or_default();

    // Device list
    let items: Vec<ListItem> = state
        .devices
        .iter()
        .map(|entry| {
            let device = &entry.device;
            let selected_marker = if entry.is_selected { " *" } else { "" };

            let style = if entry.is_connected {
                Style::default().fg(Color::Green)
            } else {
                Style::default()
            };

            // Extract IPv4 address (prefer IPv4 over IPv6)
            let ipv4_addr = device.addresses.iter()
                .find(|addr| addr.is_ipv4())
                .map(|addr| format!(" ({})", addr))
                .unwrap_or_default();

            // Determine badge: [leader], [group], or [connected]
            let badge = if group_leader_id == Some(&device.id) {
                Span::styled(" [leader]", Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD))
            } else if group_member_ids.contains(&&device.id) {
                Span::styled(" [group]", Style::default().fg(Color::Green))
            } else if entry.is_connected {
                Span::styled(" [connected]", Style::default().fg(Color::Green))
            } else {
                Span::raw("")
            };

            let content = Line::from(vec![
                Span::styled(&device.name, style.add_modifier(Modifier::BOLD)),
                Span::styled(ipv4_addr, Style::default().fg(Color::Cyan)),
                badge,
                Span::styled(selected_marker, Style::default().fg(Color::Yellow)),
                Span::raw(" - "),
                Span::styled(&device.model, Style::default().fg(Color::DarkGray)),
            ]);

            ListItem::new(content)
        })
        .collect();

    let title = if state.scanning {
        " Devices (scanning...) "
    } else if state.group.is_some() {
        " Devices (group active) "
    } else {
        " Devices "
    };

    let device_list = List::new(items)
        .block(Block::default().borders(Borders::ALL).title(title))
        .highlight_style(
            Style::default()
                .bg(Color::DarkGray)
                .add_modifier(Modifier::BOLD),
        )
        .highlight_symbol("> ");

    let mut list_state = ListState::default();
    if !state.devices.is_empty() {
        list_state.select(Some(state.device_index));
    }

    frame.render_stateful_widget(device_list, chunks[1], &mut list_state);
}
