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
    @State private var songResults: SearchSongResult?
    @State private var albumResults: SearchAlbumResult?
    @State private var artistResults: SearchArtistResult?
    @State private var playlistResults: SearchPlaylistResult?
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
                        .frame(width: 14, height: 14)
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
            Group {
                switch selectedTab {
                case .song:
                    if let data = songResults?.data {
                        searchSongResultsContent(data)
                    } else if isLoading {
                        loadingView
                    } else if !errorMessage.isEmpty {
                        errorView
                    } else {
                        emptyView
                    }
                case .album:
                    if let data = albumResults?.data {
                        searchAlbumResultsContent(data)
                    } else if isLoading {
                        loadingView
                    } else if !errorMessage.isEmpty {
                        errorView
                    } else {
                        emptyView
                    }
                case .artist:
                    if let data = artistResults?.data {
                        searchArtistResultsContent(data)
                    } else if isLoading {
                        loadingView
                    } else if !errorMessage.isEmpty {
                        errorView
                    } else {
                        emptyView
                    }
                case .playlist:
                    if let data = playlistResults?.data {
                        searchPlaylistResultsContent(data)
                    } else if isLoading {
                        loadingView
                    } else if !errorMessage.isEmpty {
                        errorView
                    } else {
                        emptyView
                    }
                }
            }
            .onAppear {
                if let data = songResults?.data {
                    print("SearchResultsView: 显示搜索结果数据")
                } else if isLoading {
                    print("SearchResultsView: 显示加载状态")
                } else if !errorMessage.isEmpty {
                    print("SearchResultsView: 显示错误状态: \(errorMessage)")
                } else {
                    print("SearchResultsView: 显示空状态")
                }
            }
            
            Spacer()
        }
        .onAppear {
            print("SearchResultsView: 视图出现，关键词: \(keyword)")
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
    private func searchSongResultsContent(_ data: SearchSongData) -> some View {
        let songs = data.lists?.map { $0.toSong() }
        songsSection(songs ?? [], total: data.total)
    }
    
    @ViewBuilder
    private func searchAlbumResultsContent(_ data: SearchAlbumData) -> some View {
        searchResultsContent(data.lists, data.total, "专辑")
    }
    
    @ViewBuilder
    private func searchArtistResultsContent(_ data: SearchArtistData) -> some View {
        searchResultsContent(data.lists, data.total, "歌手")
    }
    
    @ViewBuilder
    private func searchPlaylistResultsContent(_ data: SearchPlaylistData) -> some View {
        searchResultsContent(data.lists, data.total, "歌单")
    }
    
    @ViewBuilder
    private func searchResultsContent<T: Identifiable>(_ items: [T]?, _ total: Int?, _ type: String) -> some View {
        VStack(spacing: 0) {
            ScrollView {
                LazyVStack(spacing: 16) {
                    if let items = items, !items.isEmpty {
                        switch selectedTab {
                        case .artist:
                            if let artists = items as? [Artist] {
                                artistsSection(artists)
                            }
                        case .playlist:
                            if let playlists = items as? [Playlist] {
                                playlistsSection(playlists)
                            }
                        case .album:
                            if let albums = items as? [Album] {
                                albumsSection(albums)
                            }
                        default:
                            EmptyView()
                        }
                    } else {
                        emptyResultsView("没有找到相关\(type)")
                    }
                    
                    // 加载更多按钮
                    if hasMorePages && (currentPage > 1 || (total ?? 0) > 30) {
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
    private func songsSection(_ songs: [Song], total: Int?) -> some View {
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
        
        print("SearchResultsView: 开始搜索关键词: \(keyword)")
        currentPage = 1
        hasMorePages = true
        isLoading = true
        errorMessage = ""
        
        // 清除其他标签页的结果
        songResults = nil
        albumResults = nil
        artistResults = nil
        playlistResults = nil
        
        Task {
            do {
                switch selectedTab {
                case .song:
                    let result = try await searchService.searchSong(keyword: keyword, page: currentPage)
                    print("SearchResultsView: 歌曲搜索成功")
                    await MainActor.run {
                        songResults = result
                        isLoading = false
                        hasMorePages = (result.data?.total ?? 0) > currentPage * 30
                    }
                case .album:
                    let result = try await searchService.searchAlbum(keyword: keyword, page: currentPage)
                    print("SearchResultsView: 专辑搜索成功")
                    await MainActor.run {
                        albumResults = result
                        isLoading = false
                        hasMorePages = (result.data?.total ?? 0) > currentPage * 30
                    }
                case .artist:
                    let result = try await searchService.searchArtist(keyword: keyword, page: currentPage)
                    print("SearchResultsView: 歌手搜索成功")
                    await MainActor.run {
                        artistResults = result
                        isLoading = false
                        hasMorePages = (result.data?.total ?? 0) > currentPage * 30
                    }
                case .playlist:
                    let result = try await searchService.searchPlaylist(keyword: keyword, page: currentPage)
                    print("SearchResultsView: 歌单搜索成功")
                    await MainActor.run {
                        playlistResults = result
                        isLoading = false
                        hasMorePages = (result.data?.total ?? 0) > currentPage * 30
                    }
                }
            } catch {
                print("SearchResultsView: 搜索失败: \(error)")
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
                switch selectedTab {
                case .song:
                    let result = try await searchService.searchSong(keyword: keyword, page: currentPage)
                    await MainActor.run {
                        // 合并结果
                        if let newItems = result.data?.lists, var existingData = songResults?.data {
                            existingData.lists = (existingData.lists ?? []) + newItems
                            songResults?.data = existingData
                        }
                        isLoading = false
                        hasMorePages = (result.data?.total ?? 0) > currentPage * 30
                    }
                case .album:
                    let result = try await searchService.searchAlbum(keyword: keyword, page: currentPage)
                    await MainActor.run {
                        // 合并结果
                        if let newItems = result.data?.lists, var existingData = albumResults?.data {
                            existingData.lists = (existingData.lists ?? []) + newItems
                            albumResults?.data = existingData
                        }
                        isLoading = false
                        hasMorePages = (result.data?.total ?? 0) > currentPage * 30
                    }
                case .artist:
                    let result = try await searchService.searchArtist(keyword: keyword, page: currentPage)
                    await MainActor.run {
                        // 合并结果
                        if let newItems = result.data?.lists, var existingData = artistResults?.data {
                            existingData.lists = (existingData.lists ?? []) + newItems
                            artistResults?.data = existingData
                        }
                        isLoading = false
                        hasMorePages = (result.data?.total ?? 0) > currentPage * 30
                    }
                case .playlist:
                    let result = try await searchService.searchPlaylist(keyword: keyword, page: currentPage)
                    await MainActor.run {
                        // 合并结果
                        if let newItems = result.data?.lists, var existingData = playlistResults?.data {
                            existingData.lists = (existingData.lists ?? []) + newItems
                            playlistResults?.data = existingData
                        }
                        isLoading = false
                        hasMorePages = (result.data?.total ?? 0) > currentPage * 30
                    }
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
                
                // 显示歌手信息
                HStack(spacing: 8) {
                    if let albumSize = artist.albumSize {
                        Text("专辑: \(albumSize)")
                            .font(.system(size: 11))
                            .foregroundColor(.secondary)
                    }
                    
                    if let musicSize = artist.musicSize {
                        Text("歌曲: \(musicSize)")
                            .font(.system(size: 11))
                            .foregroundColor(.secondary)
                    }
                    
                    if let fansSize = artist.fansSize {
                        Text("粉丝: \(fansSize)")
                            .font(.system(size: 11))
                            .foregroundColor(.secondary)
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
