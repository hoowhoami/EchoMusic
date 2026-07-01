CREATE TABLE IF NOT EXISTS plugin_stats (
  source_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '',
  source_url TEXT NOT NULL DEFAULT '',
  source_name TEXT NOT NULL DEFAULT '',
  repo TEXT NOT NULL DEFAULT '',
  package_path TEXT NOT NULL DEFAULT '',
  download_url TEXT NOT NULL DEFAULT '',
  checksum TEXT NOT NULL DEFAULT '',
  install_count INTEGER NOT NULL DEFAULT 0,
  update_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  last_installed_at TEXT NOT NULL DEFAULT '',
  last_updated_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (source_id, plugin_id)
);

CREATE TABLE IF NOT EXISTS plugin_daily_stats (
  source_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  day TEXT NOT NULL,
  install_count INTEGER NOT NULL DEFAULT 0,
  update_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (source_id, plugin_id, day)
);

CREATE INDEX IF NOT EXISTS idx_plugin_stats_installs
  ON plugin_stats (install_count DESC, update_count DESC);

CREATE INDEX IF NOT EXISTS idx_plugin_daily_stats_day
  ON plugin_daily_stats (day DESC);
