//
//  PlaylistView.swift
//  EchoMusic
//
//  Created on 2025/8/4.
//

import SwiftUI

/// 歌单视图 - 专门用于显示歌单详情
struct PlaylistView: View {
    @State private var selectedPlaylist: UserPlaylistResponse.UserPlaylist?
    @State private var selectedPlaylistType: PlaylistType?
    
    var body: some View {
        Group {
            if let playlist = selectedPlaylist, let playlistType = selectedPlaylistType {
                // 显示选中的歌单详情
                PlaylistDetailView(
                    playlist: playlist,
                    onBack: {
                        // 这里不需要返回逻辑，因为返回是通过主导航处理的
                    }
                )
                .id("\(playlist.global_collection_id ?? "unknown")_\(playlistType.rawValue)") // 确保视图刷新
            } else {
                // 没有选中歌单时的默认视图
                VStack(spacing: 20) {
                    Image(systemName: "music.note.list")
                        .font(.system(size: 60))
                        .foregroundColor(.secondary)
                    
                    Text("选择一个歌单")
                        .font(.title2)
                        .foregroundColor(.secondary)
                    
                    Text("从左侧边栏选择要查看的歌单")
                        .font(.body)
                        .foregroundColor(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: NSNotification.Name("PlaylistSelected"))) { notification in
            // 监听歌单选择通知
            if let playlist = notification.userInfo?["playlist"] as? UserPlaylistResponse.UserPlaylist,
               let playlistType = notification.userInfo?["playlistType"] as? PlaylistType {
                // 直接设置新的歌单状态
                selectedPlaylist = playlist
                selectedPlaylistType = playlistType
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: NSNotification.Name("PlaylistDeleted"))) { notification in
            // 监听歌单删除通知
            if let deletedPlaylistId = notification.userInfo?["deletedPlaylistId"] as? String,
               selectedPlaylist?.global_collection_id == deletedPlaylistId {
                // 清除已删除歌单的状态
                selectedPlaylist = nil
                selectedPlaylistType = nil
            }
        }
    }
}

// MARK: - 歌单详情页

struct PlaylistDetailView: View {
    let playlist: UserPlaylistResponse.UserPlaylist
    let onBack: () -> Void
    @State private var playlistService = PlaylistService.shared
    @State private var playlistDetail: PlaylistDetailInfo?
    @State private var tracks: [PlaylistTrackInfo] = []
    @State private var isLoadingDetail = false
    @State private var isLoadingTracks = false
    @State private var isRefreshing = false
    @State private var errorMessage: String?
    @State private var showPlaylistSelection = false
    @State private var showRemoveConfirmation = false
    @State private var tracksToRemove: [PlaylistTrackInfo] = []
    @EnvironmentObject private var playerService: PlayerService
    @EnvironmentObject private var userService: UserService
    
    init(playlist: UserPlaylistResponse.UserPlaylist, onBack: @escaping () -> Void) {
        self.playlist = playlist
        self.onBack = onBack
    }
    
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            
            if let detail = playlistDetail {
                // 歌单头部信息
                playlistHeader(detail: detail)
                
                Divider()
                
                // 歌曲列表 - 使用通用的SongListView组件
                SongListView(
                    tracks: tracks,
                    title: "歌曲列表",
                    isLoading: isLoadingTracks,
                    errorMessage: errorMessage,
                    batchOperations: batchOperations
                )
            } else if isLoadingDetail {
                // 加载状态
                VStack {
                    ProgressView()
                    Text("加载中...")
                        .foregroundColor(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let error = errorMessage {
                // 错误状态
                VStack(spacing: 16) {
                    Image(systemName: "exclamationmark.triangle")
                        .font(.system(size: 48))
                        .foregroundColor(.orange)
                    Text("加载失败")
                        .font(.headline)
                    Text(error)
                        .foregroundColor(.secondary)
                        .multilineTextAlignment(.center)
                    Button("重试") {
                        Task { await loadPlaylistData() }
                    }
                    .buttonStyle(.borderedProminent)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .sheet(isPresented: $showPlaylistSelection) {
            PlaylistSelectionDialog(
                selectedTracks: tracksToRemove,
                onAddToPlaylist: { targetPlaylist, selectedTracks in
                    await addTracksToPlaylist(targetPlaylist, selectedTracks)
                }
            )
        }
        .alert("确认删除", isPresented: $showRemoveConfirmation) {
            Button("取消", role: .cancel) {
                tracksToRemove = []
            }
            Button("删除", role: .destructive) {
                Task {
                    await removeTracksFromPlaylist(tracksToRemove)
                }
            }
        } message: {
            Text("确定要从歌单中删除这 \(tracksToRemove.count) 首歌曲吗？")
        }
        .onAppear {
            Task { await loadPlaylistData() }
        }
        .onReceive(NotificationCenter.default.publisher(for: NSNotification.Name("RefreshCurrentContent"))) { _ in
            Task {
                isRefreshing = true
                await loadPlaylistData()
                isRefreshing = false
                // 发送刷新完成通知
                NotificationCenter.default.post(
                    name: NSNotification.Name("RefreshCompleted"),
                    object: nil
                )
            }
        }
    }
    
    // 批量操作配置
    private var batchOperations: [BatchOperation] {
        var operations: [BatchOperation] = []
        
        // 添加到其他歌单
        operations.append(BatchOperation(title: "添加到其他歌单") { selectedTracks in
            tracksToRemove = selectedTracks
            showPlaylistSelection = true
        })
        
        // 从此歌单中删除 - 只有用户创建的歌单才显示
        if isUserCreatedPlaylist {
            operations.append(BatchOperation(title: "从此歌单中删除", isDestructive: true) { selectedTracks in
                tracksToRemove = selectedTracks
                showRemoveConfirmation = true
            })
        }
        
        return operations
    }
    
    // 判断是否为用户创建的歌单
    private var isUserCreatedPlaylist: Bool {
        let currentUserId = userService.currentUser?.userid
        return playlist.list_create_userid == currentUserId
    }
    
    @ViewBuilder
    private func playlistHeader(detail: PlaylistDetailInfo) -> some View {
        HStack(alignment: .top, spacing: 10) {
            // 歌单封面
            AsyncImage(url: imageURL(from: detail.pic)) { image in
                image
                    .resizable()
                    .aspectRatio(contentMode: .fill)
            } placeholder: {
                Rectangle()
                    .fill(Color.gray.opacity(0.2))
                    .overlay(
                        Image(systemName: "music.note")
                            .foregroundColor(.gray)
                            .font(.system(size: 40))
                    )
            }
            .frame(width: 160, height: 160)
            .clipShape(RoundedRectangle(cornerRadius: 12))
            
            // 歌单信息
            VStack(alignment: .leading, spacing: 8) {
                Text(detail.name ?? "未知歌单")
                    .font(.title)
                    .fontWeight(.bold)
                
                // 简介
                Text(detail.intro ?? "")
                    .font(.body)
                    .foregroundColor(.secondary)
                    .lineLimit(3)
                
                VStack(alignment: .leading, spacing: 4) {
                    Text("\(detail.count ?? 0) 首歌曲")
                        .font(.subheadline)
                        .foregroundColor(.secondary)
                    
                    VStack(alignment: .leading, spacing: 2) {
                        if let creator = detail.creator {
                            Text("创建者：\(creator)")
                                .font(.caption)
                                .foregroundColor(.secondary)
                        }
                        
                        if let createTime = detail.create_time {
                            Text("创建时间：\(formatTimestamp(createTime))")
                                .font(.caption)
                                .foregroundColor(.secondary)
                        }
                        
                        if let updateTime = detail.update_time {
                            Text("更新时间：\(formatTimestamp(updateTime))")
                                .font(.caption)
                                .foregroundColor(.secondary)
                        }
                    }
                }
                
                // 操作按钮
                HStack(spacing: 12) {
                    Button(action: {
                        let songs = tracks.map { Song(from: $0) }
                        playerService.playAllSongs(songs)
                    }) {
                        HStack(spacing: 8) {
                            Image(systemName: "play.fill")
                            Text("播放")
                        }
                        .font(.headline)
                        .foregroundColor(.white)
                        .padding(.horizontal, 20)
                        .padding(.vertical, 10)
                        .background(tracks.isEmpty ? Color.gray : Color.accentColor)
                        .cornerRadius(10)
                    }
                    .buttonStyle(.plain)
                    .disabled(tracks.isEmpty)
                    .offset(y: -2)
                }
                
            }
            
            Spacer()
        }
        .padding(.all, 20)
    }
    
    private func imageURL(from urlString: String?) -> URL? {
        return ImageURLHelper.processImageURL(urlString, size: .large)
    }
    
    private func formatTimestamp(_ timestamp: Int) -> String {
        let date = Date(timeIntervalSince1970: TimeInterval(timestamp))
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .none
        formatter.locale = Locale(identifier: "zh_CN")
        return formatter.string(from: date)
    }
    
    private func loadPlaylistData() async {
        // 判断是否为收藏的歌单：创建者不是当前用户
        let currentUserId = UserService.shared.currentUser?.userid
        let isCollectedPlaylist = playlist.list_create_userid != currentUserId
        
        // 收藏的歌单使用list_create_gid，创建的歌单使用global_collection_id
        let playlistId: String
        if isCollectedPlaylist, let listCreateGid = playlist.list_create_gid {
            playlistId = listCreateGid
        } else if let globalCollectionId = playlist.global_collection_id {
            playlistId = globalCollectionId
        } else {
            await MainActor.run {
                self.errorMessage = "无法获取歌单ID"
            }
            return
        }
        
        await MainActor.run {
            isLoadingDetail = true
            isLoadingTracks = true
            errorMessage = nil
        }
        
        do {
            // 获取歌单详情
            let detail = try await playlistService.getPlaylistDetail(globalCollectionId: playlistId)
            
            // 获取所有页的歌曲列表
            var allTracks: [PlaylistTrackInfo] = []
            var currentPage = 1
            let pageSize = 100
            
            // 持续获取页面直到没有更多数据
            while true {
                let trackList = try await playlistService.getPlaylistTracks(
                    globalCollectionId: playlistId, 
                    page: currentPage, 
                    pageSize: pageSize
                )
                
                if trackList.isEmpty {
                    break
                }
                
                allTracks.append(contentsOf: trackList)
                
                // 如果返回的歌曲数少于页大小，说明是最后一页
                if trackList.count < pageSize {
                    break
                }
                
                currentPage += 1
            }
            
            await MainActor.run {
                self.playlistDetail = detail
                self.tracks = allTracks
                self.isLoadingDetail = false
                self.isLoadingTracks = false
            }
        } catch {
            await MainActor.run {
                self.errorMessage = error.localizedDescription
                self.isLoadingDetail = false
                self.isLoadingTracks = false
            }
        }
    }
    
    // 添加歌曲到其他歌单
    private func addTracksToPlaylist(_ targetPlaylist: UserPlaylistResponse.UserPlaylist, _ selectedTracks: [PlaylistTrackInfo]) async {
        guard let listid = targetPlaylist.listid else {
            await MainActor.run {
                errorMessage = "目标歌单ID无效"
            }
            return
        }
        
        do {
            try await playlistService.addTracksToPlaylist(listid: listid, tracks: selectedTracks)
            
            await MainActor.run {
                // 可以显示成功提示
                print("成功添加 \(selectedTracks.count) 首歌曲到歌单「\(targetPlaylist.name ?? "未知歌单")」")
                tracksToRemove = []
            }
        } catch {
            await MainActor.run {
                errorMessage = "添加失败: \(error.localizedDescription)"
                tracksToRemove = []
            }
        }
    }
    
    // 从歌单中删除歌曲
    private func removeTracksFromPlaylist(_ selectedTracks: [PlaylistTrackInfo]) async {
        guard let listid = playlist.listid else {
            await MainActor.run {
                errorMessage = "歌单ID无效"
                tracksToRemove = []
            }
            return
        }
        
        // 获取要删除的歌曲的 fileid
        let fileids = selectedTracks.compactMap { $0.fileid }
        
        guard !fileids.isEmpty else {
            await MainActor.run {
                errorMessage = "没有有效的歌曲文件ID"
                tracksToRemove = []
            }
            return
        }
        
        do {
            try await playlistService.removeTracksFromPlaylist(listid: listid, fileids: fileids)
            
            // 删除成功后重新加载歌曲列表
            await loadPlaylistData()
            
            await MainActor.run {
                print("成功从歌单中删除 \(selectedTracks.count) 首歌曲")
                tracksToRemove = []
            }
        } catch {
            await MainActor.run {
                errorMessage = "删除失败: \(error.localizedDescription)"
                tracksToRemove = []
            }
        }
    }
}
