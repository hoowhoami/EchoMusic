//
//  PlayerService.swift
//  EchoMusic
//
//  Created on 2025/8/5.
//
import SwiftUI
import AVFoundation

/// 播放器服务，处理所有播放器相关的业务逻辑
class PlayerService: ObservableObject {
    static let shared = PlayerService()
    
    /// 播放器状态（内部使用）
    @Published
    private var player = Player()
    
    /// 当前正在播放的AVPlayer
    private var audioPlayer: AVPlayer?
    
    /// 播放时间观察器
    private var timeObserver: Any?
    
    /// 播放状态观察器
    private var playerStatusObserver: NSKeyValueObservation?
    
    /// 标识是否是新加载的歌曲（用于避免恢复播放位置）
    private var isNewSong: Bool = false
    
    /// 音乐播放服务
    private let musicService = MusicService.shared
    
    /// 音频设备变化监听器
    private var audioDeviceObserver: Any?
    
    /// 记录音频中断前的播放状态
    private var wasPlayingBeforeInterruption: Bool = false
    
    // MARK: - 持久化相关常量
    private let playlistKey = "SavedPlaylist"
    private let currentIndexKey = "CurrentIndex"
    private let currentTimeKey = "CurrentTime"
    private let playModeKey = "PlayMode"
    private let volumeKey = "Volume"
    private let playbackSpeedKey = "PlaybackSpeed"
    private let audioQualityKey = "AudioQuality"
    private let qualityCompatibilityKey = "QualityCompatibility"
    
    private init() {
        // 启动时恢复播放列表状态
        restorePlaylistState()
        // 设置音频设备监听
        setupAudioDeviceMonitoring()
    }
    
    deinit {
        cleanupPlayer()
        cleanupAudioDeviceMonitoring()
    }
    
    // MARK: - AVPlayer 相关方法
    
    /// 播放新歌曲（内部方法）
    private func playNewSong(_ song: Song) async throws {
        let selectedQuality = _audioQuality
        let selectedCompatibility = _qualityCompatibility
        
        do {
            guard let urlString = try await musicService.getSongURL(for: song, quality: selectedQuality, qualityCompatibility: selectedCompatibility) else {
                throw PlayerServiceError.urlNotAvailable
            }
            
            guard let url = URL(string: urlString) else {
                throw PlayerServiceError.urlNotAvailable
            }
            
            await MainActor.run {
                // 清理当前播放器
                cleanupPlayer()
                
                audioPlayer = AVPlayer(url: url)
                isNewSong = true  // 标记为新歌曲
                
                // 设置播放器观察器
                setupPlayerObservers()
                
                // 设置音量和播放速度
                audioPlayer?.volume = Float(player.volume)
                audioPlayer?.rate = 0 // 先设置为0，不自动播放
            }
        } catch let error as MusicServiceError {
            await MainActor.run {
                player.isPlaying = false
            }
            // 将MusicServiceError转换为PlayerServiceError
            switch error {
            case .invalidHash:
                throw PlayerServiceError.invalidHash
            case .urlNotAvailable:
                throw PlayerServiceError.urlNotAvailable
            case .networkError(let message):
                throw PlayerServiceError.networkError(message)
            case .copyrightRestricted:
                throw PlayerServiceError.copyrightRestricted
            case .unknownError:
                throw PlayerServiceError.unknownError
            }
        } catch {
            await MainActor.run {
                player.isPlaying = false
            }
            throw PlayerServiceError.unknownError
        }
    }
    
    /// 检查播放器是否准备好播放
    private func isPlayerReady() -> Bool {
        return audioPlayer != nil && audioPlayer?.currentItem != nil
    }
    
    /// 暂停播放（内部方法）
    private func pausePlayback() {
        audioPlayer?.pause()
    }
    
    /// 恢复播放（内部方法）
    private func resumePlayback() {
        audioPlayer?.play()
    }
    
    /// 停止播放（内部方法）
    private func stopPlayback() {
        cleanupPlayer()
    }
    
    /// 跳转到指定时间（内部方法）
    private func seekToTime(_ time: Double) {
        let cmTime = CMTime(seconds: time, preferredTimescale: CMTimeScale(NSEC_PER_SEC))
        audioPlayer?.seek(to: cmTime)
    }
    
    /// 设置音量（内部方法）
    private func setPlayerVolume(_ volume: Double) {
        audioPlayer?.volume = Float(volume)
    }
    
    /// 设置播放速度（内部方法）
    private func setPlayerPlaybackSpeed(_ speed: Double) {
        audioPlayer?.rate = Float(speed)
    }
    
    /// 清理播放器和观察器
    private func cleanupPlayer() {
        // 移除时间观察器
        if let observer = timeObserver {
            audioPlayer?.removeTimeObserver(observer)
            timeObserver = nil
        }
        
        // 移除状态观察器
        playerStatusObserver?.invalidate()
        playerStatusObserver = nil
        
        // 移除通知观察器
        NotificationCenter.default.removeObserver(self)
        
        // 停止并清理播放器
        audioPlayer?.pause()
        audioPlayer = nil
    }
    
    // MARK: - 播放器观察器设置
    
    /// 设置播放器观察器
    private func setupPlayerObservers() {
        guard let player = audioPlayer else { return }
        
        // 播放时间观察器
        let timeInterval = CMTime(seconds: 0.1, preferredTimescale: CMTimeScale(NSEC_PER_SEC))
        timeObserver = player.addPeriodicTimeObserver(forInterval: timeInterval, queue: .main) { [weak self] time in
            let currentTime = time.seconds
            if !currentTime.isNaN && !currentTime.isInfinite {
                self?.updateCurrentTime(currentTime)
            }
        }
        
        // 播放状态观察器
        playerStatusObserver = player.observe(\.status, options: [.new]) { [weak self] player, _ in
            DispatchQueue.main.async {
                switch player.status {
                case .readyToPlay:
                    // 更新歌曲时长
                    if let duration = player.currentItem?.duration {
                        let seconds = duration.seconds
                        if !seconds.isNaN && !seconds.isInfinite {
                            self?.updateDuration(seconds)
                        }
                    }
                    
                    // 播放器就绪后，处理播放位置
                    if let strongSelf = self {
                        if strongSelf.isNewSong {
                            // 新歌曲从头开始播放
                            strongSelf.isNewSong = false
                            strongSelf.player.currentTime = 0
                            if strongSelf.player.isPlaying {
                                player.rate = Float(strongSelf.player.playbackSpeed)
                            }
                        } else {
                            // 非新歌曲，恢复到保存的播放位置
                            let savedTime = strongSelf.player.currentTime
                            if savedTime > 0 {
                                let cmTime = CMTime(seconds: savedTime, preferredTimescale: CMTimeScale(NSEC_PER_SEC))
                                player.seek(to: cmTime) { _ in
                                    // 跳转完成后开始播放
                                    if strongSelf.player.isPlaying {
                                        player.rate = Float(strongSelf.player.playbackSpeed)
                                    }
                                }
                            } else {
                                // 如果没有保存的时间，直接播放
                                if strongSelf.player.isPlaying {
                                    player.rate = Float(strongSelf.player.playbackSpeed)
                                }
                            }
                        }
                    }
                    
                case .failed:
                    self?.updatePlayingState(false)
                case .unknown:
                    break
                @unknown default:
                    break
                }
            }
        }
        
        // 播放结束观察器
        NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime,
            object: player.currentItem,
            queue: .main
        ) { [weak self] _ in
            // 不立即设置为false，让playNext决定播放状态
            // 自动播放下一首（已包含播放模式处理）
            self?.playNext()
        }
    }
    
    // MARK: - 对外暴露的属性（只读）
    var currentSong: Song? { player.currentSong }
    var isPlaying: Bool { player.isPlaying }
    var currentTime: Double { player.currentTime }
    var duration: Double { player.duration }
    var volume: Double { player.volume }
    var playbackSpeed: Double { player.playbackSpeed }
    var playMode: PlayMode { player.playMode }
    var playlist: [Song] { player.playlist }
    var currentIndex: Int { player.currentIndex }
    var errorMessage: String? { player.errorMessage }
    var hasError: Bool { player.hasError }
    
    // MARK: - 音质相关属性
    private var _audioQuality: AudioQuality = .normal
    private var _qualityCompatibility: Bool = true
    
    var audioQuality: AudioQuality { _audioQuality }
    var qualityCompatibility: Bool { _qualityCompatibility }
    
    // MARK: - 播放失败自动跳过设置
    private var _autoSkipOnError: Bool = false
    private let autoSkipOnErrorKey = "AutoSkipOnError"
    
    var autoSkipOnError: Bool { _autoSkipOnError }
    
    /// 设置播放失败自动跳过
    func setAutoSkipOnError(_ enabled: Bool) {
        _autoSkipOnError = enabled
        UserDefaults.standard.set(enabled, forKey: autoSkipOnErrorKey)
    }
    
    // MARK: - 持久化方法
    
    /// 保存播放状态到UserDefaults
    private func savePlaylistState() {
        let userDefaults = UserDefaults.standard
        
        // 保存播放列表
        if let playlistData = try? JSONEncoder().encode(player.playlist) {
            userDefaults.set(playlistData, forKey: playlistKey)
        }
        
        // 保存其他状态
        userDefaults.set(player.currentIndex, forKey: currentIndexKey)
        userDefaults.set(player.currentTime, forKey: currentTimeKey)
        userDefaults.set(player.playMode.rawValue, forKey: playModeKey)
        userDefaults.set(player.volume, forKey: volumeKey)
        userDefaults.set(player.playbackSpeed, forKey: playbackSpeedKey)
        userDefaults.set(_audioQuality.rawValue, forKey: audioQualityKey)
        userDefaults.set(_qualityCompatibility, forKey: qualityCompatibilityKey)
    }
    
    /// 从UserDefaults恢复播放状态
    private func restorePlaylistState() {
        let userDefaults = UserDefaults.standard
        
        // 恢复播放列表
        if let playlistData = userDefaults.data(forKey: playlistKey),
           let playlist = try? JSONDecoder().decode([Song].self, from: playlistData) {
            player.playlist = playlist
        }
        
        // 恢复播放索引
        let savedIndex = userDefaults.integer(forKey: currentIndexKey)
        if savedIndex >= 0 && savedIndex < player.playlist.count {
            player.currentIndex = savedIndex
            player.currentSong = player.playlist[savedIndex]
        } else if !player.playlist.isEmpty {
            player.currentIndex = 0
            player.currentSong = player.playlist[0]
        }
        
        // 恢复播放时间
        player.currentTime = userDefaults.double(forKey: currentTimeKey)
        
        // 恢复播放模式
        if let playModeRawValue = userDefaults.object(forKey: playModeKey) as? String,
           let playMode = PlayMode(rawValue: playModeRawValue) {
            player.playMode = playMode
        }
        
        // 恢复音量
        let savedVolume = userDefaults.double(forKey: volumeKey)
        if savedVolume > 0 {
            player.volume = savedVolume
        }
        
        // 恢复播放速度
        let savedSpeed = userDefaults.double(forKey: playbackSpeedKey)
        if savedSpeed >= 0.5 && savedSpeed <= 2.0 {
            player.playbackSpeed = savedSpeed
        }
        
        // 恢复音质设置
        if let savedQuality = userDefaults.string(forKey: audioQualityKey),
           let quality = AudioQuality(rawValue: savedQuality) {
            _audioQuality = quality
        }
        
        // 恢复兼容模式设置
        _qualityCompatibility = userDefaults.object(forKey: qualityCompatibilityKey) as? Bool ?? true
        
        // 恢复播放失败自动跳过设置
        _autoSkipOnError = userDefaults.bool(forKey: autoSkipOnErrorKey)
        
        // 设置默认时长（如果有当前歌曲）
        // 注意：实际时长会在AVPlayer准备好时更新
        if let currentSong = player.currentSong {
            player.duration = Double(currentSong.duration ?? 0)
        }
    }
    
    /// 清除保存的播放状态
    private func clearSavedPlaylistState() {
        let userDefaults = UserDefaults.standard
        userDefaults.removeObject(forKey: playlistKey)
        userDefaults.removeObject(forKey: currentIndexKey)
        userDefaults.removeObject(forKey: currentTimeKey)
        userDefaults.removeObject(forKey: playModeKey)
        userDefaults.removeObject(forKey: volumeKey)
        userDefaults.removeObject(forKey: playbackSpeedKey)
        userDefaults.removeObject(forKey: audioQualityKey)
        userDefaults.removeObject(forKey: qualityCompatibilityKey)
    }
    
    /// 切换播放/暂停状态
    func togglePlayback() {
        if player.isPlaying {
            pausePlayback()
            player.isPlaying = false
        } else {
            // 如果有当前歌曲但音频播放器未准备好，重新加载歌曲
            if let currentSong = player.currentSong, !isPlayerReady() {
                player.isPlaying = true  // 先设置为true，让观察器知道需要播放
                Task {
                    do {
                        try await playNewSong(currentSong)
                    } catch {
                        player.isPlaying = false
                    }
                }
            } else {
                // 播放器已经准备好，直接恢复播放
                resumePlayback()
                player.isPlaying = true
            }
        }
        savePlaylistState()
    }
    
    /// 播放上一首
    func playPrevious() {
        guard !player.playlist.isEmpty else { return }
        
        switch player.playMode {
        case .shuffle:
            player.currentIndex = Int.random(in: 0..<player.playlist.count)
        case .sequence, .repeatOne:
            player.currentIndex = player.currentIndex > 0 ? player.currentIndex - 1 : player.playlist.count - 1
        }
        
        let newSong = player.playlist[player.currentIndex]
        
        // 立即更新UI显示的歌曲，不管播放是否成功
        player.currentSong = newSong
        player.currentTime = 0
        player.duration = Double(newSong.duration ?? 0)  // 使用歌曲元数据中的时长
        player.clearError()
        
        // 播放新歌曲
        Task {
            do {
                try await playNewSong(newSong)
                await MainActor.run {
                    savePlaylistState()
                }
            } catch {
                await MainActor.run {
                    player.isPlaying = false
                    // 设置错误信息但保持显示失败的歌曲
                    if let playerError = error as? PlayerServiceError {
                        player.setError(playerError.errorDescription ?? "播放失败")
                    } else {
                        player.setError("播放失败")
                    }
                    // 停止当前播放器
                    cleanupPlayer()
                    
                    // 如果启用了自动跳过，尝试播放下一首
                    if autoSkipOnError {
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                            self.player.isPlaying = true  // 确保设置为播放状态
                            self.playNext()
                        }
                    }
                }
            }
        }
    }
    
    /// 播放下一首
    func playNext() {
        guard !player.playlist.isEmpty else { return }
        
        let previousIndex = player.currentIndex
        let wasPlaying = player.isPlaying
        
        switch player.playMode {
        case .shuffle:
            player.currentIndex = Int.random(in: 0..<player.playlist.count)
        case .repeatOne:
            // 单曲循环，不改变索引
            break
        case .sequence:
            player.currentIndex = (player.currentIndex + 1) % player.playlist.count
        }
        
        let newSong = player.playlist[player.currentIndex]
        
        // 立即更新UI显示的歌曲，不管播放是否成功
        player.currentSong = newSong
        player.currentTime = 0
        player.duration = Double(newSong.duration ?? 0)  // 使用歌曲元数据中的时长
        player.clearError()
        
        // 播放新歌曲
        Task {
            do {
                try await playNewSong(newSong)
                await MainActor.run {
                    // 如果之前在播放或者是自动切换到下一首，继续播放
                    player.isPlaying = wasPlaying || previousIndex != player.currentIndex
                    savePlaylistState()
                }
            } catch {
                await MainActor.run {
                    player.isPlaying = false
                    // 设置错误信息但保持显示失败的歌曲
                    if let playerError = error as? PlayerServiceError {
                        player.setError(playerError.errorDescription ?? "播放失败")
                    } else {
                        player.setError("播放失败")
                    }
                    // 停止当前播放器
                    cleanupPlayer()
                    
                    // 如果启用了自动跳过，尝试播放下一首（避免无限循环）
                    if autoSkipOnError && previousIndex != player.currentIndex {
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                            self.player.isPlaying = true  // 确保设置为播放状态
                            self.playNext()
                        }
                    }
                }
            }
        }
    }
    
    /// 切换播放模式
    func togglePlayMode() {
        let allModes = PlayMode.allCases
        if let currentModeIndex = allModes.firstIndex(of: player.playMode) {
            let nextIndex = (currentModeIndex + 1) % allModes.count
            player.playMode = allModes[nextIndex]
        }
        savePlaylistState()
    }
    
    /// 播放指定歌曲
    func playSong(at index: Int) {
        guard index >= 0 && index < player.playlist.count else { return }
        
        let newSong = player.playlist[index]
        
        // 立即更新UI显示的歌曲，不管播放是否成功
        player.currentIndex = index
        player.currentSong = newSong
        player.currentTime = 0
        player.duration = Double(newSong.duration ?? 0)  // 使用歌曲元数据中的时长
        player.clearError()
        
        // 播放新歌曲
        Task {
            do {
                try await playNewSong(newSong)
                await MainActor.run {
                    player.isPlaying = true
                    savePlaylistState()
                }
            } catch {
                await MainActor.run {
                    player.isPlaying = false
                    // 设置错误信息但保持显示失败的歌曲
                    if let playerError = error as? PlayerServiceError {
                        player.setError(playerError.errorDescription ?? "播放失败")
                    } else {
                        player.setError("播放失败")
                    }
                    // 停止当前播放器
                    cleanupPlayer()
                    
                    // 如果启用了自动跳过，尝试播放下一首
                    if autoSkipOnError {
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                            self.player.isPlaying = true  // 确保设置为播放状态
                            self.playNext()
                        }
                    }
                }
            }
        }
    }
    
    /// 设置播放进度
    func seekTo(time: Double) {
        player.currentTime = max(0, min(player.duration, time))
        seekToTime(time)
        savePlaylistState()
    }
    
    /// 设置音量
    func setVolume(_ newVolume: Double) {
        player.volume = max(0, min(1, newVolume))
        setPlayerVolume(newVolume)
        savePlaylistState()
    }
    
    /// 设置播放速度
    func setPlaybackSpeed(_ speed: Double) {
        player.playbackSpeed = max(0.5, min(2.0, speed))
        setPlayerPlaybackSpeed(speed)
        savePlaylistState()
    }
    
    /// 设置音质
    func setAudioQuality(_ quality: AudioQuality) {
        let wasPlaying = player.isPlaying
        _audioQuality = quality
        savePlaylistState()
        
        // 如果当前有歌曲在播放，重新获取并播放
        if player.currentSong != nil {
            Task {
                do {
                    try await reloadCurrentSong(shouldPlay: wasPlaying)
                } catch {
                    player.isPlaying = false
                }
            }
        }
    }
    
    /// 设置兼容模式
    func setQualityCompatibility(_ compatibility: Bool) {
        let wasPlaying = player.isPlaying
        _qualityCompatibility = compatibility
        savePlaylistState()
        
        // 如果当前有歌曲在播放，重新获取并播放
        if player.currentSong != nil {
            Task {
                do {
                    try await reloadCurrentSong(shouldPlay: wasPlaying)
                } catch {
                    player.isPlaying = false
                }
            }
        }
    }
    
    /// 重新加载当前歌曲
    private func reloadCurrentSong(shouldPlay: Bool) async throws {
        guard let currentSong = player.currentSong else { return }
        
        await MainActor.run {
            // 暂停当前播放
            if player.isPlaying {
                pausePlayback()
                player.isPlaying = false
            }
        }
        
        // 重新播放歌曲
        try await playNewSong(currentSong)
        
        await MainActor.run {
            if shouldPlay {
                player.isPlaying = true
            }
        }
    }
    
    /// 加载播放列表
    func loadPlaylist(_ songs: [Song]) {
        player.playlist = songs
        if !songs.isEmpty && player.currentSong == nil {
            player.currentIndex = 0
            player.currentSong = songs[0]
            // 设置默认时长，实际时长会在AVPlayer准备好时更新
            player.duration = Double(songs[0].duration ?? 0)
        }
        savePlaylistState()
    }
    
    /// 添加歌曲到播放列表（去重）
    func addSongs(_ songs: [Song]) {
        let uniqueSongs = songs.filter { newSong in
            !player.playlist.contains { existingSong in
                existingSong == newSong
            }
        }
        
        player.playlist.append(contentsOf: uniqueSongs)
        
        // 如果当前没有播放歌曲，则设置第一首
        if player.currentSong == nil && !player.playlist.isEmpty {
            player.currentIndex = 0
            player.currentSong = player.playlist[0]
            player.duration = Double(player.playlist[0].duration ?? 0)
        }
        savePlaylistState()
    }
    
    /// 添加单首歌曲到播放列表（去重）
    func addSong(_ song: Song) {
        addSongs([song])
    }
    
    /// 播放指定的歌曲列表（替换当前播放列表）
    func playAllSongs(_ songs: [Song]) {
        let songsToPlay = songs.isEmpty ? [] : songs
        player.playlist = songsToPlay
        
        if !songsToPlay.isEmpty {
            let firstSong = songsToPlay[0]
            
            // 立即更新UI显示的歌曲，不管播放是否成功
            player.currentIndex = 0
            player.currentSong = firstSong
            player.currentTime = 0
            player.duration = Double(firstSong.duration ?? 0)
            player.clearError()
            
            // 播放第一首歌曲
            Task {
                do {
                    try await playNewSong(firstSong)
                    await MainActor.run {
                        player.isPlaying = true
                        savePlaylistState()
                    }
                } catch {
                    await MainActor.run {
                        player.isPlaying = false
                        // 设置错误信息但保持显示失败的歌曲
                        if let playerError = error as? PlayerServiceError {
                            player.setError(playerError.errorDescription ?? "播放失败")
                        } else {
                            player.setError("播放失败")
                        }
                        // 停止当前播放器
                        cleanupPlayer()
                        savePlaylistState()
                        
                        // 如果启用了自动跳过，尝试播放下一首
                        if autoSkipOnError {
                            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                                self.player.isPlaying = true  // 确保设置为播放状态
                                self.playNext()
                            }
                        }
                    }
                }
            }
        } else {
            savePlaylistState()
        }
    }
    
    /// 播放指定歌曲（将歌曲添加到播放列表并播放）
    func playSong(_ song: Song) {
        // 如果歌曲已在播放列表中，直接播放
        if let existingIndex = player.playlist.firstIndex(where: { $0 == song }) {
            playSong(at: existingIndex)
        } else {
            // 添加歌曲到播放列表并播放
            player.playlist.append(song)
            let newIndex = player.playlist.count - 1
            playSong(at: newIndex)
        }
        // 注意: playSong(at:) 已经调用了 savePlaylistState，所以这里不需要重复调用
    }
    
    /// 从播放列表中删除指定歌曲
    func removeSong(at index: Int) {
        guard index >= 0 && index < player.playlist.count else { return }
        
        // 如果删除的是当前播放的歌曲
        if index == player.currentIndex {
            // 停止当前播放
            stopPlayback()
            player.isPlaying = false
            player.currentTime = 0
            
            // 如果只有一首歌，清空播放状态
            if player.playlist.count == 1 {
                player.currentSong = nil
                player.currentIndex = 0
                player.playlist.remove(at: index)
            } else {
                // 删除歌曲
                player.playlist.remove(at: index)
                
                // 调整播放索引
                if index >= player.playlist.count {
                    // 如果删除的是最后一首歌，播放前一首
                    player.currentIndex = player.playlist.count - 1
                } else {
                    // 否则保持当前索引，播放原来的下一首
                    // currentIndex 不需要改变，因为删除后索引自动向前移动
                }
                
                // 更新当前歌曲
                if !player.playlist.isEmpty {
                    player.currentSong = player.playlist[player.currentIndex]
                } else {
                    player.currentSong = nil
                    player.currentIndex = 0
                }
            }
        } else {
            // 如果删除的歌曲在当前播放歌曲之前，更新索引
            if index < player.currentIndex {
                player.currentIndex -= 1
            }
            
            // 删除歌曲
            player.playlist.remove(at: index)
        }
        
        savePlaylistState()
    }
    
    /// 清空播放列表
    func clearPlaylist() {
        player.playlist.removeAll()
        player.currentSong = nil
        player.currentIndex = 0
        player.isPlaying = false
        player.currentTime = 0
        stopPlayback()
        clearSavedPlaylistState()
    }
    
    /// 从播放列表中删除指定的歌曲
    func removeSongs(_ songsToRemove: [Song]) {
        // 找到要删除的歌曲索引
        var indicesToRemove: [Int] = []
        
        for song in songsToRemove {
            if let index = player.playlist.firstIndex(of: song) {
                indicesToRemove.append(index)
            }
        }
        
        // 按降序排列索引，从后往前删除避免索引变化问题
        indicesToRemove.sort(by: >)
        
        for index in indicesToRemove {
            removeSong(at: index)
        }
    }
    
    /// 验证播放索引是否有效
    func isValidIndex(_ index: Int) -> Bool {
        return index >= 0 && index < player.playlist.count
    }
    
    /// 获取随机播放索引
    func getRandomIndex() -> Int {
        guard !player.playlist.isEmpty else { return 0 }
        return Int.random(in: 0..<player.playlist.count)
    }
    
    // MARK: - 内部方法（用于直接更新状态，供音频播放器使用）
    /// 更新播放时间（通常由音频播放器定时器调用）
    func updateCurrentTime(_ time: Double) {
        player.currentTime = time
    }
    
    /// 更新歌曲时长（当加载新歌曲时调用）
    func updateDuration(_ duration: Double) {
        player.duration = duration
    }
    
    /// 更新播放状态（当音频播放器状态改变时调用）
    func updatePlayingState(_ isPlaying: Bool) {
        player.isPlaying = isPlaying
    }
    
    /// 清除错误信息
    func clearError() {
        player.clearError()
    }
    
    // MARK: - macOS音频设备监听（入耳检测）
    
    /// 设置音频设备监听
    private func setupAudioDeviceMonitoring() {
        var audioObjectPropertyAddress = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultOutputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        
        // 注册音频设备变化回调
        _ = AudioObjectAddPropertyListener(
            AudioObjectID(kAudioObjectSystemObject), 
            &audioObjectPropertyAddress, 
            { (objectID, numAddresses, addresses, clientData) -> OSStatus in
                DispatchQueue.main.async {
                    let playerService = Unmanaged<PlayerService>.fromOpaque(clientData!).takeUnretainedValue()
                    playerService.handleAudioDeviceChange()
                }
                return noErr
            }, 
            Unmanaged.passUnretained(self).toOpaque()
        )
    }
    
    /// 清理音频设备监听
    private func cleanupAudioDeviceMonitoring() {
        var audioObjectPropertyAddress = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultOutputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        
        AudioObjectRemovePropertyListener(
            AudioObjectID(kAudioObjectSystemObject),
            &audioObjectPropertyAddress,
            { (objectID, numAddresses, addresses, clientData) -> OSStatus in
                return noErr
            },
            Unmanaged.passUnretained(self).toOpaque()
        )
    }
    
    /// 处理音频设备变化
    private func handleAudioDeviceChange() {
        checkCurrentAudioDevice()
    }
    
    /// 检查当前音频设备
    private func checkCurrentAudioDevice() {
        var defaultOutputDevice: AudioDeviceID = 0
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        var propertyAddress = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultOutputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        
        let result = AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject),
            &propertyAddress,
            0,
            nil,
            &size,
            &defaultOutputDevice
        )
        
        if result == noErr && defaultOutputDevice != kAudioDeviceUnknown {
            // 获取设备名称
            var nameAddress = AudioObjectPropertyAddress(
                mSelector: kAudioObjectPropertyName,
                mScope: kAudioObjectPropertyScopeGlobal,
                mElement: kAudioObjectPropertyElementMain
            )
            
            var nameSize: UInt32 = 0
            
            // 首先获取名称属性的大小
            let sizeResult = AudioObjectGetPropertyDataSize(defaultOutputDevice, &nameAddress, 0, nil, &nameSize)
            
            let deviceNameString: String
            if sizeResult == noErr && nameSize > 0 {
                // 分配缓冲区并获取设备名称
                let nameBuffer = UnsafeMutablePointer<CFString?>.allocate(capacity: 1)
                defer { nameBuffer.deallocate() }
                
                let nameResult = AudioObjectGetPropertyData(defaultOutputDevice, &nameAddress, 0, nil, &nameSize, nameBuffer)
                
                if nameResult == noErr, let cfName = nameBuffer.pointee {
                    deviceNameString = cfName as String
                } else {
                    deviceNameString = "Unknown Device"
                }
            } else {
                deviceNameString = "Unknown Device"
            }
            
            // 检查是否为耳机/蓝牙设备
            let isHeadphoneDevice = deviceNameString.lowercased().contains("bluetooth") || 
                                   deviceNameString.lowercased().contains("airpods") ||
                                   deviceNameString.lowercased().contains("beats") ||
                                   deviceNameString.lowercased().contains("headphones")
            
            if isHeadphoneDevice {
                handleInEarDetection(isInEar: true)
            } else {
                handleInEarDetection(isInEar: false)
            }
        }
    }
    
    /// 处理入耳检测事件
    private func handleInEarDetection(isInEar: Bool) {
        if isInEar {
            // 如果之前因为离耳而暂停，现在恢复播放
            if wasPlayingBeforeInterruption && !player.isPlaying {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                    self.resumePlayback()
                    self.player.isPlaying = true
                    self.wasPlayingBeforeInterruption = false
                    self.savePlaylistState()
                }
            }
        } else {
            // 如果正在播放，暂停并记录状态
            if player.isPlaying {
                wasPlayingBeforeInterruption = true
                pausePlayback()
                player.isPlaying = false
                savePlaylistState()
            }
        }
    }
}

// MARK: - 错误定义

enum PlayerServiceError: LocalizedError {
    case invalidHash
    case urlNotAvailable
    case networkError(String)
    case copyrightRestricted
    case unknownError
    
    var errorDescription: String? {
        switch self {
        case .invalidHash:
            return "歌曲标识无效"
        case .urlNotAvailable:
            return "无法获取播放链接"
        case .networkError(let message):
            return "网络错误: \(message)"
        case .copyrightRestricted:
            return "该歌曲暂无版权，无法播放"
        case .unknownError:
            return "未知错误"
        }
    }
}
