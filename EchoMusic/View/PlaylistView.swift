//
//  PlaylistView.swift
//  EchoMusic
//
//  Created on 2025/8/4.
//

import SwiftUI

/// 歌单视图 - 专门用于显示歌单和歌曲列表
struct PlaylistView: View {
    @EnvironmentObject private var userService: UserService
    @State private var showLoginSheet = false
    @State private var selectedSection: LibrarySection = .myCreatedPlaylists
    
    // 内部导航状态管理
    @State private var currentPlaylist: UserPlaylistResponse.UserPlaylist?
    @State private var showingPlaylistDetail = false
    
    var body: some View {
        Group {
            if userService.isLoggedIn {
                if showingPlaylistDetail, let playlist = currentPlaylist {
                    // 显示歌单详情页
                    PlaylistDetailView(
                        playlist: playlist,
                        sourceSection: selectedSection,
                        onBack: {
                            withAnimation(.easeInOut(duration: 0.2)) {
                                showingPlaylistDetail = false
                                currentPlaylist = nil
                            }
                        }
                    )
                } else {
                    // 显示音乐库主页
                    VStack(spacing: 0) {
                        // 自定义标签栏
                        HStack(spacing: 0) {
                            ForEach(LibrarySection.allCases, id: \.self) { section in
                                Button(action: {
                                    selectedSection = section
                                }) {
                                    HStack(spacing: 8) {
                                        Image(systemName: section.icon)
                                            .font(.system(size: 14))
                                        Text(section.rawValue)
                                            .font(.system(size: 13))
                                    }
                                    .padding(.horizontal, 16)
                                    .padding(.vertical, 8)
                                    .foregroundColor(selectedSection == section ? .accentColor : .secondary)
                                    .background(
                                        selectedSection == section ? 
                                        Color.accentColor.opacity(0.1) : Color.clear
                                    )
                                    .cornerRadius(6)
                                }
                                .buttonStyle(.plain)
                            }
                            Spacer()
                        }
                        .padding(.horizontal, 16)
                        .padding(.vertical, 8)
                        .background(Color.clear)
                        
                        // 内容区域
                        LibraryContentView(
                            section: selectedSection,
                            onPlaylistTapped: { playlist in
                                withAnimation(.easeInOut(duration: 0.2)) {
                                    currentPlaylist = playlist
                                    showingPlaylistDetail = true
                                }
                            }
                        )
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                    }
                }
            } else {
                // 未登录状态 - 显示登录提示
                VStack(spacing: 20) {
                    Image(systemName: "music.note.list")
                        .font(.system(size: 64))
                        .foregroundColor(.secondary)
                    
                    Text("访问音乐库需要登录")
                        .font(.title2)
                        .fontWeight(.medium)
                    
                    Text("登录后您可以查看收藏的歌曲、创建的播放列表等内容")
                        .font(.body)
                        .foregroundColor(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 32)
                    
                    Button(action: {
                        showLoginSheet = true
                    }) {
                        Text("立即登录")
                            .font(.headline)
                            .foregroundColor(.white)
                            .frame(width: 120, height: 40)
                            .background(Color.accentColor)
                            .cornerRadius(20)
                    }
                    .buttonStyle(.plain)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .sheet(isPresented: $showLoginSheet) {
            LoginView()
        }
    }
}

/// 乐库分类枚举
enum LibrarySection: String, CaseIterable {
    case myCreatedPlaylists = "创建的歌单"
    case myCollectedPlaylists = "收藏的歌单"
    case myCollectedAlbums = "收藏的专辑"
    
    var icon: String {
        switch self {
        case .myCreatedPlaylists:
            return "music.note"
        case .myCollectedPlaylists:
            return "heart.text.square"
        case .myCollectedAlbums:
            return "opticaldisc"
        }
    }
}

/// 乐库内容视图
struct LibraryContentView: View {
    let section: LibrarySection
    let onPlaylistTapped: ((UserPlaylistResponse.UserPlaylist) -> Void)?
    @State private var playlistService = PlaylistService.shared
    @State private var isRefreshing = false
    
    init(section: LibrarySection, onPlaylistTapped: ((UserPlaylistResponse.UserPlaylist) -> Void)? = nil) {
        self.section = section
        self.onPlaylistTapped = onPlaylistTapped
    }
    
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // 内容标题栏
            HStack {
                Text(section.rawValue)
                    .font(.title)
                    .fontWeight(.semibold)
                
                Spacer()
                
                // 刷新按钮
                Button(action: {
                    if !isRefreshing {
                        Task {
                            isRefreshing = true
                            await refreshContent()
                            isRefreshing = false
                        }
                    }
                }) {
                    if isRefreshing {
                        ProgressView()
                            .controlSize(.small)
                    } else {
                        Image(systemName: "arrow.clockwise")
                            .font(.system(size: 16))
                            .foregroundColor(.secondary)
                    }
                }
                .buttonStyle(.plain)
                .disabled(isRefreshing)
                .help("刷新")
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 16)
            .background(Color(nsColor: .windowBackgroundColor))
            .overlay(alignment: .bottom) {
                Divider()
            }
            
            // 内容区域
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    switch section {
                    case .myCreatedPlaylists:
                        PlaylistsContentView(contentType: .userCreatedPlaylists, onPlaylistTapped: onPlaylistTapped)
                            .padding(.horizontal, 0)
                            .padding(.top, 20)
                    case .myCollectedPlaylists:
                        PlaylistsContentView(contentType: .collectedPlaylists, onPlaylistTapped: onPlaylistTapped)
                            .padding(.horizontal, 0)
                            .padding(.top, 20)
                    case .myCollectedAlbums:
                        PlaylistsContentView(contentType: .collectedAlbums, onPlaylistTapped: onPlaylistTapped)
                            .padding(.horizontal, 0)
                            .padding(.top, 20)
                    }
                }
            }
            .onAppear {
                if playlistService.userCreatedPlaylists.isEmpty && 
                   playlistService.collectedPlaylists.isEmpty && 
                   playlistService.collectedAlbums.isEmpty &&
                   !playlistService.isLoadingMyPlaylists {
                    Task {
                        await loadContent()
                    }
                }
            }
        }
        .background(Color.clear)
    }
    
    private func refreshContent() async {
        await loadContent()
    }
    
    private func loadContent() async {
        switch section {
        case .myCreatedPlaylists, .myCollectedPlaylists, .myCollectedAlbums:
            await playlistService.getAllPlaylistsData()
        }
    }
}

#Preview {
    PlaylistView()
}

// MARK: - 统一的播放列表内容视图

struct PlaylistsContentView: View {
    @State private var playlistService = PlaylistService.shared
    let contentType: LibraryContentType
    let onPlaylistTapped: ((UserPlaylistResponse.UserPlaylist) -> Void)?
    
    init(contentType: LibraryContentType, onPlaylistTapped: ((UserPlaylistResponse.UserPlaylist) -> Void)? = nil) {
        self.contentType = contentType
        self.onPlaylistTapped = onPlaylistTapped
    }
    
    // 将歌单分组，每行4个
    private var chunkedPlaylists: [[UserPlaylistResponse.UserPlaylist]] {
        let itemsPerRow = 4
        return playlistService.getPlaylistsByType(contentType).chunked(into: itemsPerRow)
    }
    
    private var playlists: [UserPlaylistResponse.UserPlaylist] {
        return playlistService.getPlaylistsByType(contentType)
    }
    
    private var emptyStateConfig: (icon: String, title: String, subtitle: String) {
        switch contentType {
        case .userCreatedPlaylists:
            return ("music.note.list", "暂无歌单", "创建您的第一个歌单")
        case .collectedPlaylists:
            return ("heart.text.square", "暂无收藏歌单", "去收藏您喜欢的歌单")
        case .collectedAlbums:
            return ("opticaldisc", "暂无收藏专辑", "去收藏您喜欢的专辑")
        }
    }
    
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            if playlistService.isLoadingMyPlaylists {
                HStack {
                    ProgressView()
                        .controlSize(.small)
                    Text("加载中...")
                        .font(.body)
                        .foregroundColor(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let error = playlistService.myPlaylistsError {
                VStack(spacing: 8) {
                    Image(systemName: "exclamationmark.triangle")
                        .font(.title)
                        .foregroundColor(.orange)
                    Text("加载失败")
                        .font(.headline)
                    Text(error)
                        .font(.caption)
                        .foregroundColor(.secondary)
                        .multilineTextAlignment(.center)
                    Button("重试") {
                        Task {
                            await playlistService.getAllPlaylistsData()
                        }
                    }
                    .buttonStyle(.borderedProminent)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if playlists.isEmpty {
                VStack(spacing: 12) {
                    Image(systemName: emptyStateConfig.icon)
                        .font(.system(size: 48))
                        .foregroundColor(.secondary)
                    Text(emptyStateConfig.title)
                        .font(.headline)
                        .foregroundColor(.secondary)
                    Text(emptyStateConfig.subtitle)
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                // 创建分组的歌单行
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(chunkedPlaylists, id: \.first?.listid) { playlistChunk in
                        HStack(alignment: .top, spacing: 12) {
                            ForEach(playlistChunk, id: \.listid) { playlist in
                                PlaylistCardView(playlist: playlist, onTapped: onPlaylistTapped)
                            }
                            Spacer()
                        }
                    }
                }
                .padding(.horizontal, 16)
            }
        }
    }
}

struct PlaylistCardView: View {
    let playlist: UserPlaylistResponse.UserPlaylist
    let onTapped: ((UserPlaylistResponse.UserPlaylist) -> Void)?
    
    init(playlist: UserPlaylistResponse.UserPlaylist, onTapped: ((UserPlaylistResponse.UserPlaylist) -> Void)? = nil) {
        self.playlist = playlist
        self.onTapped = onTapped
    }
    
    var body: some View {
        Button(action: {
            onTapped?(playlist)
        }) {
            VStack(alignment: .leading, spacing: 8) {
                // 歌单封面
                AsyncImage(url: imageURL) { image in
                    image
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                } placeholder: {
                    Rectangle()
                        .fill(Color.gray.opacity(0.2))
                        .overlay(
                            Image(systemName: "music.note")
                                .foregroundColor(.gray)
                                .font(.system(size: 24))
                        )
                }
                .frame(width: 100, height: 100)
                .clipShape(RoundedRectangle(cornerRadius: 8))
                .padding(.top, 8)
                
                // 歌单信息
                VStack(alignment: .leading, spacing: 3) {
                    Text(playlist.name ?? "未知歌单")
                        .font(.system(size: 14, weight: .medium))
                        .lineLimit(1)
                        .foregroundColor(.primary)
                    
                    Text("\(playlist.count ?? 0) 首歌曲")
                        .font(.system(size: 12))
                        .foregroundColor(.secondary)
                }
                .frame(width: 100, alignment: .leading)
            }
            .frame(width: 116)
            .padding(4)
            .background(Color(NSColor.controlBackgroundColor).opacity(0.5))
            .clipShape(RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain)
    }
    
    private var imageURL: URL? {
        guard let pic = playlist.pic, !pic.isEmpty else {
            // 创建的歌单，不展示封面
            return nil
        }
        return ImageURLHelper.processImageURL(pic, size: .small)
    }
}

// MARK: - Array 扩展

extension Array {
    func chunked(into size: Int) -> [[Element]] {
        return stride(from: 0, to: count, by: size).map {
            Array(self[$0..<Swift.min($0 + size, count)])
        }
    }
}

// MARK: - 歌单详情页

struct PlaylistDetailView: View {
    let playlist: UserPlaylistResponse.UserPlaylist
    let sourceSection: LibrarySection
    let onBack: () -> Void
    @State private var playlistService = PlaylistService.shared
    @State private var playlistDetail: PlaylistDetailInfo?
    @State private var tracks: [PlaylistTrackInfo] = []
    @State private var isLoadingDetail = false
    @State private var isLoadingTracks = false
    @State private var isRefreshing = false
    @State private var errorMessage: String?
    @EnvironmentObject private var playerService: PlayerService
    
    init(playlist: UserPlaylistResponse.UserPlaylist, sourceSection: LibrarySection, onBack: @escaping () -> Void) {
        self.playlist = playlist
        self.sourceSection = sourceSection
        self.onBack = onBack
    }
    
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // 标题栏
            HStack {
                Text(sourceSection.rawValue)
                    .font(.largeTitle)
                    .fontWeight(.bold)
                
                Spacer()
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 16)
            .background(Color(NSColor.windowBackgroundColor))
            .overlay(alignment: .bottom) {
                Divider()
            }
            
            if let detail = playlistDetail {
                // 歌单头部信息
                playlistHeader(detail: detail)
                
                Divider()
                
                // 歌曲列表 - 使用通用的SongListView组件
                SongListView(
                    tracks: tracks,
                    title: "歌曲列表",
                    isLoading: isLoadingTracks,
                    errorMessage: errorMessage
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
    
    @ViewBuilder
    private func playlistHeader(detail: PlaylistDetailInfo) -> some View {
        HStack(alignment: .top, spacing: 20) {
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
}