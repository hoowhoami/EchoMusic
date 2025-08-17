//
//  SongListView.swift
//  EchoMusic
//
//  Created by AI Assistant on 2025/8/15.
//

import SwiftUI

/// 批量操作结构体
struct BatchOperation {
    let title: String
    let action: ([PlaylistTrackInfo]) -> Void
    let isDestructive: Bool
    
    init(title: String, isDestructive: Bool = false, action: @escaping ([PlaylistTrackInfo]) -> Void) {
        self.title = title
        self.isDestructive = isDestructive
        self.action = action
    }
}

/// 通用歌曲列表视图组件
/// 可用于显示任何歌曲列表，支持批量操作
struct SongListView: View {
    let tracks: [PlaylistTrackInfo]
    let title: String
    let isLoading: Bool
    let errorMessage: String?
    let onTrackPlay: ((PlaylistTrackInfo) -> Void)?
    let batchOperations: [BatchOperation]
    
    @State private var isSelectionMode = false
    @State private var selectedTracks: Set<UUID> = []
    @EnvironmentObject private var playerService: PlayerService
    
    init(
        tracks: [PlaylistTrackInfo],
        title: String = "歌曲列表",
        isLoading: Bool = false,
        errorMessage: String? = nil,
        onTrackPlay: ((PlaylistTrackInfo) -> Void)? = nil,
        batchOperations: [BatchOperation] = []
    ) {
        self.tracks = tracks
        self.title = title
        self.isLoading = isLoading
        self.errorMessage = errorMessage
        self.onTrackPlay = onTrackPlay
        self.batchOperations = batchOperations
    }
    
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // 歌曲列表头部
            HStack {
                if isSelectionMode {
                    HStack(spacing: 16) {
                        // 全选复选框
                        Button(action: {
                            if selectedTracks.count == tracks.count {
                                // 全部选中 -> 全部取消
                                selectedTracks.removeAll()
                            } else {
                                // 部分选中或未选中 -> 全选
                                selectedTracks = Set(tracks.map { $0.id })
                            }
                        }) {
                            HStack(spacing: 8) {
                                // 根据选中状态显示不同的复选框
                                if selectedTracks.isEmpty {
                                    // 全部未选中
                                    Image(systemName: "square")
                                        .font(.system(size: 18))
                                        .foregroundColor(.secondary)
                                } else if selectedTracks.count == tracks.count {
                                    // 全部选中
                                    Image(systemName: "checkmark.square.fill")
                                        .font(.system(size: 18))
                                        .foregroundColor(.accentColor)
                                } else {
                                    // 部分选中 (indeterminate状态)
                                    Image(systemName: "minus.square.fill")
                                        .font(.system(size: 18))
                                        .foregroundColor(.accentColor)
                                }
                                
                                Text("全选")
                                    .font(.headline)
                                    .foregroundColor(.primary)
                            }
                        }
                        .buttonStyle(.plain)
                        
                        Text("已选择 \(selectedTracks.count) 首歌曲")
                            .font(.headline)
                            .fontWeight(.semibold)
                        
                        Spacer()
                        
                        if !selectedTracks.isEmpty {
                            Menu {
                                // 默认的添加到播放列表操作
                                Button("添加到播放列表") {
                                    let selectedSongs = tracks.filter { track in
                                        selectedTracks.contains(track.id)
                                    }.map { Song(from: $0) }
                                    playerService.addSongs(selectedSongs)
                                    isSelectionMode = false
                                    selectedTracks.removeAll()
                                }
                                
                                // 动态的批量操作
                                ForEach(Array(batchOperations.enumerated()), id: \.offset) { _, operation in
                                    Button(operation.title, role: operation.isDestructive ? .destructive : nil) {
                                        let selectedTracksList = tracks.filter { track in
                                            selectedTracks.contains(track.id)
                                        }
                                        operation.action(selectedTracksList)
                                        isSelectionMode = false
                                        selectedTracks.removeAll()
                                    }
                                }
                            } label: {
                                HStack(spacing: 4) {
                                    Text("批量操作")
                                        .font(.headline)
                                    
                                    if !selectedTracks.isEmpty {
                                        Text("(\(selectedTracks.count))")
                                            .font(.caption)
                                            .fontWeight(.bold)
                                    }
                                }
                                .foregroundColor(.white)
                                .padding(.horizontal, 16)
                                .padding(.vertical, 8)
                                .background(Color.accentColor)
                                .cornerRadius(8)
                            }
                        }
                        
                        // 取消按钮放在右边
                        Button("取消") {
                            isSelectionMode = false
                            selectedTracks.removeAll()
                        }
                        .font(.headline)
                        .foregroundColor(.accentColor)
                    }
                } else {
                    Text(title)
                        .font(.headline)
                        .fontWeight(.semibold)
                    
                    Spacer()
                    
                    Button(action: {
                        isSelectionMode = true
                    }) {
                        Text("批量操作")
                            .font(.headline)
                            .foregroundColor(.accentColor)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 12)
            
            // 歌曲列表内容
            Group {
                if isLoading {
                    VStack {
                        ProgressView()
                        Text("加载中...")
                            .foregroundColor(.secondary)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let errorMessage = errorMessage {
                    VStack(spacing: 16) {
                        Image(systemName: "exclamationmark.triangle")
                            .font(.system(size: 48))
                            .foregroundColor(.orange)
                        Text("加载失败")
                            .font(.headline)
                        Text(errorMessage)
                            .foregroundColor(.secondary)
                            .multilineTextAlignment(.center)
                        Button("重试") {
                            // 重试功能已移除，请使用标题栏的全局刷新
                        }
                        .buttonStyle(.borderedProminent)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if tracks.isEmpty {
                    VStack(spacing: 12) {
                        Image(systemName: "music.note")
                            .font(.system(size: 48))
                            .foregroundColor(.secondary)
                        Text("暂无歌曲")
                            .font(.headline)
                            .foregroundColor(.secondary)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    ScrollView {
                        LazyVStack(spacing: 0) {
                            ForEach(Array(tracks.enumerated()), id: \.element.id) { index, track in
                                SongListTrackRow(
                                    track: track,
                                    index: index + 1,
                                    isSelectionMode: isSelectionMode,
                                    isSelected: selectedTracks.contains(track.id),
                                    onSelectionToggle: { trackId in
                                        if selectedTracks.contains(trackId) {
                                            selectedTracks.remove(trackId)
                                        } else {
                                            selectedTracks.insert(trackId)
                                        }
                                    },
                                    onPlayTapped: {
                                        if !isSelectionMode {
                                            if let onTrackPlay = onTrackPlay {
                                                onTrackPlay(track)
                                            } else {
                                                let song = Song(from: track)
                                                playerService.playSong(song)
                                            }
                                        }
                                    }
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

/// 歌曲行组件
struct SongListTrackRow: View {
    let track: PlaylistTrackInfo
    let index: Int
    let isSelectionMode: Bool
    let isSelected: Bool
    let onSelectionToggle: ((UUID) -> Void)?
    let onPlayTapped: (() -> Void)?
    
    var body: some View {
        HStack(spacing: 12) {
            if isSelectionMode {
                // 复选框
                Button(action: {
                    onSelectionToggle?(track.id)
                }) {
                    Image(systemName: isSelected ? "checkmark.square.fill" : "square")
                        .font(.system(size: 18))
                        .foregroundColor(isSelected ? .accentColor : .secondary)
                }
                .buttonStyle(.plain)
            } else {
                // 序号
                Text("\(index)")
                    .font(.system(size: 14, weight: .medium))
                    .foregroundColor(.secondary)
                    .frame(width: 30, alignment: .trailing)
            }
            
            // 可点击的播放区域：从封面到歌曲信息
            HStack(spacing: 12) {
                // 歌曲封面
                AsyncImage(url: albumImageURL) { image in
                    image
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                } placeholder: {
                    Rectangle()
                        .fill(Color.gray.opacity(0.2))
                        .overlay(
                            Image(systemName: "music.note")
                                .foregroundColor(.gray)
                                .font(.system(size: 12))
                        )
                }
                .frame(width: 40, height: 40)
                .clipShape(RoundedRectangle(cornerRadius: 4))
                
                // 歌曲信息
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 4) {
                        // 使用统一的歌曲名称处理逻辑
                        Text(songTitle)
                            .font(.system(size: 14, weight: .medium))
                            .lineLimit(1)
                        
                        // 音质标识
                        if track.privilege == 10 {
                            Text("VIP")
                                .font(.caption2)
                                .fontWeight(.bold)
                                .foregroundColor(.orange)
                                .padding(.horizontal, 2)
                                .padding(.vertical, 0.5)
                                .background(Color.orange.opacity(0.1))
                                .cornerRadius(2)
                        }
                        
                        if let relateGoods = track.relate_goods, relateGoods.count > 2 {
                            Text("SQ")
                                .font(.caption2)
                                .fontWeight(.bold)
                                .foregroundColor(.blue)
                                .padding(.horizontal, 2)
                                .padding(.vertical, 0.5)
                                .background(Color.blue.opacity(0.1))
                                .cornerRadius(2)
                        } else if let relateGoods = track.relate_goods, relateGoods.count > 1 {
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
                    
                    Text(track.singername ?? "未知歌手")
                        .font(.system(size: 13))
                        .foregroundColor(.secondary)
                        .lineLimit(1)
                }
            }
            .contentShape(Rectangle())
            .onTapGesture {
                onPlayTapped?()
            }
            
            Spacer()
            
            // 专辑名
            Text(track.albumname ?? "")
                .font(.system(size: 13))
                .foregroundColor(.secondary)
                .lineLimit(1)
                .frame(minWidth: 100, alignment: .leading)
            
            // 时长
            Text(formatDuration(track.duration))
                .font(.system(size: 13))
                .foregroundColor(.secondary)
                .frame(width: 50, alignment: .trailing)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 8)
        .background(isSelected ? Color.accentColor.opacity(0.1) : Color.clear)
    }
    
    private var albumImageURL: URL? {
        return ImageURLHelper.processImageURL(track.cover, size: .small)
    }
    
    private func formatDuration(_ duration: Int?) -> String {
        guard let duration = duration, duration > 0 else { return "--:--" }
        
        let minutes = duration / 60
        let seconds = duration % 60
        
        return String(format: "%02d:%02d", minutes, seconds)
    }
    
    // 处理歌曲名称：参考Song模型的初始化方法
    private var songTitle: String {
        let nameParts = (track.name ?? "未知歌曲").components(separatedBy: " - ")
        return nameParts.count > 1 ? nameParts[1] : (track.name ?? "未知歌曲")
    }
}
