use super::DecodedAudioChunk;
use std::collections::VecDeque;

pub(super) enum DecodedQueueItem {
    Chunk(DecodedAudioChunk),
    Boundary,
}

#[derive(Default)]
pub(super) struct DecodedAudioQueue {
    chunks: VecDeque<DecodedQueueItem>,
    pub(super) estimated_mix_frames: usize,
}

impl DecodedAudioQueue {
    pub(super) fn clear(&mut self) {
        self.chunks.clear();
        self.estimated_mix_frames = 0;
    }

    pub(super) fn is_empty(&self) -> bool {
        self.chunks.is_empty()
    }

    pub(super) fn push(&mut self, chunk: DecodedAudioChunk, mix_sample_rate: u32) {
        self.estimated_mix_frames = self
            .estimated_mix_frames
            .saturating_add(chunk.estimated_mix_frames(mix_sample_rate));
        self.chunks.push_back(DecodedQueueItem::Chunk(chunk));
    }

    pub(super) fn push_boundary(&mut self) {
        self.chunks.push_back(DecodedQueueItem::Boundary);
    }

    pub(super) fn pop(&mut self, mix_sample_rate: u32) -> Option<DecodedQueueItem> {
        let item = self.chunks.pop_front()?;
        if let DecodedQueueItem::Chunk(chunk) = &item {
            self.estimated_mix_frames = self
                .estimated_mix_frames
                .saturating_sub(chunk.estimated_mix_frames(mix_sample_rate));
        }
        Some(item)
    }
}
