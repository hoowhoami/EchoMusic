//
//  PlayerView.swift
//  EchoMusic
//
//  Created on 2025/8/4.
//

import SwiftUI

struct PlayerView: View {
    /// 全局播放管理器
    @EnvironmentObject private var playerService: PlayerService

    // UI 状态
    @State private var showVolumeSlider = false
    @State private var showSpeedSlider = false
    @State private var showPlaylist = false
    @State private var showQuality = false
    @State private var showPlayerSettings = false

    var body: some View {
        VStack(spacing: 0) {
            // 顶部进度条
            TopProgressBarView(
                currentTime: Binding(
                    get: { playerService.currentTime },
                    set: { playerService.seekTo(time: $0) }
                ),
                duration: playerService.duration
            )
            // .padding(.horizontal, 16)

            // 主要控制区域
            HStack(spacing: 0) {
                // 左侧：歌曲信息
                SongInfoView(song: playerService.currentSong, playerService: playerService)
                    .frame(width: 200)

                // 中央：播放控制（绝对居中）
                HStack {
                    Spacer()
                    PlaybackControlsView(
                        isPlaying: playerService.isPlaying,
                        onPrevious: { playerService.playPrevious() },
                        onPlayPause: { playerService.togglePlayback() },
                        onNext: { playerService.playNext() }
                    )
                    Spacer()
                }

                // 右侧：播放模式和设置
                PlayerSettingsView(
                    volume: Binding(
                        get: { playerService.volume },
                        set: { playerService.setVolume($0) }
                    ),
                    playbackSpeed: Binding(
                        get: { playerService.playbackSpeed },
                        set: { playerService.setPlaybackSpeed($0) }
                    ),
                    playMode: Binding(
                        get: { playerService.playMode },
                        set: { _ in 
                            // 立即触发模式切换
                            playerService.togglePlayMode()
                        }
                    ),
                    showVolumeSlider: $showVolumeSlider,
                    showSpeedSlider: $showSpeedSlider,
                    showPlaylist: $showPlaylist,
                    showQuality: $showQuality,
                    showPlayerSettings: $showPlayerSettings,
                    playerService: playerService
                )
                .frame(width: 200)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
        }
        .frame(height: 80)
        .background(Color(NSColor.windowBackgroundColor))
        .overlay(
            // 顶部边框
            Rectangle()
                .fill(Color(NSColor.separatorColor).opacity(0.5))
                .frame(height: 0.5),
            alignment: .top
        )
    }
}



// 顶部进度条组件
struct TopProgressBarView: View {
    @Binding var currentTime: Double
    let duration: Double
    @State private var isHovering = false
    @State private var isDragging = false
    @State private var draggedTime: Double = 0

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                // 背景条
                Rectangle()
                    .fill(Color.gray.opacity(0.3))
                    .frame(height: isHovering || isDragging ? 6 : 3)

                // 进度条 - 始终显示当前进度
                let displayTime = isDragging ? draggedTime : currentTime
                let progress = duration > 0 ? max(0, min(1, displayTime / duration)) : 0
                Rectangle()
                    .fill(Color.accentColor)
                    .frame(width: geometry.size.width * progress, height: isHovering || isDragging ? 6 : 3)

                // 拖拽手柄（仅在悬停或拖拽时显示）
                if isHovering || isDragging {
                    let handleProgress = duration > 0 ? max(0, min(1, displayTime / duration)) : 0
                    Circle()
                        .fill(Color.accentColor)
                        .frame(width: 12, height: 12)
                        .offset(x: (geometry.size.width * handleProgress) - 6)
                }
            }
            .onHover { hovering in
                withAnimation(.easeInOut(duration: 0.2)) {
                    isHovering = hovering
                }
            }
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { value in
                        isDragging = true
                        if duration > 0 {
                            let newTime = (value.location.x / geometry.size.width) * duration
                            draggedTime = max(0, min(duration, newTime))
                        }
                    }
                    .onEnded { _ in
                        isDragging = false
                        // 结束拖拽时才实际设置时间
                        currentTime = draggedTime
                    }
            )

            // 时间提示（仅在悬停且有时长时显示）
            if (isHovering || isDragging) && duration > 0 {
                let showTime = isDragging ? draggedTime : currentTime
                HStack {
                    Text(formatTime(showTime))
                        .font(.caption)
                        .foregroundColor(.primary)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Color(NSColor.controlBackgroundColor))
                        .cornerRadius(4)
                        .offset(y: -20)

                    Spacer()

                    Text(formatTime(duration))
                        .font(.caption)
                        .foregroundColor(.primary)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Color(NSColor.controlBackgroundColor))
                        .cornerRadius(4)
                        .offset(y: -20)
                }
            }
        }
        .frame(height: isHovering || isDragging ? 20 : 6)
        .animation(.easeInOut(duration: 0.2), value: isHovering)
        .animation(.easeInOut(duration: 0.2), value: isDragging)
        .onAppear {
            draggedTime = currentTime
        }
        .onChange(of: currentTime) { newValue in
            if !isDragging {
                draggedTime = newValue
            }
        }
    }

    private func formatTime(_ time: Double) -> String {
        let minutes = Int(time) / 60
        let seconds = Int(time) % 60
        return String(format: "%d:%02d", minutes, seconds)
    }
}

// 原进度条组件（保留以防其他地方使用）
struct ProgressBarView: View {
    @Binding var currentTime: Double
    let duration: Double

    var body: some View {
        if duration > 0 {
            VStack(spacing: 6) {
                // 进度条
                Slider(value: $currentTime, in: 0...duration) {
                    // 拖拽时的处理
                } onEditingChanged: { editing in
                    // 拖拽开始/结束时的处理
                }
                .controlSize(.small)

                // 时间显示
                HStack {
                    Text(formatTime(currentTime))
                        .font(.caption)
                        .foregroundColor(.secondary)

                    Spacer()

                    Text(formatTime(duration))
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
            }
        } else {
            // 没有时长时显示空的进度条
            VStack(spacing: 6) {
                Rectangle()
                    .fill(Color.gray.opacity(0.3))
                    .frame(height: 4)
                    .cornerRadius(2)
                
                HStack {
                    Text("--:--")
                        .font(.caption)
                        .foregroundColor(.secondary)
                    
                    Spacer()
                    
                    Text("--:--")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
            }
        }
    }

    private func formatTime(_ time: Double) -> String {
        let minutes = Int(time) / 60
        let seconds = Int(time) % 60
        return String(format: "%d:%02d", minutes, seconds)
    }
}

// 歌曲信息组件
struct SongInfoView: View {
    let song: Song?
    let playerService: PlayerService

    var body: some View {
        HStack(spacing: 12) {
            // 封面
            if let song = song {
                AsyncImage(url: URL(string: ImageURLHelper.processImageURL(song.cover, size: .small)?.absoluteString ?? "")) { image in
                    image
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                } placeholder: {
                    Rectangle()
                        .fill(Color.gray.opacity(0.3))
                        .overlay(
                            Image(systemName: "music.note")
                                .foregroundColor(.gray)
                                .font(.system(size: 16))
                        )
                }
                .frame(width: 50, height: 50)
                .cornerRadius(6)
                .clipped()
            } else {
                RoundedRectangle(cornerRadius: 6)
                    .fill(Color.gray.opacity(0.3))
                    .frame(width: 50, height: 50)
                    .overlay(
                        Image(systemName: "music.note")
                            .foregroundColor(.secondary)
                    )
            }

            // 歌曲信息
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 4) {
                    Text(song?.title ?? "未播放")
                        .font(.subheadline)
                        .fontWeight(.medium)
                        .lineLimit(1)
                    
                    // 如果有错误，显示错误图标
                    if playerService.hasError {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .font(.caption)
                            .foregroundColor(.orange)
                    }
                    
                    // 下方播放器不显示音质标识
                }
                
                Text(playerService.hasError ? (playerService.errorMessage ?? "播放失败") : (song?.artist ?? "未知歌手"))
                    .font(.caption)
                    .foregroundColor(playerService.hasError ? .orange : .secondary)
                    .lineLimit(1)
            }
            .frame(width: 120, alignment: .leading)
        }
    }
}

// 播放控制组件
struct PlaybackControlsView: View {
    let isPlaying: Bool
    let onPrevious: () -> Void
    let onPlayPause: () -> Void
    let onNext: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            // 上一首
            Button(action: onPrevious) {
                Image(systemName: "backward.end.fill")
                    .font(.system(size: 18))
                    .foregroundColor(.primary)
            }
            .buttonStyle(.plain)
            .onHover { isHovering in
                if isHovering {
                    NSCursor.pointingHand.push()
                } else {
                    NSCursor.pop()
                }
            }

            // 播放/暂停
            Button(action: onPlayPause) {
                Image(systemName: isPlaying ? "pause.circle.fill" : "play.circle.fill")
                    .font(.system(size: 36))
                    .foregroundColor(.accentColor)
            }
            .buttonStyle(.plain)
            .onHover { isHovering in
                if isHovering {
                    NSCursor.pointingHand.push()
                } else {
                    NSCursor.pop()
                }
            }

            // 下一首
            Button(action: onNext) {
                Image(systemName: "forward.end.fill")
                    .font(.system(size: 18))
                    .foregroundColor(.primary)
            }
            .buttonStyle(.plain)
            .onHover { isHovering in
                if isHovering {
                    NSCursor.pointingHand.push()
                } else {
                    NSCursor.pop()
                }
            }
        }
    }
}

// 播放器设置组件
struct PlayerSettingsView: View {
    @Binding var volume: Double
    @Binding var playbackSpeed: Double
    @Binding var playMode: PlayMode
    @Binding var showVolumeSlider: Bool
    @Binding var showSpeedSlider: Bool
    @Binding var showPlaylist: Bool
    @Binding var showQuality: Bool
    @Binding var showPlayerSettings: Bool
    let playerService: PlayerService

    var body: some View {
        HStack(spacing: 16) {
            // 播放模式
            Button(action: {
                // 切换播放模式
                let allModes = PlayMode.allCases
                if let currentIndex = allModes.firstIndex(of: playMode) {
                    let nextIndex = (currentIndex + 1) % allModes.count
                    playMode = allModes[nextIndex]
                }
            }) {
                Image(systemName: playMode.rawValue)
                    .font(.system(size: 16))
                    .foregroundColor(.secondary)
            }
            .buttonStyle(.plain)
            .help(playMode.displayName)
            .onHover { isHovering in
                if isHovering {
                    NSCursor.pointingHand.push()
                } else {
                    NSCursor.pop()
                }
            }

            // 播放速度控制
            Button(action: {
                showSpeedSlider.toggle()
                if showSpeedSlider {
                    showVolumeSlider = false
                    showPlaylist = false
                    showQuality = false
                    showPlayerSettings = false
                }
            }) {
                Text(String(format: "%.1fx", playbackSpeed))
                    .font(.caption)
                    .fontWeight(.medium)
                    .foregroundColor(showSpeedSlider ? .accentColor : .secondary)
            }
            .buttonStyle(.plain)
            .popover(isPresented: $showSpeedSlider, arrowEdge: .top) {
                SpeedControlPopover(playbackSpeed: $playbackSpeed)
            }
            .onHover { isHovering in
                if isHovering {
                    NSCursor.pointingHand.push()
                } else {
                    NSCursor.pop()
                }
            }

            // 音量控制
            Button(action: {
                showVolumeSlider.toggle()
                if showVolumeSlider {
                    showSpeedSlider = false
                    showPlaylist = false
                    showQuality = false
                    showPlayerSettings = false
                }
            }) {
                Image(systemName: volumeIcon)
                    .font(.system(size: 16))
                    .foregroundColor(showVolumeSlider ? .accentColor : .secondary)
                    .frame(width: 20, alignment: .center) // 固定宽度防止布局变化
            }
            .buttonStyle(.plain)
            .popover(isPresented: $showVolumeSlider, arrowEdge: .top) {
                VolumeControlPopover(volume: $volume)
            }
            .onHover { isHovering in
                if isHovering {
                    NSCursor.pointingHand.push()
                } else {
                    NSCursor.pop()
                }
            }

            // 播放列表
            Button(action: {
                showPlaylist.toggle()
                if showPlaylist {
                    showVolumeSlider = false
                    showSpeedSlider = false
                    showQuality = false
                    showPlayerSettings = false
                }
            }) {
                Image(systemName: "list.bullet")
                    .font(.system(size: 16))
                    .foregroundColor(showPlaylist ? .accentColor : .secondary)
            }
            .buttonStyle(.plain)
            .popover(isPresented: $showPlaylist, arrowEdge: .top) {
                PlaylistPopover(playerService: playerService)
            }
            .onHover { isHovering in
                if isHovering {
                    NSCursor.pointingHand.push()
                } else {
                    NSCursor.pop()
                }
            }
            
            // 音质选择按钮
            Button(action: {
                showQuality.toggle()
                if showQuality {
                    showVolumeSlider = false
                    showSpeedSlider = false
                    showPlaylist = false
                    showPlayerSettings = false
                }
            }) {
                Image(systemName: "hifispeaker")
                    .font(.system(size: 16))
                    .foregroundColor(showQuality ? .accentColor : .secondary)
            }
            .buttonStyle(.plain)
            .popover(isPresented: $showQuality, arrowEdge: .top) {
                QualitySelectionPopover()
            }
            .onHover { isHovering in
                if isHovering {
                    NSCursor.pointingHand.push()
                } else {
                    NSCursor.pop()
                }
            }
            
            // 通用设置按钮
            Button(action: {
                showPlayerSettings.toggle()
                if showPlayerSettings {
                    showVolumeSlider = false
                    showSpeedSlider = false
                    showPlaylist = false
                    showQuality = false
                }
            }) {
                Image(systemName: "gearshape")
                    .font(.system(size: 16))
                    .foregroundColor(showPlayerSettings ? .accentColor : .secondary)
            }
            .buttonStyle(.plain)
            .popover(isPresented: $showPlayerSettings, arrowEdge: .top) {
                PlayerGeneralSettingsPopover(playerService: playerService)
            }
            .onHover { isHovering in
                if isHovering {
                    NSCursor.pointingHand.push()
                } else {
                    NSCursor.pop()
                }
            }
        }
    }

    private var volumeIcon: String {
        if volume == 0 {
            return "speaker.slash.fill"
        } else if volume < 0.3 {
            return "speaker.wave.1.fill"
        } else if volume < 0.7 {
            return "speaker.wave.2.fill"
        } else {
            return "speaker.wave.3.fill"
        }
    }
}

// 音量控制弹出窗口
struct VolumeControlPopover: View {
    @Binding var volume: Double
    @State private var localVolume: Double = 0.0
    
    var body: some View {
        VStack(spacing: 8) {
            Text("\(Int(localVolume * 100))%")
                .font(.caption)
                .fontWeight(.medium)
                .foregroundColor(.primary)

            // 简约的横排滑块
            Slider(value: Binding(
                get: { localVolume },
                set: { newValue in
                    localVolume = newValue
                    volume = newValue  // 立即更新外部绑定
                }
            ), in: 0...1)
                .frame(width: 120)
                .controlSize(.small)
        }
        .padding(12)
        .onAppear {
            localVolume = volume  // 初始化本地状态
        }
        .onChange(of: volume) { newValue in
            // 当外部值改变时同步本地状态
            if abs(newValue - localVolume) > 0.01 {
                localVolume = newValue
            }
        }
    }
}

// 播放速度控制弹出窗口
struct SpeedControlPopover: View {
    @Binding var playbackSpeed: Double

    private let speedOptions: [Double] = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0]

    var body: some View {
        VStack(spacing: 6) {
            // 预设速度选项
            ForEach(speedOptions, id: \.self) { speed in
                Button(action: {
                    playbackSpeed = speed
                }) {
                    Text("\(speed, specifier: "%.2g")x")
                        .font(.caption)
                        .fontWeight(.medium)
                        .foregroundColor(playbackSpeed == speed ? .white : .primary)
                        .frame(width: 50, height: 28)
                        .background(
                            RoundedRectangle(cornerRadius: 6)
                                .fill(playbackSpeed == speed ? Color.accentColor : Color.gray.opacity(0.2))
                        )
                }
                .buttonStyle(.plain)
                .onHover { isHovering in
                    if isHovering {
                        NSCursor.pointingHand.push()
                    } else {
                        NSCursor.pop()
                    }
                }
            }
        }
        .padding(12)
    }
}


// 播放列表弹出窗口
struct PlaylistPopover: View {
    let playerService: PlayerService

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // 标题
            HStack {
                Text("播放列表")
                    .font(.headline)
                    .fontWeight(.medium)

                Spacer()

                HStack(spacing: 12) {
                    Text("\(playerService.playlist.count) 首歌曲")
                        .font(.caption)
                        .foregroundColor(.secondary)
                    
                    // 删除全部按钮
                    if !playerService.playlist.isEmpty {
                        Button("删除全部") {
                            playerService.clearPlaylist()
                        }
                        .font(.caption)
                        .foregroundColor(.secondary)
                        .buttonStyle(.plain)
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 12)
            .padding(.bottom, 8)

            Divider()

            // 播放列表
            if playerService.playlist.isEmpty {
                // 空状态占位
                VStack(spacing: 12) {
                    Image(systemName: "music.note.list")
                        .font(.system(size: 32))
                        .foregroundColor(.secondary.opacity(0.6))
                    
                    Text("播放列表为空")
                        .font(.subheadline)
                        .foregroundColor(.secondary)
                    
                    Text("播放歌曲时将自动添加到播放列表")
                        .font(.caption)
                        .foregroundColor(.secondary.opacity(0.7))
                }
                .frame(maxWidth: .infinity)
                .frame(height: 120)
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(Array(playerService.playlist.enumerated()), id: \.element.id) { index, song in
                            PlaylistItemView(
                                song: song,
                                index: index,
                                isCurrentSong: index == playerService.currentIndex,
                                onTap: {
                                    playerService.playSong(at: index)
                                },
                                onDelete: {
                                    playerService.removeSong(at: index)
                                }
                            )

                            if index < playerService.playlist.count - 1 {
                                Divider()
                                    .padding(.leading, 56)
                            }
                        }
                    }
                }
                .frame(maxHeight: 300)
            }
        }
        .frame(width: 320)
    }
}

// 播放列表项组件
struct PlaylistItemView: View {
    let song: Song
    let index: Int
    let isCurrentSong: Bool
    let onTap: () -> Void
    let onDelete: () -> Void
    @State private var isHovered = false

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 12) {
                // 封面
                AsyncImage(url: URL(string: ImageURLHelper.processImageURL(song.cover, size: .small)?.absoluteString ?? "")) { image in
                    image
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                } placeholder: {
                    Rectangle()
                        .fill(Color.gray.opacity(0.3))
                        .overlay(
                            Image(systemName: "music.note")
                                .foregroundColor(.gray)
                                .font(.system(size: 12))
                        )
                }
                .frame(width: 40, height: 40)
                .cornerRadius(4)
                .clipped()

                // 歌曲信息
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 4) {
                        Text(song.title ?? "")
                            .font(.subheadline)
                            .fontWeight(isCurrentSong ? .medium : .regular)
                            .foregroundColor(isCurrentSong ? .accentColor : .primary)
                            .lineLimit(1)
                        
                        // 音质标识
                        if song.isVip == true {
                            Text("VIP")
                                .font(.caption2)
                                .fontWeight(.bold)
                                .foregroundColor(.orange)
                                .padding(.horizontal, 2)
                                .padding(.vertical, 0.5)
                                .background(Color.orange.opacity(0.1))
                                .cornerRadius(2)
                        }
                        
                        if song.isSq == true {
                            Text("SQ")
                                .font(.caption2)
                                .fontWeight(.bold)
                                .foregroundColor(.blue)
                                .padding(.horizontal, 2)
                                .padding(.vertical, 0.5)
                                .background(Color.blue.opacity(0.1))
                                .cornerRadius(2)
                        } else if song.isHq == true {
                            Text("HQ")
                                .font(.caption2)
                                .fontWeight(.bold)
                                .foregroundColor(.blue)
                                .padding(.horizontal, 2)
                                .padding(.vertical, 0.5)
                                .background(Color.blue.opacity(0.1))
                                .cornerRadius(2)
                        }
                    }

                    Text(song.artist ?? "")
                        .font(.caption)
                        .foregroundColor(.secondary)
                        .lineLimit(1)
                }

                Spacer()

                // 播放按钮或当前播放指示器
                HStack(spacing: 8) {
                    if isCurrentSong {
                        Image(systemName: "speaker.wave.2.fill")
                            .font(.system(size: 16))  // 与删除按钮大小一致
                            .foregroundColor(.accentColor)
                    }
                    
                    // 删除按钮（悬停时显示）
                    if isHovered {
                        Button(action: onDelete) {
                            Image(systemName: "minus.circle.fill")
                                .font(.system(size: 16))
                                .foregroundColor(.secondary)
                        }
                        .buttonStyle(.plain)
                        .onHover { hovering in
                            if hovering {
                                NSCursor.pointingHand.push()
                            } else {
                                NSCursor.pop()
                            }
                        }
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background(isCurrentSong ? Color.accentColor.opacity(0.1) : Color.clear)
        .onHover { hovering in
            withAnimation(.easeInOut(duration: 0.2)) {
                isHovered = hovering
            }
            if hovering {
                NSCursor.pointingHand.push()
            } else {
                NSCursor.pop()
            }
        }
    }
}

// 音质选择弹出窗口
struct QualitySelectionPopover: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var playerService: PlayerService
    @State private var selectedQuality: AudioQuality = .normal
    @State private var compatibilityMode: Bool = true
    
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("音质选择")
                .font(.headline)
                .fontWeight(.semibold)
            
            VStack(alignment: .leading, spacing: 8) {
                ForEach(AudioQuality.allCases, id: \.self) { quality in
                    qualityRow(quality: quality)
                }
            }
            
            Divider()
            
            VStack(alignment: .leading, spacing: 8) {
                Text("兼容模式 (mp3格式)")
                    .font(.subheadline)
                    .fontWeight(.medium)
                
                Toggle(isOn: Binding(
                    get: { compatibilityMode },
                    set: { newValue in
                        compatibilityMode = newValue
                        // 立即调用PlayerService，不检查是否真正改变
                        playerService.setQualityCompatibility(newValue)
                    }
                )) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("如果高音质播放失败，请开启此选项")
                            .font(.caption2)
                            .foregroundColor(.secondary)
                    }
                }
                .toggleStyle(.switch)
                .controlSize(.small)
            }
        }
        .padding(16)
        .frame(minWidth: 240)
        .onAppear {
            // 从 PlayerService 获取当前设置
            selectedQuality = playerService.audioQuality
            compatibilityMode = playerService.qualityCompatibility
        }
    }
    
    @ViewBuilder
    private func qualityRow(quality: AudioQuality) -> some View {
        Button(action: {
            selectedQuality = quality
            // 立即调用PlayerService，不检查是否真正改变
            playerService.setAudioQuality(quality)
        }) {
            HStack(spacing: 8) {
                // 使用 macOS 原生单选框样式
                Image(systemName: selectedQuality == quality ? "largecircle.fill.circle" : "circle")
                    .font(.system(size: 12))
                    .foregroundColor(selectedQuality == quality ? .accentColor : .secondary)
                
                VStack(alignment: .leading, spacing: 2) {
                    Text(quality.displayName)
                        .font(.system(size: 13))
                        .foregroundColor(.primary)
                    
                    Text(quality.description)
                        .font(.system(size: 11))
                        .foregroundColor(.secondary)
                        .lineLimit(1)
                }
                
                Spacer()
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { isHovering in
            if isHovering {
                NSCursor.pointingHand.push()
            } else {
                NSCursor.pop()
            }
        }
    }
}

// 播放器通用设置弹出窗口
struct PlayerGeneralSettingsPopover: View {
    let playerService: PlayerService
    
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("播放器设置")
                .font(.headline)
                .fontWeight(.semibold)
            
            VStack(alignment: .leading, spacing: 12) {
                Toggle(isOn: Binding(
                    get: { playerService.autoSkipOnError },
                    set: { newValue in
                        playerService.setAutoSkipOnError(newValue)
                    }
                )) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("播放失败自动跳过")
                            .font(.subheadline)
                        Text("当歌曲播放失败时，自动跳转到下一首歌曲")
                            .font(.caption)
                            .foregroundColor(.secondary)
                    }
                }
                .toggleStyle(.switch)
                .controlSize(.regular)
            }
        }
        .padding(16)
        .frame(minWidth: 280)
    }
}

#Preview {
    PlayerView()
        .environmentObject(PlayerService.shared)
}
