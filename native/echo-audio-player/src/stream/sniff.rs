//! Peek a format signature without losing bytes from non-seekable HTTP streams.
use super::ReadSeek;
use std::io::{self, Read, Seek, SeekFrom};

/// 预读前 8 字节嗅探 HLS（#EXTM3U）签名；对不可 seek 的顺序流也不丢字节。
pub fn sniff(mut source: Box<dyn ReadSeek>) -> io::Result<(bool, Box<dyn ReadSeek>)> {
    let mut prefix = Vec::with_capacity(8);
    while prefix.len() < 8 {
        let mut bytes = [0; 8];
        let count = source.read(&mut bytes[..8 - prefix.len()])?;
        if count == 0 {
            break;
        }
        prefix.extend_from_slice(&bytes[..count]);
    }
    let hls = prefix.starts_with(b"#EXTM3U");
    let underlying_position = prefix.len() as u64;
    Ok((
        hls,
        Box::new(Prefixed {
            source,
            prefix,
            position: 0,
            underlying_position,
        }),
    ))
}
struct Prefixed {
    source: Box<dyn ReadSeek>,
    prefix: Vec<u8>,
    position: u64,
    underlying_position: u64,
}
impl Read for Prefixed {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if self.position < self.prefix.len() as u64 {
            let start = self.position as usize;
            let count = buffer.len().min(self.prefix.len() - start);
            buffer[..count].copy_from_slice(&self.prefix[start..start + count]);
            self.position += count as u64;
            return Ok(count);
        }
        if self.underlying_position != self.position {
            self.underlying_position = self.source.seek(SeekFrom::Start(self.position))?;
        }
        let count = self.source.read(buffer)?;
        self.position += count as u64;
        self.underlying_position += count as u64;
        Ok(count)
    }
}
impl Seek for Prefixed {
    fn seek(&mut self, from: SeekFrom) -> io::Result<u64> {
        let target = match from {
            SeekFrom::Start(value) => value,
            SeekFrom::Current(delta) => self
                .position
                .checked_add_signed(delta)
                .ok_or_else(|| io::Error::from(io::ErrorKind::InvalidInput))?,
            SeekFrom::End(delta) => {
                let position = self.source.seek(SeekFrom::End(delta))?;
                self.underlying_position = position;
                self.position = position;
                return Ok(position);
            }
        };
        if target != self.position && target > self.prefix.len() as u64 {
            self.underlying_position = self.source.seek(SeekFrom::Start(target))?;
        }
        self.position = target;
        Ok(target)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    struct OneByte(std::io::Cursor<Vec<u8>>);
    impl Read for OneByte {
        fn read(&mut self, b: &mut [u8]) -> io::Result<usize> {
            self.0.read(&mut b[..1])
        }
    }
    impl Seek for OneByte {
        fn seek(&mut self, _: SeekFrom) -> io::Result<u64> {
            Err(io::ErrorKind::Unsupported.into())
        }
    }
    #[test]
    fn fragmented_nonseekable_probe_preserves_every_byte() {
        for data in [
            b"#EXTM3U\n#EXT-X-VERSION:3".to_vec(),
            b"ID3-song-audio".to_vec(),
        ] {
            let (hls, mut source) =
                sniff(Box::new(OneByte(io::Cursor::new(data.clone())))).unwrap();
            assert_eq!(hls, data.starts_with(b"#EXTM3U"));
            let mut actual = Vec::new();
            source.read_to_end(&mut actual).unwrap();
            assert_eq!(actual, data);
        }
    }
}
