//
//  SearchResultsView.swift
//  EchoMusic
//
//  Created on 2025/8/20.
//

import SwiftUI

// 搜索结果页面
struct SearchResultsView: View {
    let keyword: String
    @State private var searchResults: SearchResult?
    @State private var isLoading = false
    @State private var errorMessage = ""
    @State private var selectedTab: SearchType = .song
    @State private var currentPage = 1
    @State private var hasMorePages = true
    
    private let searchService = SearchService.shared
    private let playerService = PlayerService.shared
    
    var body: some View {
        VStack(spacing: 0) {
            // 搜索关键词显示
            HStack {
                Text("搜索: \(keyword)")
                    .font(.system(size: 14, weight: .medium))
                    .foregroundColor(.primary)
                
                Spacer()
                
                if isLoading {
                    ProgressView()
                        .scaleEffect(0.8)
                }
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 12)
            .background(Color(NSColor.controlBackgroundColor))
            
            // 搜索类型选择器
            Picker("搜索类型", selection: $selectedTab) {
                ForEach(SearchType.allCases, id: \.self) { type in
                    Text(type.displayName).tag(type)
                }
            }
            .pickerStyle(SegmentedPickerStyle())
            .padding(.horizontal, 20)
            .padding(.vertical, 8)
            
            // 搜索结果内容
            if let data = searchResults?.data {
                searchResultsContent(data)
            } else if isLoading {
                loadingView
            } else if !errorMessage.isEmpty {
                errorView
            } else {
                emptyView
            }
            
            Spacer()
        }
        .onAppear {
            performSearch()
        }
        .onChange(of: selectedTab) { _ in
            currentPage = 1
            hasMorePages = true
            performSearch()
        }
    }
    
    // MARK: - 搜索结果内容
    @ViewBuilder
    private func searchResultsContent(_ data: SearchData) -> some View {
        VStack(spacing: 0) {
            ScrollView {
                LazyVStack(spacing: 16) {
                    switch selectedTab {
                    case .song:
                        if let songs = data.songs, !songs.isEmpty {
                            songsSection(songs)
                        } else {
                            emptyResultsView("没有找到相关单曲")
                        }
                    case .artist:
                        if let artists = data.artists, !artists.isEmpty {
                            artistsSection(artists)
                        } else {
                            emptyResultsView("没有找到相关歌手")
                        }
                    case .playlist:
                        if let playlists = data.playlists, !playlists.isEmpty {
                            playlistsSection(playlists)
                        } else {
                            emptyResultsView("没有找到相关歌单")
                        }
                    case .album:
                        if let albums = data.albums, !albums.isEmpty {
                            albumsSection(albums)
                        } else {
                            emptyResultsView("没有找到相关专辑")
                        }
                    case .mv:
                        if let mvs = data.mvs, !mvs.isEmpty {
                            mvsSection(mvs)
                        } else {
                            emptyResultsView("没有找到相关MV")
                        }
                    case .lyric:
                        lyricSection()
                    }
                    
                    // 加载更多按钮
                    if hasMorePages && (currentPage > 1 || (data.total ?? 0) > 30) {
                        loadMoreButton
                    }
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 16)
            }
        }
    }
    
    // MARK: - 加载更多按钮
    private var loadMoreButton: some View {
        Button(action: loadMoreResults) {
            HStack {
                if isLoading {
                    ProgressView()
                        .scaleEffect(0.8)
                        .padding(.trailing, 8)
                }
                Text(isLoading ? "加载中..." : "加载更多")
                    .font(.system(size: 14))
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 12)
            .background(Color.gray.opacity(0.1))
            .cornerRadius(8)
        }
        .buttonStyle(PlainButtonStyle())
        .disabled(isLoading)
    }
    
    // MARK: - 单曲部分
    private func songsSection(_ songs: [Song]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(songs, id: \.id) { song in
                SongRowView(song: song) {
                    playerService.playSong(song)
                }
            }
        }
    }
    
    // MARK: - 歌手部分
    private func artistsSection(_ artists: [Artist]) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(artists, id: \.id) { artist in
                ArtistRowView(artist: artist)
            }
        }
    }
    
    // MARK: - 歌单部分
    private func playlistsSection(_ playlists: [Playlist]) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(playlists, id: \.id) { playlist in
                PlaylistRowView(playlist: playlist)
            }
        }
    }
    
    // MARK: - 专辑部分
    private func albumsSection(_ albums: [Album]) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(albums, id: \.id) { album in
                AlbumRowView(album: album)
            }
        }
    }
    
    // MARK: - MV部分
    private func mvsSection(_ mvs: [MV]) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(mvs, id: \.id) { mv in
                MVRowView(mv: mv)
            }
        }
    }
    
    // MARK: - 歌词部分
    private func lyricSection() -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("歌词搜索功能开发中...")
                .font(.system(size: 14))
                .foregroundColor(.secondary)
        }
    }
    
    // MARK: - 加载视图
    private var loadingView: some View {
        VStack {
            ProgressView()
                .scaleEffect(1.2)
            Text("正在搜索...")
                .font(.system(size: 14))
                .foregroundColor(.secondary)
                .padding(.top, 8)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
    
    // MARK: - 错误视图
    private var errorView: some View {
        VStack {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 48))
                .foregroundColor(.orange)
            Text("搜索失败")
                .font(.system(size: 16, weight: .medium))
                .foregroundColor(.primary)
                .padding(.top, 8)
            Text(errorMessage)
                .font(.system(size: 14))
                .foregroundColor(.secondary)
                .padding(.top, 4)
            Button("重试") {
                performSearch()
            }
            .buttonStyle(.bordered)
            .padding(.top, 12)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
    
    // MARK: - 空视图
    private var emptyView: some View {
        VStack {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 48))
                .foregroundColor(.secondary)
            Text("输入关键词开始搜索")
                .font(.system(size: 16))
                .foregroundColor(.secondary)
                .padding(.top, 8)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
    
    // MARK: - 空结果视图
    private func emptyResultsView(_ message: String) -> some View {
        VStack {
            Image(systemName: "doc.text")
                .font(.system(size: 32))
                .foregroundColor(.secondary)
            Text(message)
                .font(.system(size: 14))
                .foregroundColor(.secondary)
                .padding(.top, 8)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 40)
    }
    
    // MARK: - 方法
    private func performSearch() {
        guard !keyword.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        
        currentPage = 1
        hasMorePages = true
        isLoading = true
        errorMessage = ""
        
        Task {
            do {
                let result = try await searchService.search(keyword: keyword, type: selectedTab, page: currentPage)
                await MainActor.run {
                    searchResults = result
                    isLoading = false
                    updatePaginationInfo(result.data)
                }
            } catch {
                await MainActor.run {
                    errorMessage = error.localizedDescription
                    isLoading = false
                }
            }
        }
    }
    
    private func loadMoreResults() {
        guard !isLoading && hasMorePages else { return }
        
        isLoading = true
        currentPage += 1
        
        Task {
            do {
                let result = try await searchService.search(keyword: keyword, type: selectedTab, page: currentPage)
                await MainActor.run {
                    // 合并结果
                    if let newResult = result.data, let existingResult = searchResults?.data {
                        let mergedLists = (existingResult.lists ?? []) + (newResult.lists ?? [])
                        searchResults?.data?.lists = mergedLists
                        searchResults?.data?.total = newResult.total
                    }
                    isLoading = false
                    updatePaginationInfo(result.data)
                }
            } catch {
                await MainActor.run {
                    errorMessage = error.localizedDescription
                    isLoading = false
                    currentPage -= 1 // 回退页码
                }
            }
        }
    }
    
    private func updatePaginationInfo(_ data: SearchData?) {
        guard let data = data else {
            hasMorePages = false
            return
        }
        
        let pageSize = 30
        let totalItems = data.total ?? 0
        let currentItems = (data.lists ?? []).count
        
        hasMorePages = currentItems < totalItems && currentItems >= pageSize
    }
}

// MARK: - 歌曲行视图
struct SongRowView: View {
    let song: Song
    let onPlay: () -> Void
    
    var body: some View {
        HStack(spacing: 12) {
            // 专辑封面
            AsyncImage(url: URL(string: song.cover ?? "")) { image in
                image
                    .resizable()
                    .aspectRatio(contentMode: .fill)
            } placeholder: {
                Rectangle()
                    .fill(Color.gray.opacity(0.3))
                    .overlay(
                        Image(systemName: "music.note")
                            .foregroundColor(.secondary)
                    )
            }
            .frame(width: 40, height: 40)
            .cornerRadius(4)
            
            // 歌曲信息
            VStack(alignment: .leading, spacing: 4) {
                Text(song.title ?? "")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(.primary)
                    .lineLimit(1)
                
                Text(song.artist ?? "")
                    .font(.system(size: 11))
                    .foregroundColor(.secondary)
                    .lineLimit(1)
            }
            
            Spacer()
            
            // 播放按钮
            Button(action: onPlay) {
                Image(systemName: "play.circle.fill")
                    .foregroundColor(.blue)
                    .font(.system(size: 20))
            }
            .buttonStyle(PlainButtonStyle())
            .help("播放")
        }
        .padding(.vertical, 8)
        .contentShape(Rectangle())
        .onHover { isHovered in
            if isHovered {
                Color.gray.opacity(0.1)
            } else {
                Color.clear
            }
        }
    }
}

// MARK: - 歌手行视图
struct ArtistRowView: View {
    let artist: Artist
    
    var body: some View {
        HStack(spacing: 12) {
            // 歌手头像
            AsyncImage(url: URL(string: artist.cover ?? "")) { image in
                image
                    .resizable()
                    .aspectRatio(contentMode: .fill)
            } placeholder: {
                Circle()
                    .fill(Color.gray.opacity(0.3))
                    .overlay(
                        Image(systemName: "person.fill")
                            .foregroundColor(.secondary)
                    )
            }
            .frame(width: 40, height: 40)
            .clipShape(Circle())
            
            // 歌手信息
            VStack(alignment: .leading, spacing: 4) {
                Text(artist.name ?? "")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(.primary)
                    .lineLimit(1)
                
                if let albumSize = artist.albumSize, let musicSize = artist.musicSize {
                    Text("专辑: \(albumSize) | 歌曲: \(musicSize)")
                        .font(.system(size: 11))
                        .foregroundColor(.secondary)
                        .lineLimit(1)
                }
            }
            
            Spacer()
            
            // 粉丝数
            if let fansSize = artist.fansSize {
                Text("\(fansSize) 粉丝")
                    .font(.system(size: 11))
                    .foregroundColor(.secondary)
            }
        }
        .padding(.vertical, 8)
        .contentShape(Rectangle())
        .onHover { isHovered in
            if isHovered {
                Color.gray.opacity(0.1)
            } else {
                Color.clear
            }
        }
    }
}

// MARK: - 歌单行视图
struct PlaylistRowView: View {
    let playlist: Playlist
    
    var body: some View {
        HStack(spacing: 12) {
            // 歌单封面
            AsyncImage(url: URL(string: playlist.coverImgUrl ?? "")) { image in
                image
                    .resizable()
                    .aspectRatio(contentMode: .fill)
            } placeholder: {
                Rectangle()
                    .fill(Color.gray.opacity(0.3))
                    .overlay(
                        Image(systemName: "list.bullet")
                            .foregroundColor(.secondary)
                    )
            }
            .frame(width: 40, height: 40)
            .cornerRadius(4)
            
            // 歌单信息
            VStack(alignment: .leading, spacing: 4) {
                Text(playlist.name ?? "")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(.primary)
                    .lineLimit(1)
                
                HStack {
                    if let creator = playlist.creator {
                        Text(creator.nickname ?? "")
                            .font(.system(size: 11))
                            .foregroundColor(.secondary)
                            .lineLimit(1)
                        
                        Text("•")
                            .font(.system(size: 11))
                            .foregroundColor(.secondary)
                    }
                    
                    if let trackCount = playlist.trackCount {
                        Text("\(trackCount) 首")
                            .font(.system(size: 11))
                            .foregroundColor(.secondary)
                            .lineLimit(1)
                    }
                    
                    if let playCount = playlist.playCount {
                        Text("•")
                            .font(.system(size: 11))
                            .foregroundColor(.secondary)
                        
                        Text("\(playCount) 播放")
                            .font(.system(size: 11))
                            .foregroundColor(.secondary)
                            .lineLimit(1)
                    }
                }
            }
            
            Spacer()
        }
        .padding(.vertical, 8)
        .contentShape(Rectangle())
        .onHover { isHovered in
            if isHovered {
                Color.gray.opacity(0.1)
            } else {
                Color.clear
            }
        }
    }
}

// MARK: - MV行视图
struct MVRowView: View {
    let mv: MV
    
    var body: some View {
        HStack(spacing: 12) {
            // MV封面
            AsyncImage(url: URL(string: mv.cover ?? "")) { image in
                image
                    .resizable()
                    .aspectRatio(contentMode: .fill)
            } placeholder: {
                Rectangle()
                    .fill(Color.gray.opacity(0.3))
                    .overlay(
                        Image(systemName: "video.fill")
                            .foregroundColor(.secondary)
                    )
            }
            .frame(width: 60, height: 40)
            .cornerRadius(4)
            
            // MV信息
            VStack(alignment: .leading, spacing: 4) {
                Text(mv.name ?? "")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(.primary)
                    .lineLimit(1)
                
                HStack {
                    Text(mv.artistName ?? "")
                        .font(.system(size: 11))
                        .foregroundColor(.secondary)
                        .lineLimit(1)
                    
                    if let duration = mv.duration {
                        Text("•")
                            .font(.system(size: 11))
                            .foregroundColor(.secondary)
                        
                        Text(formatDuration(duration))
                            .font(.system(size: 11))
                            .foregroundColor(.secondary)
                            .lineLimit(1)
                    }
                    
                    if let playCount = mv.playCount {
                        Text("•")
                            .font(.system(size: 11))
                            .foregroundColor(.secondary)
                        
                        Text("\(formatPlayCount(playCount)) 播放")
                            .font(.system(size: 11))
                            .foregroundColor(.secondary)
                            .lineLimit(1)
                    }
                }
            }
            
            Spacer()
            
            // 播放按钮
            Button(action: {
                // TODO: 播放MV
            }) {
                Image(systemName: "play.circle.fill")
                    .foregroundColor(.blue)
                    .font(.system(size: 20))
            }
            .buttonStyle(PlainButtonStyle())
            .help("播放MV")
        }
        .padding(.vertical, 8)
        .contentShape(Rectangle())
        .onHover { isHovered in
            if isHovered {
                Color.gray.opacity(0.1)
            } else {
                Color.clear
            }
        }
    }
    
    private func formatDuration(_ duration: Int) -> String {
        let minutes = duration / 60
        let seconds = duration % 60
        return String(format: "%d:%02d", minutes, seconds)
    }
    
    private func formatPlayCount(_ count: Int) -> String {
        if count >= 10000 {
            return String(format: "%.1f万", Double(count) / 10000)
        } else if count >= 1000 {
            return String(format: "%.1fk", Double(count) / 1000)
        } else {
            return "\(count)"
        }
    }
}

// MARK: - 专辑行视图
struct AlbumRowView: View {
    let album: Album
    
    var body: some View {
        HStack(spacing: 12) {
            // 专辑封面
            AsyncImage(url: URL(string: album.cover ?? "")) { image in
                image
                    .resizable()
                    .aspectRatio(contentMode: .fill)
            } placeholder: {
                Rectangle()
                    .fill(Color.gray.opacity(0.3))
                    .overlay(
                        Image(systemName: "square.stack")
                            .foregroundColor(.secondary)
                    )
            }
            .frame(width: 40, height: 40)
            .cornerRadius(4)
            
            // 专辑信息
            VStack(alignment: .leading, spacing: 4) {
                Text(album.name ?? "")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(.primary)
                    .lineLimit(1)
                
                HStack {
                    if let artist = album.artist {
                        Text(artist.name ?? "")
                            .font(.system(size: 11))
                            .foregroundColor(.secondary)
                            .lineLimit(1)
                        
                        Text("•")
                            .font(.system(size: 11))
                            .foregroundColor(.secondary)
                    }
                    
                    if let size = album.size {
                        Text("\(size) 首")
                            .font(.system(size: 11))
                            .foregroundColor(.secondary)
                            .lineLimit(1)
                    }
                    
                    if let publishTime = album.publishTime {
                        Text("•")
                            .font(.system(size: 11))
                            .foregroundColor(.secondary)
                        
                        Text(Date(timeIntervalSince1970: TimeInterval(publishTime / 1000)), style: .date)
                            .font(.system(size: 11))
                            .foregroundColor(.secondary)
                            .lineLimit(1)
                    }
                }
            }
            
            Spacer()
        }
        .padding(.vertical, 8)
        .contentShape(Rectangle())
        .onHover { isHovered in
            if isHovered {
                Color.gray.opacity(0.1)
            } else {
                Color.clear
            }
        }
    }
}