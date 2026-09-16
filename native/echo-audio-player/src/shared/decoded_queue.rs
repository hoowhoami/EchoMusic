use super::DecodedAudioChunk;
use std::collections::VecDeque;

pub(super) enum DecodedQueueItem {
    Chunk(DecodedAudioChunk),
    Processed(DecodedAudioChunk, u64),
    Deck(crate::transition_filter::DeckFilterRequest),
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

    pub(super) fn push_processed(&mut self, chunk: DecodedAudioChunk, source_frames: u64) {
        self.estimated_mix_frames = self
            .estimated_mix_frames
            .saturating_add(source_frames as usize);
        self.chunks
            .push_back(DecodedQueueItem::Processed(chunk, source_frames));
    }

    pub(super) fn push_deck(&mut self, request: crate::transition_filter::DeckFilterRequest) {
        self.chunks.push_back(DecodedQueueItem::Deck(request));
    }

    pub(super) fn pop(&mut self, mix_sample_rate: u32) -> Option<DecodedQueueItem> {
        let item = self.chunks.pop_front()?;
        if let DecodedQueueItem::Chunk(chunk) = &item {
            self.estimated_mix_frames = self
                .estimated_mix_frames
                .saturating_sub(chunk.estimated_mix_frames(mix_sample_rate));
        }
        if let DecodedQueueItem::Processed(_, source_frames) = &item {
            self.estimated_mix_frames = self
                .estimated_mix_frames
                .saturating_sub(*source_frames as usize);
        }
        Some(item)
    }
}
