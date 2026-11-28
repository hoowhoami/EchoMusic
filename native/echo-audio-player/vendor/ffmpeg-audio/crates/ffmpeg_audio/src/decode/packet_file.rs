//! Ephemeral, append-only packet payload storage. Packet timestamps and other
//! AVPacket properties stay with the in-memory index. I/O uses its own lock,
//! never the packet queue lock or a realtime audio callback.
use crate::{AudioError, Result, sys};
use std::{
    fs::File,
    io::{self, Read, Seek, SeekFrom, Write},
    path::Path,
    sync::{
        Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
};

#[derive(Clone, Copy)]
pub(super) struct FileRecord {
    offset: u64,
    end: u64,
    data_len: u32,
    side_count: u32,
}

pub(super) struct PacketFile {
    file: Mutex<File>,
    bytes: AtomicU64,
    write_failed: AtomicBool,
    error: Mutex<Option<String>>,
    error_handler: Option<fn(&str)>,
}

impl PacketFile {
    #[cfg(test)]
    pub(super) fn hold_io_for_test(&self) -> std::sync::MutexGuard<'_, File> {
        self.file.lock().unwrap()
    }
    pub(super) fn new(
        directory: Option<&Path>,
        error_handler: Option<fn(&str)>,
    ) -> io::Result<Self> {
        let file = if let Some(directory) = directory {
            std::fs::create_dir_all(directory)?;
            tempfile::tempfile_in(directory)?
        } else {
            tempfile::tempfile()?
        };
        // tempfile uses unlink-after-open on Unix and delete-on-close on Windows:
        // the OS removes the file even when the process exits abnormally.
        Ok(Self {
            file: Mutex::new(file),
            bytes: AtomicU64::new(0),
            write_failed: AtomicBool::new(false),
            error: Mutex::new(None),
            error_handler,
        })
    }

    pub(super) fn bytes(&self) -> u64 {
        self.bytes.load(Ordering::Relaxed)
    }
    pub(super) fn error(&self) -> Option<String> {
        self.error.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }
    fn failed(&self, operation: &str, error: &AudioError) {
        self.write_failed.store(true, Ordering::Relaxed);
        let mut current = self.error.lock().unwrap_or_else(|p| p.into_inner());
        if current.is_none() {
            let message = format!("packet cache file {operation} failed: {error}");
            *current = Some(message.clone());
            drop(current);
            if let Some(handler) = self.error_handler {
                handler(&message);
            }
        }
    }

    /// On failure, the caller retains the original packet in memory. Older
    /// complete records remain readable; no more payloads are offloaded.
    pub(super) unsafe fn append(&self, packet: *const sys::AVPacket) -> Option<FileRecord> {
        if self.write_failed.load(Ordering::Relaxed) {
            return None;
        }
        let mut file = self.file.lock().unwrap_or_else(|p| p.into_inner());
        let result = unsafe { write_record(&mut *file, packet) };
        if let Ok(length) = file.seek(SeekFrom::End(0)) {
            self.bytes.store(length, Ordering::Relaxed);
        }
        match result {
            Ok(record) => Some(record),
            Err(error) => {
                self.failed("write", &error);
                None
            }
        }
    }

    pub(super) unsafe fn read(
        &self,
        record: FileRecord,
        properties: *const sys::AVPacket,
    ) -> Result<*mut sys::AVPacket> {
        let mut file = self.file.lock().unwrap_or_else(|p| p.into_inner());
        let result = unsafe { read_record(&mut *file, record, properties) };
        if let Err(error) = &result {
            self.failed("read", error);
        }
        result
    }
}

fn invalid(message: &str) -> AudioError {
    AudioError::InvalidData(message.to_string())
}
fn u32_len(value: usize) -> Result<u32> {
    u32::try_from(value).map_err(|_| invalid("packet cache record is too large"))
}
fn field(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(
        bytes[offset..offset + 4]
            .try_into()
            .expect("fixed-size record field"),
    )
}

unsafe fn write_record(
    file: &mut (impl Write + Seek),
    packet: *const sys::AVPacket,
) -> Result<FileRecord> {
    let packet = unsafe { &*packet };
    let offset = file.seek(SeekFrom::End(0))?;
    let data_len = u32::try_from(packet.size).map_err(|_| invalid("negative packet size"))?;
    let side_count =
        u32::try_from(packet.side_data_elems).map_err(|_| invalid("negative side data count"))?;
    let mut header = [0; 12];
    header[..4].copy_from_slice(&data_len.to_le_bytes());
    header[4..8].copy_from_slice(&(packet.flags as u32).to_le_bytes());
    header[8..].copy_from_slice(&side_count.to_le_bytes());
    file.write_all(&header)?;
    if data_len > 0 {
        if packet.data.is_null() {
            return Err(invalid("missing packet payload"));
        }
        file.write_all(unsafe { std::slice::from_raw_parts(packet.data, data_len as usize) })?;
    }
    for index in 0..side_count as usize {
        let side = unsafe { &*packet.side_data.add(index) };
        let length = u32_len(side.size)?;
        let mut header = [0; 8];
        header[..4].copy_from_slice(&side.type_.to_le_bytes());
        header[4..].copy_from_slice(&length.to_le_bytes());
        file.write_all(&header)?;
        if length > 0 {
            file.write_all(unsafe { std::slice::from_raw_parts(side.data, length as usize) })?;
        }
    }
    Ok(FileRecord {
        offset,
        end: file.stream_position()?,
        data_len,
        side_count,
    })
}

struct PacketGuard(*mut sys::AVPacket);
impl Drop for PacketGuard {
    fn drop(&mut self) {
        unsafe {
            sys::av_packet_free(&mut self.0);
        }
    }
}

unsafe fn read_record(
    file: &mut (impl Read + Seek),
    record: FileRecord,
    properties: *const sys::AVPacket,
) -> Result<*mut sys::AVPacket> {
    file.seek(SeekFrom::Start(record.offset))?;
    let mut header = [0; 12];
    file.read_exact(&mut header)?;
    let data_len = field(&header, 0);
    let flags = field(&header, 4);
    let side_count = field(&header, 8);
    if data_len != record.data_len || side_count != record.side_count || data_len > i32::MAX as u32
    {
        return Err(invalid("packet cache header mismatch"));
    }
    let mut packet = PacketGuard(unsafe { sys::av_packet_alloc() });
    if packet.0.is_null() {
        return Err(AudioError::from_ffmpeg(sys::AVERROR_ENOMEM));
    }
    let allocation = unsafe { sys::av_new_packet(packet.0, data_len as i32) };
    if allocation < 0 {
        return Err(AudioError::from_ffmpeg(allocation));
    }
    let copied = unsafe { sys::av_packet_copy_props(packet.0, properties) };
    if copied < 0 {
        return Err(AudioError::from_ffmpeg(copied));
    }
    unsafe {
        (*packet.0).flags = flags as i32;
    }
    if data_len > 0 {
        file.read_exact(unsafe {
            std::slice::from_raw_parts_mut((*packet.0).data, data_len as usize)
        })?;
    }
    for _ in 0..side_count {
        let mut header = [0; 8];
        file.read_exact(&mut header)?;
        let kind = field(&header, 0);
        let length = field(&header, 4) as usize;
        let remaining = record.end.saturating_sub(file.stream_position()?);
        if length as u64 > remaining {
            return Err(invalid("packet cache side data exceeds record"));
        }
        // AVPacketSideDataType maps to c_int under bindgen, not the u32 the
        // record stores; convert explicitly instead of assuming the width.
        let kind = sys::AVPacketSideDataType::try_from(kind)
            .map_err(|_| invalid("packet cache side data type out of range"))?;
        let data = unsafe { sys::av_packet_new_side_data(packet.0, kind, length) };
        if data.is_null() {
            return Err(AudioError::from_ffmpeg(sys::AVERROR_ENOMEM));
        }
        if length > 0 {
            file.read_exact(unsafe { std::slice::from_raw_parts_mut(data, length) })?;
        }
    }
    if file.stream_position()? != record.end {
        return Err(invalid("packet cache record length mismatch"));
    }
    Ok(std::mem::replace(&mut packet.0, std::ptr::null_mut()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{BufRead, BufReader},
        process::{Command, Stdio},
        sync::mpsc,
        time::Duration,
    };

    fn packet() -> PacketGuard {
        let packet = PacketGuard(unsafe { sys::av_packet_alloc() });
        assert!(!packet.0.is_null());
        unsafe {
            assert_eq!(sys::av_new_packet(packet.0, 4096), 0);
            for i in 0..4096 {
                *(*packet.0).data.add(i) = (i % 251) as u8;
            }
            (*packet.0).pts = 9123;
            (*packet.0).dts = 9012;
            (*packet.0).duration = 1024;
            (*packet.0).pos = 5678;
            (*packet.0).flags = 5;
            (*packet.0).stream_index = 2;
            (*packet.0).time_base = sys::AVRational { num: 1, den: 48000 };
            (*packet.0).opaque_ref = sys::av_buffer_alloc(8);
            assert!(!(*packet.0).opaque_ref.is_null());
            *(*(*packet.0).opaque_ref).data = 77;
            for (kind, bytes) in [
                (
                    sys::AVPacketSideDataType_AV_PKT_DATA_SKIP_SAMPLES,
                    &[1, 0, 0, 0, 2, 0, 0, 0, 0, 0][..],
                ),
                (
                    sys::AVPacketSideDataType_AV_PKT_DATA_STRINGS_METADATA,
                    &b"test\0value\0"[..],
                ),
            ] {
                let data = sys::av_packet_new_side_data(packet.0, kind, bytes.len());
                assert!(!data.is_null());
                std::ptr::copy_nonoverlapping(bytes.as_ptr(), data, bytes.len());
            }
        }
        packet
    }

    unsafe fn assert_equal(a: *const sys::AVPacket, b: *const sys::AVPacket) {
        unsafe {
            let (a, b) = (&*a, &*b);
            assert_eq!(
                (a.pts, a.dts, a.duration, a.pos, a.flags, a.stream_index),
                (b.pts, b.dts, b.duration, b.pos, b.flags, b.stream_index)
            );
            assert_eq!(
                (a.time_base.num, a.time_base.den),
                (b.time_base.num, b.time_base.den)
            );
            assert_eq!(
                std::slice::from_raw_parts(a.data, a.size as usize),
                std::slice::from_raw_parts(b.data, b.size as usize)
            );
            assert_eq!(*(*a.opaque_ref).data, *(*b.opaque_ref).data);
            assert_eq!(a.side_data_elems, b.side_data_elems);
            for i in 0..a.side_data_elems as usize {
                let (a, b) = (&*a.side_data.add(i), &*b.side_data.add(i));
                assert_eq!(a.type_, b.type_);
                assert_eq!(
                    std::slice::from_raw_parts(a.data, a.size),
                    std::slice::from_raw_parts(b.data, b.size)
                );
            }
        }
    }

    #[test]
    fn packet_payload_properties_and_side_data_round_trip_after_repeated_appends() {
        let directory = tempfile::tempdir().unwrap();
        let cache_directory = directory.path().join("音频缓存");
        let file = PacketFile::new(Some(&cache_directory), None).unwrap();
        let original = packet();
        let record = unsafe { file.append(original.0).unwrap() };
        let first_size = file.bytes();
        let second = unsafe { file.append(original.0).unwrap() };
        assert_eq!(file.bytes(), first_size * 2);
        for record in [second, record, second, record] {
            let restored = PacketGuard(unsafe { file.read(record, original.0).unwrap() });
            unsafe {
                assert_equal(original.0, restored.0);
            }
        }
        assert_eq!(file.bytes(), first_size * 2);
        drop(file);
        assert_eq!(std::fs::read_dir(cache_directory).unwrap().count(), 0);
    }

    #[test]
    fn write_failure_keeps_previous_records_readable_and_reports_once() {
        static WARNINGS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let file = PacketFile::new(
            None,
            Some(|_| {
                WARNINGS.fetch_add(1, Ordering::Relaxed);
            }),
        )
        .unwrap();
        let original = packet();
        let record = unsafe { file.append(original.0).unwrap() };
        // Replace the backing handle with a read-only copy: portable disk-write
        // failure injection without relying on permissions or a real full disk.
        let mut copy = tempfile::NamedTempFile::new().unwrap();
        {
            let mut source = file.file.lock().unwrap();
            source.seek(SeekFrom::Start(0)).unwrap();
            std::io::copy(&mut *source, &mut copy).unwrap();
            *source = File::open(copy.path()).unwrap();
        }
        assert!(unsafe { file.append(original.0) }.is_none());
        assert!(unsafe { file.append(original.0) }.is_none());
        assert!(file.error().unwrap().contains("write failed"));
        assert_eq!(WARNINGS.load(Ordering::Relaxed), 1);
        let restored = PacketGuard(unsafe { file.read(record, original.0).unwrap() });
        unsafe {
            assert_equal(original.0, restored.0);
        }
        assert_eq!(unsafe { (*original.0).size }, 4096);
    }

    #[test]
    fn partial_disk_full_write_does_not_damage_older_records_or_the_source_packet() {
        struct LimitedFile {
            data: std::io::Cursor<Vec<u8>>,
            remaining: usize,
        }
        impl Seek for LimitedFile {
            fn seek(&mut self, from: SeekFrom) -> io::Result<u64> {
                self.data.seek(from)
            }
        }
        impl Write for LimitedFile {
            fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                if self.remaining == 0 {
                    return Err(io::Error::from_raw_os_error(libc::ENOSPC));
                }
                let count = bytes.len().min(self.remaining);
                let written = self.data.write(&bytes[..count])?;
                self.remaining -= written;
                Ok(written)
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        let original = packet();
        let mut file = LimitedFile {
            data: std::io::Cursor::new(Vec::new()),
            remaining: usize::MAX,
        };
        let old = unsafe { write_record(&mut file, original.0).unwrap() };
        file.remaining = 17;
        assert!(unsafe { write_record(&mut file, original.0) }.is_err());
        assert!(file.data.get_ref().len() as u64 > old.end);
        let restored =
            PacketGuard(unsafe { read_record(&mut file.data, old, original.0).unwrap() });
        unsafe {
            assert_equal(original.0, restored.0);
        }
    }

    #[test]
    fn truncated_or_corrupt_records_return_errors_without_allocating_from_bad_lengths() {
        let file = PacketFile::new(None, None).unwrap();
        let original = packet();
        let record = unsafe { file.append(original.0).unwrap() };
        {
            let mut handle = file.file.lock().unwrap();
            handle.seek(SeekFrom::Start(0)).unwrap();
            handle.write_all(&u32::MAX.to_le_bytes()).unwrap();
        }
        assert!(unsafe { file.read(record, original.0) }.is_err());
        assert!(file.error().unwrap().contains("header mismatch"));
        let file = PacketFile::new(None, None).unwrap();
        let record = unsafe { file.append(original.0).unwrap() };
        file.file.lock().unwrap().set_len(record.end - 1).unwrap();
        assert!(unsafe { file.read(record, original.0) }.is_err());
    }

    #[test]
    fn anonymous_file_is_removed_after_forced_process_exit() {
        const MARKER: &str = "ECHO_PACKET_FILE_KILL_TEST_DIR";
        if let Some(directory) = std::env::var_os(MARKER) {
            let file = PacketFile::new(Some(Path::new(&directory)), None).unwrap();
            let packet = packet();
            assert!(unsafe { file.append(packet.0) }.is_some());
            println!("packet-file-ready");
            std::io::stdout().flush().unwrap();
            loop {
                std::thread::park();
            }
        }
        let directory = tempfile::tempdir().unwrap();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "decode::packet_file::tests::anonymous_file_is_removed_after_forced_process_exit",
                "--nocapture",
            ])
            .env(MARKER, directory.path())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().unwrap();
        let (tx, rx) = mpsc::channel();
        let output = std::thread::spawn(move || {
            for line in BufReader::new(stdout)
                .lines()
                .map_while(std::result::Result::ok)
            {
                if line == "packet-file-ready" {
                    let _ = tx.send(());
                }
            }
        });
        let ready = rx.recv_timeout(Duration::from_secs(10));
        let _ = child.kill();
        let status = child.wait().unwrap();
        output.join().unwrap();
        assert!(ready.is_ok(), "child did not open its temporary file");
        assert!(!status.success());
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
    }
}
