use napi_derive::napi;
use once_cell::sync::Lazy;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::{json, Map, Value};
use std::sync::Mutex;

const DEFAULT_PLAYBACK_QUEUE_ID: &str = "queue:default";

static DATABASE: Lazy<Mutex<Option<Connection>>> = Lazy::new(|| Mutex::new(None));

type NativeResult<T> = napi::Result<T>;

#[derive(Clone)]
struct QueueData {
    id: String,
    title: String,
    subtitle: String,
    cover_url: String,
    queue_type: String,
    songs: Vec<Value>,
    filtered_invalid_count: i64,
    queued_next_track_ids: Vec<String>,
    current_track_id: Option<String>,
    created_at: i64,
    updated_at: i64,
    dynamic: bool,
    meta: Value,
}

struct QueueRow {
    id: String,
    title: String,
    subtitle: String,
    cover_url: String,
    queue_type: String,
    active: i64,
    last_non_fm: i64,
    current_track_id: Option<String>,
    filtered_invalid_count: i64,
    queued_next_track_ids_json: String,
    dynamic: i64,
    meta_json: String,
    created_at: i64,
    updated_at: i64,
}

fn err(reason: impl Into<String>) -> napi::Error {
    napi::Error::from_reason(reason.into())
}

fn map_sql<T>(result: rusqlite::Result<T>) -> NativeResult<T> {
    result.map_err(|error| err(format!("SQLite error: {error}")))
}

fn map_json<T>(result: serde_json::Result<T>) -> NativeResult<T> {
    result.map_err(|error| err(format!("JSON error: {error}")))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn with_connection<T>(callback: impl FnOnce(&Connection) -> NativeResult<T>) -> NativeResult<T> {
    let guard = DATABASE
        .lock()
        .map_err(|error| err(format!("Database lock failed: {error}")))?;
    let connection = guard
        .as_ref()
        .ok_or_else(|| err("Storage database is not initialized"))?;
    callback(connection)
}

fn with_connection_mut<T>(
    callback: impl FnOnce(&mut Connection) -> NativeResult<T>,
) -> NativeResult<T> {
    let mut guard = DATABASE
        .lock()
        .map_err(|error| err(format!("Database lock failed: {error}")))?;
    let connection = guard
        .as_mut()
        .ok_or_else(|| err("Storage database is not initialized"))?;
    callback(connection)
}

fn ensure_schema(connection: &Connection) -> NativeResult<()> {
    map_sql(connection.execute_batch(
        r#"
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;
        PRAGMA synchronous = NORMAL;
        PRAGMA temp_store = MEMORY;
        PRAGMA busy_timeout = 5000;

        CREATE TABLE IF NOT EXISTS app_kv (
          key TEXT PRIMARY KEY,
          value_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS playback_queues (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          subtitle TEXT NOT NULL DEFAULT '',
          cover_url TEXT NOT NULL DEFAULT '',
          type TEXT NOT NULL,
          active INTEGER NOT NULL DEFAULT 0,
          last_non_fm INTEGER NOT NULL DEFAULT 0,
          current_track_id TEXT,
          filtered_invalid_count INTEGER NOT NULL DEFAULT 0,
          queued_next_track_ids_json TEXT NOT NULL DEFAULT '[]',
          dynamic INTEGER NOT NULL DEFAULT 0,
          meta_json TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS songs (
          song_key TEXT PRIMARY KEY,
          source_id TEXT,
          hash TEXT,
          title TEXT NOT NULL,
          artist TEXT NOT NULL DEFAULT '',
          album TEXT NOT NULL DEFAULT '',
          cover_url TEXT NOT NULL DEFAULT '',
          duration INTEGER NOT NULL DEFAULT 0,
          payload_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS queue_items (
          queue_id TEXT NOT NULL,
          song_key TEXT NOT NULL,
          position INTEGER NOT NULL,
          added_at INTEGER NOT NULL,
          PRIMARY KEY (queue_id, position),
          FOREIGN KEY (queue_id) REFERENCES playback_queues(id) ON DELETE CASCADE,
          FOREIGN KEY (song_key) REFERENCES songs(song_key) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_queue_items_queue_position
          ON queue_items(queue_id, position);

        CREATE INDEX IF NOT EXISTS idx_queue_items_song_key
          ON queue_items(song_key);
        "#,
    ))
}

fn parse_json(value: &str) -> NativeResult<Value> {
    map_json(serde_json::from_str(value))
}

fn parse_payload(value: &str) -> NativeResult<Map<String, Value>> {
    match parse_json(value)? {
        Value::Object(map) => Ok(map),
        _ => Err(err("Storage payload must be a JSON object")),
    }
}

fn json_string(value: &Value) -> Option<String> {
    match value {
        Value::String(value) => Some(value.clone()),
        Value::Number(value) => Some(value.to_string()),
        Value::Bool(value) => Some(value.to_string()),
        _ => None,
    }
}

fn string_prop(map: &Map<String, Value>, key: &str, fallback: &str) -> String {
    map.get(key)
        .and_then(json_string)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| fallback.to_string())
}

fn optional_string_prop(map: &Map<String, Value>, key: &str) -> Option<String> {
    map.get(key)
        .and_then(json_string)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn int_prop(map: &Map<String, Value>, key: &str, fallback: i64) -> i64 {
    match map.get(key) {
        Some(Value::Number(value)) => value
            .as_i64()
            .or_else(|| value.as_u64().and_then(|value| i64::try_from(value).ok()))
            .or_else(|| value.as_f64().map(|value| value.floor() as i64))
            .unwrap_or(fallback),
        Some(Value::String(value)) => value.parse::<i64>().unwrap_or(fallback),
        _ => fallback,
    }
}

fn bool_prop(map: &Map<String, Value>, key: &str, fallback: bool) -> bool {
    match map.get(key) {
        Some(Value::Bool(value)) => *value,
        Some(Value::Number(value)) => value.as_i64().unwrap_or(0) != 0,
        Some(Value::String(value)) => value == "true" || value == "1",
        _ => fallback,
    }
}

fn array_strings(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::Array(values)) => values
            .iter()
            .filter_map(json_string)
            .filter(|value| !value.is_empty())
            .collect(),
        _ => Vec::new(),
    }
}

fn object_or_empty(value: Option<&Value>) -> Value {
    match value {
        Some(Value::Object(_)) => value.cloned().unwrap_or_else(|| json!({})),
        _ => json!({}),
    }
}

fn normalize_queue(value: &Value) -> QueueData {
    let map = value.as_object().cloned().unwrap_or_default();
    let current_track_id = match map.get("currentTrackId") {
        Some(Value::Null) | None => None,
        Some(value) => json_string(value).filter(|value| !value.is_empty()),
    };
    let songs = match map.get("songs") {
        Some(Value::Array(songs)) => songs.clone(),
        _ => Vec::new(),
    };

    QueueData {
        id: string_prop(&map, "id", DEFAULT_PLAYBACK_QUEUE_ID),
        title: string_prop(&map, "title", "播放列表"),
        subtitle: string_prop(&map, "subtitle", ""),
        cover_url: string_prop(&map, "coverUrl", ""),
        queue_type: string_prop(&map, "type", "default"),
        songs,
        filtered_invalid_count: int_prop(&map, "filteredInvalidCount", 0).max(0),
        queued_next_track_ids: array_strings(map.get("queuedNextTrackIds")),
        current_track_id,
        created_at: int_prop(&map, "createdAt", now_ms()),
        updated_at: int_prop(&map, "updatedAt", now_ms()),
        dynamic: bool_prop(&map, "dynamic", false),
        meta: object_or_empty(map.get("meta")),
    }
}

fn queue_from_payload(payload: &Map<String, Value>) -> NativeResult<QueueData> {
    let queue = payload
        .get("queue")
        .ok_or_else(|| err("Storage payload is missing queue"))?;
    Ok(normalize_queue(queue))
}

fn selection_from_payload(payload: &Map<String, Value>) -> (String, String) {
    let active_queue_id = optional_string_prop(payload, "activeQueueId")
        .unwrap_or_else(|| DEFAULT_PLAYBACK_QUEUE_ID.to_string());
    let last_non_fm_queue_id = optional_string_prop(payload, "lastNonFmQueueId")
        .unwrap_or_else(|| active_queue_id.clone());
    (active_queue_id, last_non_fm_queue_id)
}

fn ok_json() -> String {
    r#"{"ok":true}"#.to_string()
}

fn parse_json_fallback(value: &str, fallback: Value) -> Value {
    serde_json::from_str(value).unwrap_or(fallback)
}

fn normalize_song_key(song: &Value) -> String {
    let map = song.as_object().cloned().unwrap_or_default();
    let mix_song_id = optional_string_prop(&map, "mixSongId").unwrap_or_default();
    if !mix_song_id.is_empty() && mix_song_id != "0" {
        return format!("mx:{mix_song_id}");
    }

    let hash = optional_string_prop(&map, "hash").unwrap_or_default();
    if !hash.is_empty() {
        return format!("hash:{}", hash.to_lowercase());
    }

    let file_id = optional_string_prop(&map, "fileId").unwrap_or_default();
    if !file_id.is_empty() {
        return format!("file:{file_id}");
    }

    format!(
        "id:{}",
        optional_string_prop(&map, "id").unwrap_or_default()
    )
}

fn song_field(song: &Value, primary: &str, secondary: Option<&str>) -> String {
    let map = song.as_object().cloned().unwrap_or_default();
    optional_string_prop(&map, primary)
        .or_else(|| secondary.and_then(|key| optional_string_prop(&map, key)))
        .unwrap_or_default()
}

fn song_duration(song: &Value) -> i64 {
    let map = song.as_object().cloned().unwrap_or_default();
    int_prop(&map, "duration", 0).max(0)
}

fn upsert_queue(
    tx: &Transaction<'_>,
    queue: &QueueData,
    active: bool,
    last_non_fm: bool,
) -> NativeResult<()> {
    let queued_next_track_ids_json = map_json(serde_json::to_string(&queue.queued_next_track_ids))?;
    let meta_json = map_json(serde_json::to_string(&queue.meta))?;
    map_sql(tx.execute(
        r#"
        INSERT INTO playback_queues (
          id, title, subtitle, cover_url, type, active, last_non_fm, current_track_id,
          filtered_invalid_count, queued_next_track_ids_json, dynamic, meta_json, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          subtitle = excluded.subtitle,
          cover_url = excluded.cover_url,
          type = excluded.type,
          active = excluded.active,
          last_non_fm = excluded.last_non_fm,
          current_track_id = excluded.current_track_id,
          filtered_invalid_count = excluded.filtered_invalid_count,
          queued_next_track_ids_json = excluded.queued_next_track_ids_json,
          dynamic = excluded.dynamic,
          meta_json = excluded.meta_json,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
        "#,
        params![
            queue.id,
            queue.title,
            queue.subtitle,
            queue.cover_url,
            queue.queue_type,
            if active { 1 } else { 0 },
            if last_non_fm { 1 } else { 0 },
            queue.current_track_id,
            queue.filtered_invalid_count,
            queued_next_track_ids_json,
            if queue.dynamic { 1 } else { 0 },
            meta_json,
            queue.created_at,
            queue.updated_at
        ],
    ))?;
    Ok(())
}

fn update_queue_flags(
    tx: &Transaction<'_>,
    active_queue_id: &str,
    last_non_fm_queue_id: &str,
) -> NativeResult<()> {
    map_sql(tx.execute(
        r#"
        UPDATE playback_queues
        SET active = CASE WHEN id = ? THEN 1 ELSE 0 END,
            last_non_fm = CASE WHEN id = ? THEN 1 ELSE 0 END
        "#,
        params![active_queue_id, last_non_fm_queue_id],
    ))?;
    Ok(())
}

fn upsert_song(tx: &Transaction<'_>, song: &Value, now: i64) -> NativeResult<String> {
    let song_key = normalize_song_key(song);
    let payload_json = map_json(serde_json::to_string(song))?;
    map_sql(tx.execute(
        r#"
        INSERT INTO songs (
          song_key, source_id, hash, title, artist, album, cover_url, duration, payload_json, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(song_key) DO UPDATE SET
          source_id = excluded.source_id,
          hash = excluded.hash,
          title = excluded.title,
          artist = excluded.artist,
          album = excluded.album,
          cover_url = excluded.cover_url,
          duration = excluded.duration,
          payload_json = excluded.payload_json,
          updated_at = excluded.updated_at
        "#,
        params![
            song_key,
            song_field(song, "id", None),
            song_field(song, "hash", None),
            song_field(song, "title", Some("name")),
            song_field(song, "artist", None),
            song_field(song, "album", Some("albumName")),
            song_field(song, "coverUrl", Some("cover")),
            song_duration(song),
            payload_json,
            now
        ],
    ))?;
    Ok(song_key)
}

fn replace_queue_items(tx: &Transaction<'_>, queue_id: &str, songs: &[Value]) -> NativeResult<()> {
    let now = now_ms();
    map_sql(tx.execute(
        "DELETE FROM queue_items WHERE queue_id = ?",
        params![queue_id],
    ))?;
    for (index, song) in songs.iter().enumerate() {
        let song_key = upsert_song(tx, song, now)?;
        map_sql(tx.execute(
            "INSERT INTO queue_items (queue_id, song_key, position, added_at) VALUES (?, ?, ?, ?)",
            params![queue_id, song_key, index as i64, now],
        ))?;
    }
    Ok(())
}

fn append_queue_items(tx: &Transaction<'_>, queue_id: &str, songs: &[Value]) -> NativeResult<()> {
    if songs.is_empty() {
        return Ok(());
    }

    let now = now_ms();
    let mut position: i64 = map_sql(tx.query_row(
        "SELECT COALESCE(MAX(position), -1) + 1 FROM queue_items WHERE queue_id = ?",
        params![queue_id],
        |row| row.get(0),
    ))?;

    for song in songs {
        let song_key = upsert_song(tx, song, now)?;
        map_sql(tx.execute(
            "INSERT INTO queue_items (queue_id, song_key, position, added_at) VALUES (?, ?, ?, ?)",
            params![queue_id, song_key, position, now],
        ))?;
        position += 1;
    }
    Ok(())
}

fn queue_selection(connection: &Connection) -> NativeResult<(String, String)> {
    let mut stmt =
        map_sql(connection.prepare("SELECT id, type, active, last_non_fm FROM playback_queues"))?;
    let rows = map_sql(stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, i64>(3)?,
        ))
    }))?;

    let mut values = Vec::new();
    for row in rows {
        values.push(map_sql(row)?);
    }

    let active_queue_id = values
        .iter()
        .find(|(_, _, active, _)| *active == 1)
        .map(|(id, _, _, _)| id.clone())
        .or_else(|| values.first().map(|(id, _, _, _)| id.clone()))
        .unwrap_or_else(|| DEFAULT_PLAYBACK_QUEUE_ID.to_string());

    let last_non_fm_queue_id = values
        .iter()
        .find(|(_, _, _, last_non_fm)| *last_non_fm == 1)
        .map(|(id, _, _, _)| id.clone())
        .or_else(|| {
            values
                .iter()
                .find(|(_, queue_type, _, _)| queue_type != "fm")
                .map(|(id, _, _, _)| id.clone())
        })
        .unwrap_or_else(|| active_queue_id.clone());

    Ok((active_queue_id, last_non_fm_queue_id))
}

fn queue_song_count(connection: &Connection, queue_id: &str) -> NativeResult<i64> {
    map_sql(connection.query_row(
        "SELECT COUNT(*) FROM queue_items WHERE queue_id = ?",
        params![queue_id],
        |row| row.get::<_, i64>(0),
    ))
}

fn hydrate_queue(
    connection: &Connection,
    row: &QueueRow,
    include_songs: bool,
) -> NativeResult<Value> {
    let song_count = queue_song_count(connection, &row.id)?.max(0);
    let songs = if include_songs {
        let mut stmt = map_sql(connection.prepare(
            r#"
            SELECT songs.payload_json
            FROM queue_items
            INNER JOIN songs ON songs.song_key = queue_items.song_key
            WHERE queue_items.queue_id = ?
            ORDER BY queue_items.position ASC
            "#,
        ))?;
        let rows =
            map_sql(stmt.query_map(params![row.id], |song_row| song_row.get::<_, String>(0)))?;
        let mut values = Vec::new();
        for song_row in rows {
            let payload_json = map_sql(song_row)?;
            if let Ok(song) = serde_json::from_str::<Value>(&payload_json) {
                values.push(song);
            }
        }
        values
    } else {
        Vec::new()
    };

    Ok(json!({
        "id": row.id,
        "title": row.title,
        "subtitle": row.subtitle,
        "coverUrl": row.cover_url,
        "type": row.queue_type,
        "songs": songs,
        "songCount": song_count,
        "filteredInvalidCount": row.filtered_invalid_count,
        "queuedNextTrackIds": parse_json_fallback(&row.queued_next_track_ids_json, json!([])),
        "currentTrackId": row.current_track_id,
        "createdAt": row.created_at,
        "updatedAt": row.updated_at,
        "dynamic": row.dynamic == 1,
        "meta": parse_json_fallback(&row.meta_json, json!({})),
    }))
}

fn all_queue_rows(connection: &Connection) -> NativeResult<Vec<QueueRow>> {
    let mut stmt = map_sql(connection.prepare(
        r#"
        SELECT id, title, subtitle, cover_url, type, active, last_non_fm, current_track_id,
               filtered_invalid_count, queued_next_track_ids_json, dynamic, meta_json,
               created_at, updated_at
        FROM playback_queues
        ORDER BY updated_at DESC, created_at DESC
        "#,
    ))?;
    let rows = map_sql(stmt.query_map([], |row| {
        Ok(QueueRow {
            id: row.get(0)?,
            title: row.get(1)?,
            subtitle: row.get(2)?,
            cover_url: row.get(3)?,
            queue_type: row.get(4)?,
            active: row.get(5)?,
            last_non_fm: row.get(6)?,
            current_track_id: row.get(7)?,
            filtered_invalid_count: row.get(8)?,
            queued_next_track_ids_json: row.get(9)?,
            dynamic: row.get(10)?,
            meta_json: row.get(11)?,
            created_at: row.get(12)?,
            updated_at: row.get(13)?,
        })
    }))?;

    let mut values = Vec::new();
    for row in rows {
        values.push(map_sql(row)?);
    }
    Ok(values)
}

fn snapshot_json(connection: &Connection, hydrate_all_songs: bool) -> NativeResult<String> {
    let rows = all_queue_rows(connection)?;
    let active_queue_id = rows
        .iter()
        .find(|row| row.active == 1)
        .map(|row| row.id.clone())
        .or_else(|| rows.first().map(|row| row.id.clone()))
        .unwrap_or_else(|| DEFAULT_PLAYBACK_QUEUE_ID.to_string());

    let mut queues = Vec::new();
    for row in &rows {
        queues.push(hydrate_queue(
            connection,
            row,
            hydrate_all_songs || row.id == active_queue_id,
        )?);
    }

    let last_non_fm_queue_id = rows
        .iter()
        .find(|row| row.last_non_fm == 1)
        .map(|row| row.id.clone())
        .or_else(|| {
            rows.iter()
                .find(|row| row.queue_type != "fm")
                .map(|row| row.id.clone())
        })
        .unwrap_or_else(|| DEFAULT_PLAYBACK_QUEUE_ID.to_string());

    map_json(serde_json::to_string(&json!({
        "queues": queues,
        "activeQueueId": active_queue_id,
        "lastNonFmQueueId": last_non_fm_queue_id,
    })))
}

fn queue_json_by_id(connection: &Connection, queue_id: &str) -> NativeResult<Option<String>> {
    let row = map_sql(
        connection
            .query_row(
                r#"
                SELECT id, title, subtitle, cover_url, type, active, last_non_fm, current_track_id,
                       filtered_invalid_count, queued_next_track_ids_json, dynamic, meta_json,
                       created_at, updated_at
                FROM playback_queues
                WHERE id = ?
                "#,
                params![queue_id],
                |row| {
                    Ok(QueueRow {
                        id: row.get(0)?,
                        title: row.get(1)?,
                        subtitle: row.get(2)?,
                        cover_url: row.get(3)?,
                        queue_type: row.get(4)?,
                        active: row.get(5)?,
                        last_non_fm: row.get(6)?,
                        current_track_id: row.get(7)?,
                        filtered_invalid_count: row.get(8)?,
                        queued_next_track_ids_json: row.get(9)?,
                        dynamic: row.get(10)?,
                        meta_json: row.get(11)?,
                        created_at: row.get(12)?,
                        updated_at: row.get(13)?,
                    })
                },
            )
            .optional(),
    )?;

    match row {
        Some(row) => Ok(Some(map_json(serde_json::to_string(&hydrate_queue(
            connection, &row, true,
        )?))?)),
        None => Ok(None),
    }
}

#[napi]
pub fn initialize(database_path: String) -> NativeResult<()> {
    let connection = map_sql(Connection::open(database_path))?;
    ensure_schema(&connection)?;
    let mut guard = DATABASE
        .lock()
        .map_err(|error| err(format!("Database lock failed: {error}")))?;
    *guard = Some(connection);
    Ok(())
}

#[napi]
pub fn close() {
    if let Ok(mut guard) = DATABASE.lock() {
        *guard = None;
    }
}

#[napi]
pub fn kv_get(key: String) -> NativeResult<Option<String>> {
    with_connection(|connection| {
        map_sql(
            connection
                .query_row(
                    "SELECT value_json FROM app_kv WHERE key = ?",
                    params![key],
                    |row| row.get::<_, String>(0),
                )
                .optional(),
        )
    })
}

#[napi]
pub fn kv_set(key: String, value_json: String) -> NativeResult<()> {
    with_connection(|connection| {
        map_sql(connection.execute(
            r#"
            INSERT INTO app_kv (key, value_json, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET
              value_json = excluded.value_json,
              updated_at = excluded.updated_at
            "#,
            params![key, value_json, now_ms()],
        ))?;
        Ok(())
    })
}

#[napi]
pub fn kv_delete(key: String) -> NativeResult<()> {
    with_connection(|connection| {
        map_sql(connection.execute("DELETE FROM app_kv WHERE key = ?", params![key]))?;
        Ok(())
    })
}

#[napi]
pub fn reset_all() -> NativeResult<()> {
    with_connection_mut(|connection| {
        let tx = map_sql(connection.transaction())?;
        map_sql(tx.execute("DELETE FROM queue_items", []))?;
        map_sql(tx.execute("DELETE FROM playback_queues", []))?;
        map_sql(tx.execute("DELETE FROM songs", []))?;
        map_sql(tx.execute("DELETE FROM app_kv", []))?;
        map_sql(tx.commit())?;
        Ok(())
    })
}

#[napi]
pub fn playback_get_snapshot(hydrate_all_songs: Option<bool>) -> NativeResult<String> {
    with_connection(|connection| snapshot_json(connection, hydrate_all_songs.unwrap_or(false)))
}

#[napi]
pub fn playback_get_queue(payload_json: String) -> NativeResult<Option<String>> {
    let payload = parse_payload(&payload_json)?;
    let queue_id = optional_string_prop(&payload, "queueId").unwrap_or_default();
    if queue_id.is_empty() {
        return Ok(None);
    }

    with_connection(|connection| queue_json_by_id(connection, &queue_id))
}

#[napi]
pub fn playback_replace_queue(payload_json: String) -> NativeResult<String> {
    let payload = parse_payload(&payload_json)?;
    let queue = queue_from_payload(&payload)?;
    let (active_queue_id, last_non_fm_queue_id) = selection_from_payload(&payload);

    with_connection_mut(|connection| {
        let tx = map_sql(connection.transaction())?;
        upsert_queue(
            &tx,
            &queue,
            queue.id == active_queue_id,
            queue.id == last_non_fm_queue_id,
        )?;
        replace_queue_items(&tx, &queue.id, &queue.songs)?;
        update_queue_flags(&tx, &active_queue_id, &last_non_fm_queue_id)?;
        map_sql(tx.commit())?;
        Ok(ok_json())
    })
}

#[napi]
pub fn playback_append_queue_items(payload_json: String) -> NativeResult<String> {
    let payload = parse_payload(&payload_json)?;
    let queue = queue_from_payload(&payload)?;
    let songs = match payload.get("songs") {
        Some(Value::Array(songs)) => songs.clone(),
        _ => Vec::new(),
    };
    let (active_queue_id, last_non_fm_queue_id) = selection_from_payload(&payload);

    with_connection_mut(|connection| {
        let tx = map_sql(connection.transaction())?;
        upsert_queue(
            &tx,
            &queue,
            queue.id == active_queue_id,
            queue.id == last_non_fm_queue_id,
        )?;
        append_queue_items(&tx, &queue.id, &songs)?;
        update_queue_flags(&tx, &active_queue_id, &last_non_fm_queue_id)?;
        map_sql(tx.commit())?;
        Ok(ok_json())
    })
}

#[napi]
pub fn playback_update_queue_meta(payload_json: String) -> NativeResult<String> {
    let payload = parse_payload(&payload_json)?;
    let queue = queue_from_payload(&payload)?;
    let (active_queue_id, last_non_fm_queue_id) = selection_from_payload(&payload);

    with_connection_mut(|connection| {
        let tx = map_sql(connection.transaction())?;
        upsert_queue(
            &tx,
            &queue,
            queue.id == active_queue_id,
            queue.id == last_non_fm_queue_id,
        )?;
        update_queue_flags(&tx, &active_queue_id, &last_non_fm_queue_id)?;
        map_sql(tx.commit())?;
        Ok(ok_json())
    })
}

#[napi]
pub fn playback_clear_queue(payload_json: String) -> NativeResult<String> {
    let payload = parse_payload(&payload_json)?;
    let queue = queue_from_payload(&payload)?;
    let (active_queue_id, last_non_fm_queue_id) = selection_from_payload(&payload);

    with_connection_mut(|connection| {
        let tx = map_sql(connection.transaction())?;
        upsert_queue(
            &tx,
            &queue,
            queue.id == active_queue_id,
            queue.id == last_non_fm_queue_id,
        )?;
        map_sql(tx.execute(
            "DELETE FROM queue_items WHERE queue_id = ?",
            params![queue.id],
        ))?;
        update_queue_flags(&tx, &active_queue_id, &last_non_fm_queue_id)?;
        map_sql(tx.commit())?;
        Ok(ok_json())
    })
}

#[napi]
pub fn playback_remove_queue(payload_json: String) -> NativeResult<String> {
    let payload = parse_payload(&payload_json)?;
    let queue_id = optional_string_prop(&payload, "queueId").unwrap_or_default();

    with_connection_mut(|connection| {
        if !queue_id.is_empty() {
            map_sql(connection.execute(
                "DELETE FROM playback_queues WHERE id = ?",
                params![queue_id],
            ))?;
        }
        snapshot_json(connection, false)
    })
}

#[napi]
pub fn playback_remove_queue_item(payload_json: String) -> NativeResult<String> {
    let payload = parse_payload(&payload_json)?;
    let queue_id = optional_string_prop(&payload, "queueId").unwrap_or_default();
    let song_id = optional_string_prop(&payload, "songId").unwrap_or_default();
    if queue_id.is_empty() || song_id.is_empty() {
        return Ok(ok_json());
    }

    with_connection_mut(|connection| {
        let queue_json = queue_json_by_id(connection, &queue_id)?;
        let Some(queue_json) = queue_json else {
            return Ok(ok_json());
        };
        let mut queue = parse_json(&queue_json)?;
        let queue_map = queue
            .as_object_mut()
            .ok_or_else(|| err("Hydrated queue is not an object"))?;
        if let Some(Value::Array(songs)) = queue_map.get_mut("songs") {
            songs.retain(|song| {
                let map = song.as_object().cloned().unwrap_or_default();
                optional_string_prop(&map, "id").unwrap_or_default() != song_id
            });
        }
        if let Some(value) = payload.get("queuedNextTrackIds") {
            queue_map.insert("queuedNextTrackIds".to_string(), value.clone());
        }
        if let Some(value) = payload.get("currentTrackId") {
            queue_map.insert("currentTrackId".to_string(), value.clone());
        }
        queue_map.insert(
            "updatedAt".to_string(),
            Value::Number(
                (payload
                    .get("updatedAt")
                    .and_then(Value::as_i64)
                    .unwrap_or_else(now_ms))
                .into(),
            ),
        );

        let next_queue = normalize_queue(&queue);
        let (active_queue_id, last_non_fm_queue_id) = queue_selection(connection)?;
        let tx = map_sql(connection.transaction())?;
        upsert_queue(
            &tx,
            &next_queue,
            next_queue.id == active_queue_id,
            next_queue.id == last_non_fm_queue_id,
        )?;
        replace_queue_items(&tx, &next_queue.id, &next_queue.songs)?;
        update_queue_flags(&tx, &active_queue_id, &last_non_fm_queue_id)?;
        map_sql(tx.commit())?;
        Ok(ok_json())
    })
}

#[napi]
pub fn playback_reorder_queue_items(payload_json: String) -> NativeResult<String> {
    let payload = parse_payload(&payload_json)?;
    let queue_id = optional_string_prop(&payload, "queueId").unwrap_or_default();
    if queue_id.is_empty() {
        return Ok(ok_json());
    }

    with_connection_mut(|connection| {
        let queue_json = queue_json_by_id(connection, &queue_id)?;
        let Some(queue_json) = queue_json else {
            return Ok(ok_json());
        };
        let mut queue = parse_json(&queue_json)?;
        let queue_map = queue
            .as_object_mut()
            .ok_or_else(|| err("Hydrated queue is not an object"))?;
        if let Some(Value::Array(songs)) = payload.get("songs") {
            queue_map.insert("songs".to_string(), Value::Array(songs.clone()));
        }
        queue_map.insert(
            "updatedAt".to_string(),
            Value::Number(
                (payload
                    .get("updatedAt")
                    .and_then(Value::as_i64)
                    .unwrap_or_else(now_ms))
                .into(),
            ),
        );

        let next_queue = normalize_queue(&queue);
        let (active_queue_id, last_non_fm_queue_id) = queue_selection(connection)?;
        let tx = map_sql(connection.transaction())?;
        upsert_queue(
            &tx,
            &next_queue,
            next_queue.id == active_queue_id,
            next_queue.id == last_non_fm_queue_id,
        )?;
        replace_queue_items(&tx, &next_queue.id, &next_queue.songs)?;
        update_queue_flags(&tx, &active_queue_id, &last_non_fm_queue_id)?;
        map_sql(tx.commit())?;
        Ok(ok_json())
    })
}

#[napi]
pub fn playback_set_queue_current_track(payload_json: String) -> NativeResult<String> {
    let payload = parse_payload(&payload_json)?;
    let queue_id = optional_string_prop(&payload, "queueId").unwrap_or_default();
    if queue_id.is_empty() {
        return Ok(ok_json());
    }
    let track_id = match payload.get("trackId") {
        Some(Value::Null) | None => None,
        Some(value) => json_string(value).filter(|value| !value.is_empty()),
    };

    with_connection(|connection| {
        map_sql(connection.execute(
            "UPDATE playback_queues SET current_track_id = ?, updated_at = ? WHERE id = ?",
            params![track_id, now_ms(), queue_id],
        ))?;
        Ok(ok_json())
    })
}

#[napi]
pub fn playback_set_active_queue(queue_id: String) -> NativeResult<String> {
    if queue_id.trim().is_empty() {
        return Ok(ok_json());
    }

    with_connection_mut(|connection| {
        let tx = map_sql(connection.transaction())?;
        map_sql(tx.execute("UPDATE playback_queues SET active = 0", []))?;
        map_sql(tx.execute(
            "UPDATE playback_queues SET active = 1 WHERE id = ?",
            params![queue_id],
        ))?;
        map_sql(tx.execute("UPDATE playback_queues SET last_non_fm = 0", []))?;
        map_sql(tx.execute(
            "UPDATE playback_queues SET last_non_fm = 1 WHERE id = ?",
            params![queue_id],
        ))?;
        map_sql(tx.commit())?;
        Ok(ok_json())
    })
}
