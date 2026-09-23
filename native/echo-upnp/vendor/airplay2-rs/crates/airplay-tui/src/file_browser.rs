//! File browser state and logic.

#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::fs;
use tracing::{debug, warn, info, instrument};

/// Supported audio file extensions.
const AUDIO_EXTENSIONS: &[&str] = &["mp3", "flac", "wav", "ogg", "m4a", "aiff", "aac"];

/// Entry in the file browser.
#[derive(Debug, Clone)]
pub struct FileEntry {
    pub name: String,
    pub path: PathBuf,
    pub is_dir: bool,
    pub size: Option<u64>,
}

impl FileEntry {
    /// Check if this entry is an audio file.
    pub fn is_audio(&self) -> bool {
        if self.is_dir {
            return false;
        }
        self.path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| AUDIO_EXTENSIONS.contains(&e.to_lowercase().as_str()))
            .unwrap_or(false)
    }
}

/// File browser state.
#[derive(Debug)]
pub struct FileBrowser {
    /// Current directory.
    pub current_dir: PathBuf,
    /// Entries in current directory.
    pub entries: Vec<FileEntry>,
    /// Selected index.
    pub selected: usize,
    /// Error message (if any).
    pub error: Option<String>,
}

impl Default for FileBrowser {
    fn default() -> Self {
        let current_dir = std::env::current_dir()
            .or_else(|_| dirs::home_dir().ok_or(()))
            .unwrap_or_else(|_| PathBuf::from("/"));

        let mut browser = Self {
            current_dir: current_dir.clone(),
            entries: Vec::new(),
            selected: 0,
            error: None,
        };
        browser.refresh();
        browser
    }
}

impl FileBrowser {
    /// Create new file browser starting at the given directory.
    pub fn new(path: impl AsRef<Path>) -> Self {
        let current_dir = path.as_ref().to_path_buf();
        let mut browser = Self {
            current_dir: current_dir.clone(),
            entries: Vec::new(),
            selected: 0,
            error: None,
        };
        browser.refresh();
        browser
    }

    /// Refresh the current directory listing.
    #[instrument(skip(self), name = "file_browser::refresh", fields(dir = %self.current_dir.display()))]
    pub fn refresh(&mut self) {
        debug!("Refreshing directory: {:?}", self.current_dir);
        self.entries.clear();
        self.error = None;

        match fs::read_dir(&self.current_dir) {
            Ok(entries) => {
                let mut dirs = Vec::new();
                let mut files = Vec::new();
                let mut count = 0;

                for entry in entries.flatten() {
                    count += 1;
                    // Limit entries to prevent memory issues with huge directories
                    if count > 10000 {
                        warn!("Directory has more than 10000 entries, truncating");
                        break;
                    }

                    let path = entry.path();
                    let name = entry.file_name().to_string_lossy().to_string();

                    // Skip hidden files
                    if name.starts_with('.') {
                        continue;
                    }

                    let is_dir = path.is_dir();
                    let size = if is_dir {
                        None
                    } else {
                        entry.metadata().ok().map(|m| m.len())
                    };

                    let file_entry = FileEntry {
                        name,
                        path,
                        is_dir,
                        size,
                    };

                    if is_dir {
                        dirs.push(file_entry);
                    } else if file_entry.is_audio() {
                        files.push(file_entry);
                    }
                }

                debug!("Found {} dirs, {} audio files", dirs.len(), files.len());

                // Sort directories and files alphabetically
                dirs.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
                files.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

                // Add parent directory entry if not at root
                if let Some(parent) = self.current_dir.parent() {
                    self.entries.push(FileEntry {
                        name: "..".to_string(),
                        path: parent.to_path_buf(),
                        is_dir: true,
                        size: None,
                    });
                }

                self.entries.extend(dirs);
                self.entries.extend(files);
                debug!("Total entries: {}", self.entries.len());
            }
            Err(e) => {
                warn!("Failed to read directory {:?}: {}", self.current_dir, e);
                self.error = Some(format!("Failed to read directory: {}", e));
            }
        }

        // Reset selection if out of bounds
        if self.selected >= self.entries.len() {
            self.selected = self.entries.len().saturating_sub(1);
        }
    }

    /// Navigate to a directory.
    pub fn navigate(&mut self, path: impl AsRef<Path>) {
        let path = path.as_ref();
        info!("Navigating to: {:?}", path);
        if path.is_dir() {
            self.current_dir = path.to_path_buf();
            self.selected = 0;
            self.refresh();
        } else {
            warn!("Cannot navigate to {:?} - not a directory", path);
        }
    }

    /// Navigate to parent directory.
    pub fn go_up(&mut self) {
        if let Some(parent) = self.current_dir.parent() {
            let old_dir = self.current_dir.clone();
            self.current_dir = parent.to_path_buf();
            self.refresh();

            // Try to select the directory we came from
            for (i, entry) in self.entries.iter().enumerate() {
                if entry.path == old_dir {
                    self.selected = i;
                    break;
                }
            }
        }
    }

    /// Select previous entry.
    pub fn select_prev(&mut self) {
        if self.selected > 0 {
            self.selected -= 1;
        }
    }

    /// Select next entry.
    pub fn select_next(&mut self) {
        if !self.entries.is_empty() && self.selected < self.entries.len() - 1 {
            self.selected += 1;
        }
    }

    /// Get selected entry.
    pub fn selected_entry(&self) -> Option<&FileEntry> {
        self.entries.get(self.selected)
    }

    /// Activate selected entry (navigate to dir or return file path).
    #[instrument(skip(self), name = "file_browser::activate")]
    pub fn activate(&mut self) -> Option<PathBuf> {
        if let Some(entry) = self.selected_entry().cloned() {
            info!("Activating entry: {} (is_dir: {})", entry.name, entry.is_dir);
            if entry.is_dir {
                debug!("Navigating to directory: {:?}", entry.path);
                self.navigate(&entry.path);
                None
            } else {
                info!("Returning file for playback: {:?}", entry.path);
                Some(entry.path)
            }
        } else {
            warn!("No entry selected to activate");
            None
        }
    }

    /// Get breadcrumb path components.
    pub fn breadcrumbs(&self) -> Vec<String> {
        let mut parts = Vec::new();
        for component in self.current_dir.components() {
            parts.push(component.as_os_str().to_string_lossy().to_string());
        }
        if parts.is_empty() {
            parts.push("/".to_string());
        }
        parts
    }

    /// Format file size for display.
    pub fn format_size(size: u64) -> String {
        const KB: u64 = 1024;
        const MB: u64 = KB * 1024;
        const GB: u64 = MB * 1024;

        if size >= GB {
            format!("{:.1} GB", size as f64 / GB as f64)
        } else if size >= MB {
            format!("{:.1} MB", size as f64 / MB as f64)
        } else if size >= KB {
            format!("{:.1} KB", size as f64 / KB as f64)
        } else {
            format!("{} B", size)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_size_bytes() {
        assert_eq!(FileBrowser::format_size(100), "100 B");
    }

    #[test]
    fn format_size_kb() {
        assert_eq!(FileBrowser::format_size(1500), "1.5 KB");
    }

    #[test]
    fn format_size_mb() {
        assert_eq!(FileBrowser::format_size(1500 * 1024), "1.5 MB");
    }

    #[test]
    fn audio_extensions_detected() {
        let entry = FileEntry {
            name: "test.mp3".to_string(),
            path: PathBuf::from("/test.mp3"),
            is_dir: false,
            size: Some(1000),
        };
        assert!(entry.is_audio());

        let entry = FileEntry {
            name: "test.txt".to_string(),
            path: PathBuf::from("/test.txt"),
            is_dir: false,
            size: Some(1000),
        };
        assert!(!entry.is_audio());
    }

    #[test]
    fn dirs_not_audio() {
        let entry = FileEntry {
            name: "music".to_string(),
            path: PathBuf::from("/music"),
            is_dir: true,
            size: None,
        };
        assert!(!entry.is_audio());
    }
}
