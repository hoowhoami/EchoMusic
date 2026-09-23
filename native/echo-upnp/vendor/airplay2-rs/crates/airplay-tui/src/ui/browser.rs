//! File browser view.

use ratatui::{
    layout::{Constraint, Direction, Layout},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, List, ListItem, ListState, Paragraph},
    Frame,
};
use ratatui::layout::Rect;

use crate::file_browser::FileBrowser;

/// Render the file browser view.
pub fn render_browser(frame: &mut Frame, area: Rect, browser: &FileBrowser) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3), // Breadcrumb path
            Constraint::Min(0),    // File list
        ])
        .split(area);

    // Breadcrumb path
    let path_display = browser.current_dir.display().to_string();
    let path_para = Paragraph::new(Line::from(vec![
        Span::styled("Path: ", Style::default().fg(Color::DarkGray)),
        Span::styled(path_display, Style::default().fg(Color::Cyan)),
    ]))
    .block(Block::default().borders(Borders::ALL).title(" Location "));
    frame.render_widget(path_para, chunks[0]);

    // File list
    let items: Vec<ListItem> = browser
        .entries
        .iter()
        .map(|entry| {
            let (icon, style) = if entry.is_dir {
                ("📁 ", Style::default().fg(Color::Blue))
            } else {
                ("🎵 ", Style::default().fg(Color::Green))
            };

            let size_str = if let Some(size) = entry.size {
                format!("  {}", FileBrowser::format_size(size))
            } else {
                String::new()
            };

            let content = Line::from(vec![
                Span::raw(icon),
                Span::styled(&entry.name, style),
                Span::styled(size_str, Style::default().fg(Color::DarkGray)),
            ]);

            ListItem::new(content)
        })
        .collect();

    let title = if let Some(ref error) = browser.error {
        format!(" Files - Error: {} ", error)
    } else {
        format!(" Files ({}) ", browser.entries.len())
    };

    let file_list = List::new(items)
        .block(Block::default().borders(Borders::ALL).title(title))
        .highlight_style(
            Style::default()
                .bg(Color::DarkGray)
                .add_modifier(Modifier::BOLD),
        )
        .highlight_symbol("> ");

    let mut list_state = ListState::default();
    if !browser.entries.is_empty() {
        list_state.select(Some(browser.selected));
    }

    frame.render_stateful_widget(file_list, chunks[1], &mut list_state);
}
