export const PLUGIN_STATE_KEY = 'plugins:enabled';
export const PLUGIN_SAFE_MODE_KEY = 'plugins:safe-mode';
export const PLUGIN_LAST_FAILURE_KEY = 'plugins:last-failure';
export const PLUGIN_STARTUP_SESSION_KEY = 'plugins:startup-session';
export const PLUGIN_ACTIVE_SESSION_KEY = 'plugins:active-session';
export const PLUGIN_INSTALL_TIMES_KEY = 'plugins:install-times';
export const PLUGIN_MARKETPLACE_SOURCES_KEY = 'plugins:marketplace:sources';
export const PLUGIN_MARKETPLACE_CACHE_KEY = 'plugins:marketplace:cache';
export const PLUGIN_PROCESS_CONSENTS_KEY = 'plugins:process-consents';
export const PLUGIN_MANIFEST_FILE = 'manifest.json';
export const PLUGIN_MARKETPLACE_INDEX_FILE = 'echo-plugins.json';
export const PLUGIN_MARKETPLACE_CACHE_VERSION = 4;
export const DEFAULT_PLUGIN_MARKETPLACE_SOURCE_URL =
  'https://github.com/hoowhoami/EchoMusicPlugins';
export const DEFAULT_PLUGIN_MARKETPLACE_SOURCE_ID = 'github:hoowhoami/echomusicplugins';

export const PLUGIN_IMAGE_EXTENSIONS = new Set([
  '.apng',
  '.avif',
  '.gif',
  '.jpg',
  '.jpeg',
  '.png',
  '.svg',
  '.webp',
]);
export const PLUGIN_AUDIO_EXTENSIONS = new Set([
  '.aac',
  '.aif',
  '.aiff',
  '.alac',
  '.ape',
  '.dff',
  '.dsf',
  '.flac',
  '.m4a',
  '.mp3',
  '.oga',
  '.ogg',
  '.opus',
  '.wav',
  '.webm',
  '.wma',
  '.wv',
]);
export const PLUGIN_LYRIC_EXTENSIONS = new Set(['.krc', '.lrc', '.qrc', '.srt', '.ttml', '.txt']);
export const PLUGIN_PLAYLIST_EXTENSIONS = new Set(['.m3u', '.m3u8', '.pls']);
export const PLUGIN_CUE_EXTENSIONS = new Set(['.cue']);

export const MAX_PLUGIN_IMAGE_SCAN_LIMIT = 1000;
export const DEFAULT_PLUGIN_FILE_SCAN_LIMIT = 2000;
export const MAX_PLUGIN_FILE_SCAN_LIMIT = 10000;
export const DEFAULT_PLUGIN_READ_BYTES = 1024 * 1024;
export const MAX_PLUGIN_READ_BYTES = 4 * 1024 * 1024;
export const MAX_PLUGIN_WRITE_BYTES = 8 * 1024 * 1024;
export const PLUGIN_WINDOW_MIN_WIDTH = 180;
export const PLUGIN_WINDOW_MIN_HEIGHT = 48;
export const PLUGIN_WINDOW_MAX_WIDTH = 1400;
export const PLUGIN_WINDOW_MAX_HEIGHT = 900;
export const PLUGIN_MARKETPLACE_FETCH_TIMEOUT_MS = 30_000;
export const PLUGIN_MARKETPLACE_DOWNLOAD_TIMEOUT_MS = 180_000;
export const PLUGIN_MARKETPLACE_EXTRACT_TIMEOUT_MS = 120_000;
export const BARE_SEMVER_PATTERN = /^v?\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
export const MAX_PLUGIN_PROCESS_ARGS = 64;
export const MAX_PLUGIN_PROCESS_ARG_LENGTH = 8192;
export const MAX_PLUGIN_PROCESS_ENV_ENTRIES = 64;
export const MAX_PLUGIN_PROCESS_ENV_VALUE_LENGTH = 8192;
export const MAX_PLUGIN_PACKAGE_SIZE_BYTES = 80 * 1024 * 1024;
export const WINDOWS_EXECUTABLE_EXTENSIONS = new Set(['.exe', '.com']);
export const BLOCKED_PLUGIN_PROCESS_ENV_KEYS = new Set([
  'ECHOMUSIC_PLUGIN_DIR',
  'ECHOMUSIC_PLUGIN_ID',
  'ELECTRON_RUN_AS_NODE',
  'NODE_OPTIONS',
  'DYLD_INSERT_LIBRARIES',
  'LD_PRELOAD',
]);

export const normalizePluginId = (value: unknown) =>
  String(value ?? '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, '');

export const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

export const comparePluginText = (left: string, right: string) =>
  left.localeCompare(right, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' });
