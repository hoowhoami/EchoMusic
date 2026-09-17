import { computed, onScopeDispose, readonly, ref } from 'vue';
import type { ComputedRef, WritableComputedRef } from 'vue';
import type { usePlayerControls } from '@/composables/usePlayerControls';
import { useLyricStore } from '@/stores/lyric';
import type { AudioQualityValue, AudioEffectValue, PlayMode } from '@/types';
import { createLyricTimeline } from '@/composables/useLyricTimeline';

export type LyricsPagePanel =
  | 'queue'
  | 'lyrics-picker'
  | 'quality-picker'
  | 'audio-effects'
  | 'comments'
  | 'add-to-playlist'
  | 'settings';

export function useLyricsPageContext(
  controls: ReturnType<typeof usePlayerControls>,
  titlebar: ComputedRef<'host' | 'none'>,
  openPanel: (panel: LyricsPagePanel) => void | Promise<void>,
  closePanel: () => void,
  barrage: {
    enabled: WritableComputedRef<boolean>;
    send: (content: string) => void;
  },
) {
  const { player, playlist, currentTrack, currentPlaybackQueue } = controls;
  const lyric = useLyricStore();
  const timeline = createLyricTimeline();
  const favoriteBusy = ref(false);
  let disposed = false;
  onScopeDispose(() => {
    disposed = true;
  });
  const qualityValues: AudioQualityValue[] = ['128', '320', 'flac', 'high', 'viper_tape'];
  const effectValues: AudioEffectValue[] = [
    'none',
    'piano',
    'vocal',
    'accompaniment',
    'subwoofer',
    'ancient',
    'surnay',
    'dj',
    'viper_atmos',
    'viper_clear',
  ];
  const state = readonly(
    computed(() => ({
      track: currentTrack.value ?? null,
      isPlaying: player.isPlaying,
      isLoading: player.playbackIsLoading,
      currentTime: player.currentTime,
      playbackClock: player.playbackClock,
      duration: player.duration,
      volume: player.volume,
      playbackRate: player.playbackRate,
      playMode: player.playMode,
      playModeLabel: controls.playModeLabel.value,
      isFavorite: controls.isFavorite.value,
      favoriteBusy: favoriteBusy.value,
      canAddToPlaylist: controls.canAddToPlaylist.value,
      canShare: controls.canShareCurrentTrack.value,
      queue: currentPlaybackQueue.value,
      audioQuality: controls.effectiveAudioQuality.value,
      qualityOptions: qualityValues.map((value) => ({
        value,
        disabled: controls.isAudioQualityDisabled(value),
      })),
      audioEffect: player.audioEffect,
      audioEffectOptions: effectValues,
      audioEffectDisabled: controls.isAudioEffectPresetSelectionDisabled.value,
      isAudioSourceSwitching: controls.isAudioSourceSwitching.value,
      isCloudSource: controls.isResolvedCloudSource.value,
      hasCloudSource: controls.hasCloudAudioSourceOption.value,
      titlebar: titlebar.value,
      lyrics: {
        lines: lyric.lines,
        currentIndex: lyric.currentIndex,
        timeOffset: lyric.currentTimeOffset,
        hasTranslation: lyric.hasTranslation,
        hasRomanization: lyric.hasRomanization,
        wantTranslation: lyric.wantTranslation,
        wantRomanization: lyric.wantRomanization,
        syncWarning: lyric.lyricSyncWarning,
      },
    })),
  );
  const assertActive = () => {
    if (disposed) throw new Error('歌词页已关闭');
  };
  // Retained plugin callbacks must not open orphan panels after the page has unmounted.
  const action =
    <A extends unknown[], R>(fn: (...args: A) => R) =>
    (...args: A): R => {
      assertActive();
      return fn(...args);
    };
  return {
    state,
    close: action(() => player.toggleLyricView(false)),
    panels: { open: action(openPanel), close: action(closePanel) },
    playback: {
      toggle: action(() => player.togglePlay()),
      next: action(() => player.next()),
      prev: action(() => player.prev()),
      seek: action((seconds: number) => {
        if (!Number.isFinite(seconds)) throw new Error('播放位置必须是有限数值');
        player.seek(Math.max(0, Math.min(seconds, player.duration || 0)));
      }),
      setVolume: action((volume: number) => {
        if (!Number.isFinite(volume)) throw new Error('音量必须是有限数值');
        player.setVolume(Math.max(0, Math.min(volume, 100)));
      }),
      toggleMute: action(controls.toggleMute),
      setPlaybackRate: action((rate: number) => {
        if (!Number.isFinite(rate) || rate <= 0) throw new Error('播放速度必须为正数');
        controls.setPlaybackRate(rate);
      }),
      cycleMode: action(controls.cyclePlayMode),
      setMode: action((mode: PlayMode) => {
        if (!['sequential', 'list', 'random', 'single'].includes(mode))
          throw new Error('无效的播放模式');
        player.setPlayMode(mode);
      }),
    },
    favorite: {
      toggle: action(async () => {
        if (favoriteBusy.value || !currentTrack.value) return;
        favoriteBusy.value = true;
        try {
          await controls.toggleFavorite();
        } finally {
          favoriteBusy.value = false;
        }
      }),
    },
    queue: {
      play: action((id: string | number) => {
        const queue = currentPlaybackQueue.value;
        if (!queue?.songs.some((song) => String(song.id) === String(id)))
          throw new Error('歌曲不在当前队列中');
        return player.playTrack(String(id), queue.songs, { sourceQueueId: queue.id });
      }),
      remove: action((id: string | number) => {
        const queue = currentPlaybackQueue.value;
        if (queue) playlist.removeFromQueue(id, queue.id);
      }),
    },
    audio: {
      refreshQualities: action(controls.ensureCurrentTrackCatalogQualities),
      setQuality: action((quality: AudioQualityValue) => {
        if (!qualityValues.includes(quality) || controls.isAudioQualityDisabled(quality))
          throw new Error('当前音质不可用');
        controls.setAudioQuality(quality);
      }),
      useCloudSource: action(controls.setCloudAudioSource),
      setEffect: action((effect: AudioEffectValue) => {
        if (!effectValues.includes(effect)) throw new Error('无效的音效');
        if (controls.isAudioEffectPresetSelectionDisabled.value)
          throw new Error('当前不能切换音效');
        controls.setAudioEffect(effect);
      }),
    },
    lyrics: {
      getTimelineMs: action(() =>
        timeline.getTimelineMs({ clock: player.playbackClock }, lyric.currentTimeOffset, 0),
      ),
      setTranslation: action((enabled: boolean) => {
        lyric.wantTranslation = enabled;
      }),
      setRomanization: action((enabled: boolean) => {
        lyric.wantRomanization = enabled;
      }),
      adjustOffset: action((milliseconds: number) => {
        if (!Number.isFinite(milliseconds)) throw new Error('歌词偏移必须是有限数值');
        lyric.adjustTimeOffset(milliseconds);
        lyric.updateCurrentIndex(player.currentTime);
      }),
      resetOffset: action(() => {
        lyric.resetTimeOffset();
        lyric.updateCurrentIndex(player.currentTime);
      }),
      copy: action(() => navigator.clipboard.writeText(lyric.copyableText)),
    },
    share: action(controls.handleShareCurrentTrack),
    toggleDesktopLyric: action(controls.toggleDesktopLyric),
    barrage: {
      get enabled() {
        return barrage.enabled.value;
      },
      set enabled(value: boolean) {
        barrage.enabled.value = value;
      },
      send: action((content: string) => barrage.send(content)),
    },
  };
}

export type LyricsPageContext = ReturnType<typeof useLyricsPageContext>;
