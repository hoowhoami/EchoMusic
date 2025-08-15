//
//  ContentView.swift
//  EchoMusic
//
//  Created on 2025/8/4.
//

import SwiftUI

struct ContentView: View {
    let selectedItem: NavigationItemType
    @State private var selectedPlaylist: UserPlaylistResponse.UserPlaylist?
    @State private var selectedPlaylistType: PlaylistType?
    
    var body: some View {
        Group {
            switch selectedItem {
            case .home:
                HomeView()
            case .discover:
                DiscoverView()
            case .favoriteMusic:
                FavoriteMusicView()
            case .myCloud:
                CloudMusicView()
            case .recentPlay:
                RecentMusicView()
            case .playlists:
                playlistContentView
            case .userProfile:
                UserProfileView()
            case .videos:
                // TODO: 实现视频页面
                VStack {
                    Image(systemName: "play.rectangle.fill")
                        .font(.system(size: 64))
                        .foregroundColor(.secondary)
                    Text("视频功能正在开发中")
                        .font(.title2)
                        .foregroundColor(.secondary)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(20)
        .onReceive(NotificationCenter.default.publisher(for: NSNotification.Name("PlaylistSelected"))) { notification in
            // 监听歌单选择通知
            if let playlist = notification.userInfo?["playlist"] as? UserPlaylistResponse.UserPlaylist,
               let playlistType = notification.userInfo?["playlistType"] as? PlaylistType {
                // 先清空状态，然后设置新的歌单，确保视图刷新
                selectedPlaylist = nil
                selectedPlaylistType = nil
                
                DispatchQueue.main.async {
                    selectedPlaylist = playlist
                    selectedPlaylistType = playlistType
                }
            }
        }
    }
    
    /// 歌单内容视图
    @ViewBuilder
    private var playlistContentView: some View {
        if let playlist = selectedPlaylist, let playlistType = selectedPlaylistType {
            // 显示选中的歌单详情
            PlaylistDetailView(
                playlist: playlist,
                sourceSection: playlistTypeToLibrarySection(playlistType),
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
                    // .foregroundColor(.tertiary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
    
    /// 将PlaylistType转换为LibrarySection
    private func playlistTypeToLibrarySection(_ playlistType: PlaylistType) -> LibrarySection {
        switch playlistType {
        case .created:
            return .myCreatedPlaylists
        case .collected:
            return .myCollectedPlaylists
        case .albums:
            return .myCollectedAlbums
        }
    }
}

#Preview {
    ContentView(selectedItem: .home)
}
