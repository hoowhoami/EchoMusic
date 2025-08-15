//
//  CloudMusicView.swift
//  EchoMusic
//
//  Created by AI Assistant on 2025/8/15.
//

import SwiftUI

/// 云盘音乐视图
struct CloudMusicView: View {
    @EnvironmentObject private var userService: UserService
    @State private var tracks: [PlaylistTrackInfo] = []
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var isRefreshing = false
    
    var body: some View {
        Group {
            if userService.isLoggedIn {
                VStack(alignment: .leading, spacing: 0) {
                    // 统计信息头部
                    headerView
                    
                    Divider()
                    
                    // 歌曲列表
                    SongListView(
                        tracks: tracks,
                        title: "云盘歌曲",
                        isLoading: isLoading,
                        errorMessage: errorMessage
                    )
                }
                .onAppear {
                    Task {
                        await loadCloudMusic()
                    }
                }
                .onReceive(NotificationCenter.default.publisher(for: NSNotification.Name("RefreshCurrentContent"))) { _ in
                    Task {
                        await loadCloudMusic()
                        // 发送刷新完成通知
                        NotificationCenter.default.post(
                            name: NSNotification.Name("RefreshCompleted"),
                            object: nil
                        )
                    }
                }
            } else {
                UnauthorizedView(
                    title: "需要登录才能查看云盘音乐",
                    description: "登录后您可以上传音乐文件到云端，随时随地收听",
                    iconName: "icloud.fill",
                    iconColor: .blue
                )
            }
        }
    }
    
    @ViewBuilder
    private var headerView: some View {
        HStack(alignment: .top, spacing: 20) {
            // 封面
            VStack(spacing: 12) {
                Image(systemName: "icloud.fill")
                    .font(.system(size: 64))
                    .foregroundColor(.blue)
                
                Text("云盘音乐")
                    .font(.title)
                    .fontWeight(.bold)
            }
            .frame(width: 160)
            
            // 统计信息和操作
            VStack(alignment: .leading, spacing: 8) {
                Text("共 \(tracks.count) 首歌曲")
                    .font(.title2)
                    .fontWeight(.semibold)
                
                Text("上传您的音乐文件，随时随地收听")
                    .font(.body)
                    .foregroundColor(.secondary)
                    .lineLimit(2)
                
                HStack(spacing: 12) {
                    Button(action: {
                        // TODO: 实现上传功能
                    }) {
                        HStack(spacing: 8) {
                            Image(systemName: "plus")
                            Text("上传音乐")
                        }
                        .font(.headline)
                        .foregroundColor(.white)
                        .padding(.horizontal, 20)
                        .padding(.vertical, 10)
                        .background(Color.accentColor)
                        .cornerRadius(10)
                    }
                    .buttonStyle(.plain)
                    
                    Button(action: {
                        let songs = tracks.map { Song(from: $0) }
                        PlayerService.shared.playAllSongs(songs)
                    }) {
                        HStack(spacing: 8) {
                            Image(systemName: "play.fill")
                            Text("播放全部")
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
                }
                .offset(y: -2)
            }
            
            Spacer()
        }
        .padding(.all, 20)
    }
    
    private func loadCloudMusic() async {
        guard userService.isLoggedIn else {
            return
        }
        
        await MainActor.run {
            isLoading = true
            errorMessage = nil
        }
        
        do {
            // TODO: 实现获取云盘音乐的API调用
            // 这里先模拟一些数据
            await MainActor.run {
                // 模拟数据
                self.tracks = []
                self.isLoading = false
            }
            
            // 模拟网络延迟
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            
        } catch {
            await MainActor.run {
                self.errorMessage = error.localizedDescription
                self.isLoading = false
            }
        }
    }
}

#Preview {
    CloudMusicView()
        .frame(width: 800, height: 600)
        .environmentObject(UserService.shared)
        .environmentObject(PlayerService.shared)
}