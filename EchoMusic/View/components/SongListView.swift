//
//  SongListView.swift
//  EchoMusic
//
//  Created by AI Assistant on 2025/8/15.
//

import SwiftUI

/// 排序字段枚举
enum SortField: String, CaseIterable {
    case defaultOrder = "default"
    case title = "title"
    case artist = "artist"
    case album = "album"
    case duration = "duration"
    
    var displayName: String {
        switch self {
        case .defaultOrder: return "默认排序"
        case .title: return "歌曲名"
        case .artist: return "歌手"
        case .album: return "专辑"
        case .duration: return "时长"
        }
    }
}

/// 排序顺序枚举
enum SortOrder: String, CaseIterable {
    case asc = "asc"
    case desc = "desc"
    
    var displayName: String {
        switch self {
        case .asc: return "升序"
        case .desc: return "降序"
        }
    }
}

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
    @State private var sortField: SortField = .defaultOrder
    @State private var sortOrder: SortOrder = .asc
    @State private var searchQuery: String = ""
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
    
    // MARK: - 搜索和排序相关方法
    
    /// 获取搜索过滤后的歌曲列表
    private var filteredTracks: [PlaylistTrackInfo] {
        if searchQuery.isEmpty {
            return tracks
        }
        
        let trimmedQuery = searchQuery.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
        
        return tracks.filter { track in
            let songTitle = getSongTitle(from: track)
            let artistName = track.singername ?? ""
            
            return songTitle.lowercased().contains(trimmedQuery) ||
                   artistName.lowercased().contains(trimmedQuery)
        }
    }
    
    /// 获取排序后的歌曲列表
    private var sortedTracks: [PlaylistTrackInfo] {
        let tracksToSort = filteredTracks
        
        if sortField == .defaultOrder {
            return tracksToSort
        }
        
        return tracksToSort.sorted { track1, track2 in
            let comparison: Bool
            
            switch sortField {
            case .title:
                let title1 = getSongTitle(from: track1)
                let title2 = getSongTitle(from: track2)
                comparison = title1.localizedCaseInsensitiveCompare(title2) == .orderedAscending
            case .artist:
                let artist1 = track1.singername ?? ""
                let artist2 = track2.singername ?? ""
                comparison = artist1.localizedCaseInsensitiveCompare(artist2) == .orderedAscending
            case .album:
                let album1 = track1.albumname ?? ""
                let album2 = track2.albumname ?? ""
                comparison = album1.localizedCaseInsensitiveCompare(album2) == .orderedAscending
            case .duration:
                let duration1 = track1.duration ?? 0
                let duration2 = track2.duration ?? 0
                comparison = duration1 < duration2
            case .defaultOrder:
                comparison = false
            }
            
            return sortOrder == .asc ? comparison : !comparison
        }
    }
    
    /// 获取歌曲标题（处理包含歌手名的格式）
    private func getSongTitle(from track: PlaylistTrackInfo) -> String {
        let nameParts = (track.name ?? "未知歌曲").components(separatedBy: " - ")
        return nameParts.count > 1 ? nameParts[1] : (track.name ?? "未知歌曲")
    }
    
    /// 切换排序字段
    private func toggleSortField(_ field: SortField) {
        if sortField == field {
            // 如果点击相同的字段，切换排序顺序
            sortOrder = sortOrder == .asc ? .desc : .asc
        } else {
            // 如果点击不同的字段，设置新的字段并使用升序
            sortField = field
            sortOrder = .asc
        }
    }
    
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // 歌曲列表头部
            HStack {
                if isSelectionMode {
                    HStack(spacing: 16) {
                        // 全选复选框
                        Button(action: {
                            let visibleTracks = sortedTracks
                            let visibleTrackIds = Set(visibleTracks.map { $0.id })
                            let allVisibleSelected = visibleTrackIds.isSubset(of: selectedTracks)
                            
                            if allVisibleSelected && selectedTracks.count >= visibleTracks.count {
                                // 全部选中 -> 取消选择所有可见的
                                selectedTracks.subtract(visibleTrackIds)
                            } else {
                                // 部分选中或未选中 -> 全选所有可见的
                                selectedTracks.formUnion(visibleTrackIds)
                            }
                        }) {
                            HStack(spacing: 8) {
                                // 根据选中状态显示不同的复选框
                                let visibleTracks = sortedTracks
                                let visibleTrackIds = Set(visibleTracks.map { $0.id })
                                let allVisibleSelected = visibleTrackIds.isSubset(of: selectedTracks)
                                let anyVisibleSelected = visibleTrackIds.intersection(selectedTracks).count > 0
                                
                                if selectedTracks.isEmpty || !anyVisibleSelected {
                                    // 全部未选中
                                    Image(systemName: "square")
                                        .font(.system(size: 18))
                                        .foregroundColor(.secondary)
                                } else if allVisibleSelected {
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
                        
                        Text("已选择 \(selectedTracks.count) / \(sortedTracks.count) 首歌曲")
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
                    HStack(spacing: 12) {
                        Text(title)
                            .font(.headline)
                            .fontWeight(.semibold)
                        
                        Spacer()
                        
                        // 排序控件
                        Menu {
                            ForEach(SortField.allCases, id: \.self) { field in
                                Button(action: {
                                    toggleSortField(field)
                                }) {
                                    HStack {
                                        Text(field.displayName)
                                        Spacer()
                                        if sortField == field {
                                            Image(systemName: "checkmark")
                                                .foregroundColor(.accentColor)
                                        }
                                    }
                                }
                            }
                            
                            Divider()
                            
                            ForEach(SortOrder.allCases, id: \.self) { order in
                                Button(action: {
                                    sortOrder = order
                                }) {
                                    HStack {
                                        Text(order.displayName)
                                        Spacer()
                                        if sortOrder == order {
                                            Image(systemName: "checkmark")
                                                .foregroundColor(.accentColor)
                                        }
                                    }
                                }
                            }
                        } label: {
                            HStack(spacing: 2) {
                                Image(systemName: sortOrder == .asc ? "arrow.up" : "arrow.down")
                                    .font(.caption2)
                                Text(sortField.displayName)
                                    .font(.caption2)
                                    .fontWeight(.medium)
                            }
                            .foregroundColor(.accentColor)
                            .padding(.horizontal, 4)
                            .padding(.vertical, 2)
                            .background(Color.accentColor.opacity(0.1))
                            .cornerRadius(4)
                        }
                        .menuStyle(.borderlessButton)
                        .help("排序方式")
                        
                        Spacer()
                        
                        // 搜索框
                        TextField("搜索歌曲或歌手", text: $searchQuery)
                            .textFieldStyle(.roundedBorder)
                            .font(.caption)
                            // .frame(width: 120)
                            .overlay(
                                HStack {
                                    if !searchQuery.isEmpty {
                                        Spacer()
                                        Button(action: {
                                            searchQuery = ""
                                        }) {
                                            Image(systemName: "xmark.circle.fill")
                                                .foregroundColor(.secondary)
                                                .font(.caption)
                                        }
                                        .buttonStyle(.plain)
                                        .padding(.trailing, 8)
                                    }
                                }
                            )
                        
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
                } else if sortedTracks.isEmpty {
                    VStack(spacing: 12) {
                        Image(systemName: "magnifyingglass")
                            .font(.system(size: 48))
                            .foregroundColor(.secondary)
                        Text(searchQuery.isEmpty ? "暂无歌曲" : "未找到匹配的歌曲")
                            .font(.headline)
                            .foregroundColor(.secondary)
                        if !searchQuery.isEmpty {
                            Text("搜索关键词: \"\(searchQuery)\"")
                                .font(.caption)
                                .foregroundColor(.secondary.opacity(0.7))
                        } else if sortField != .defaultOrder {
                            Text("当前排序: \(sortField.displayName) - \(sortOrder.displayName)")
                                .font(.caption)
                                .foregroundColor(.secondary.opacity(0.7))
                        }
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    ScrollView {
                        LazyVStack(spacing: 0) {
                            ForEach(Array(sortedTracks.enumerated()), id: \.element.id) { index, track in
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
