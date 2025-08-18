//
//  PlaylistService.swift
//  EchoMusic
//
//  Created by AI Assistant on 2025/8/6.
//
import SwiftUI
import Foundation

/// 歌单服务 - 负责歌单相关的所有业务逻辑
class PlaylistService: ObservableObject {
    static let shared = PlaylistService()
    private let userService = UserService.shared
    
    // MARK: - 我的歌单相关 (重构后的通用方法)
    
    /// 用户创建的歌单列表
    @Published
    var userCreatedPlaylists: [UserPlaylistResponse.UserPlaylist] = []
    
    /// 收藏的歌单列表  
    @Published
    var collectedPlaylists: [UserPlaylistResponse.UserPlaylist] = []
    
    /// 收藏的专辑列表
    @Published
    var collectedAlbums: [UserPlaylistResponse.UserPlaylist] = []
    
    /// 原始歌单数据（用于分类）
    private var rawPlaylistData: [UserPlaylistResponse.UserPlaylist] = []
    
    /// 我的歌单加载状态
    @Published
    var isLoadingMyPlaylists = false
    
    /// 我的歌单错误信息
    @Published
    var myPlaylistsError: String?
    
    /// 存储"我喜欢"歌单的ID
    @Published
    var likedPlaylistId: String?
    
    private init() {}
    
    
    // MARK: - 我的歌单方法 (重构后的通用方法)
    
    /// 获取所有歌单数据并分类
    func getAllPlaylistsData() async {
        guard userService.isLoggedIn else {
            await MainActor.run {
                myPlaylistsError = "用户未登录"
            }
            return
        }
        
        await MainActor.run {
            isLoadingMyPlaylists = true
            myPlaylistsError = nil
        }
        
        do {
            let playlistData = try await getUserPlaylists()
            let allPlaylists = playlistData.info ?? []
            
            // 获取当前用户ID
            let currentUserId = userService.currentUser?.userid
            
            // 分类处理播放列表数据
            let categorizedData = categorizePlaylistData(allPlaylists, currentUserId: currentUserId)
            
            await MainActor.run {
                self.rawPlaylistData = allPlaylists
                self.userCreatedPlaylists = categorizedData.userCreated
                self.collectedPlaylists = categorizedData.collected
                self.collectedAlbums = categorizedData.albums
                self.likedPlaylistId = categorizedData.likedPlaylistId
                self.isLoadingMyPlaylists = false
            }
        } catch {
            await MainActor.run {
                self.myPlaylistsError = error.localizedDescription
                self.isLoadingMyPlaylists = false
                self.userCreatedPlaylists = []
                self.collectedPlaylists = []
                self.collectedAlbums = []
            }
        }
    }
    
    /// 获取指定类型的歌单数据
    func getPlaylistsByType(_ contentType: LibraryContentType) -> [UserPlaylistResponse.UserPlaylist] {
        switch contentType {
        case .userCreatedPlaylists:
            return userCreatedPlaylists
        case .collectedPlaylists:
            return collectedPlaylists
        case .collectedAlbums:
            return collectedAlbums
        }
    }
    
    /// 刷新歌单数据
    func refreshPlaylists() async {
        await getAllPlaylistsData()
    }
    
    /// 分类处理播放列表数据
    private func categorizePlaylistData(_ playlists: [UserPlaylistResponse.UserPlaylist], currentUserId: Int?) -> (userCreated: [UserPlaylistResponse.UserPlaylist], collected: [UserPlaylistResponse.UserPlaylist], albums: [UserPlaylistResponse.UserPlaylist], likedPlaylistId: String?) {
        
        var likedPlaylistId: String?
        
        // 首先过滤掉已删除的歌单 (is_del = 1)
        let activePlaylists = playlists.filter { $0.is_del != 1 }
        
        // 根据JavaScript逻辑进行分类
        let userCreatedFilter = PlaylistFilter(contentType: .userCreatedPlaylists, currentUserId: currentUserId)
        let collectedFilter = PlaylistFilter(contentType: .collectedPlaylists, currentUserId: currentUserId)
        let albumsFilter = PlaylistFilter(contentType: .collectedAlbums, currentUserId: currentUserId)
        
        // 过滤我创建的歌单
        let userCreated = activePlaylists.filter { playlist in
            let matches = userCreatedFilter.matches(playlist)
            
            // 保存"我喜欢"歌单的ID (类似JavaScript中的localStorage.setItem)
            if playlist.name == "我喜欢", let listid = playlist.listid {
                likedPlaylistId = String(listid)
            }
            
            return matches
        }.sorted { a, b in
            // "我喜欢"歌单排在第一位（类似JavaScript中的sort逻辑）
            return a.name == "我喜欢" ? true : (b.name == "我喜欢" ? false : false)
        }
        
        // 过滤收藏的歌单
        let collected = activePlaylists.filter { playlist in
            return collectedFilter.matches(playlist)
        }
        
        // 过滤收藏的专辑
        let albums = activePlaylists.filter { playlist in
            return albumsFilter.matches(playlist)
        }
        
        return (userCreated, collected, albums, likedPlaylistId)
    }
    
    /// 获取我创建的歌单（保持向后兼容）
    @available(*, deprecated, message: "使用 getAllPlaylistsData() 和 userCreatedPlaylists 替代")
    func getMyPlaylists() async {
        await getAllPlaylistsData()
    }
    
    /// 获取用户歌单
    private func getUserPlaylists() async throws -> UserPlaylistResponse.UserPlaylistData {
        do {
            let response: UserPlaylistResponse = try await NetworkService.shared.get(
                endpoint: "/user/playlist",
                responseType: UserPlaylistResponse.self
            )
            
            if response.status == 1, let data = response.data {
                return data
            } else {
                throw UserServiceError.serverError(response.error_code, "获取用户歌单失败")
            }
        } catch let error as NetworkError {
            throw UserServiceError.networkError(error.localizedDescription)
        } catch let error as UserServiceError {
            throw error
        } catch {
            throw UserServiceError.unknownError
        }
    }
    
    
    // MARK: - 歌单详情方法
    
    /// 获取歌单详情
    func getPlaylistDetail(globalCollectionId: String) async throws -> PlaylistDetailInfo? {
        do {
            let params = ["ids": globalCollectionId]
            
            let response: PlaylistDetailResponse = try await NetworkService.shared.get(
                endpoint: "/playlist/detail",
                params: params,
                responseType: PlaylistDetailResponse.self
            )
            
            if response.status == 1, let data = response.data, let info = data.first {
                return info
            } else {
                throw UserServiceError.serverError(response.error_code, "获取歌单详情失败")
            }
        } catch let error as NetworkError {
            throw UserServiceError.networkError(error.localizedDescription)
        } catch let error as UserServiceError {
            throw error
        } catch {
            throw UserServiceError.unknownError
        }
    }
    
    /// 获取歌单所有歌曲
    func getPlaylistTracks(globalCollectionId: String, page: Int = 1, pageSize: Int = 100) async throws -> [PlaylistTrackInfo] {
        do {
            let params = [
                "id": globalCollectionId,
                "page": String(page),
                "pagesize": String(pageSize)
            ]
            
            let response: PlaylistTracksResponse = try await NetworkService.shared.get(
                endpoint: "/playlist/track/all",
                params: params,
                responseType: PlaylistTracksResponse.self
            )
            
            if response.status == 1, let data = response.data, let tracks = data.songs {
                return tracks
            } else {
                throw UserServiceError.serverError(response.error_code, "获取歌单歌曲失败")
            }
        } catch let error as NetworkError {
            throw UserServiceError.networkError(error.localizedDescription)
        } catch let error as UserServiceError {
            throw error
        } catch {
            throw UserServiceError.unknownError
        }
    }
    
    // MARK: - 通用方法
    
    /// 删除歌单
    func deletePlaylist(listid: Int) async throws {
        do {
            let params = ["listid": String(listid)]
            
            let response: PlaylistDeleteResponse = try await NetworkService.shared.get(
                endpoint: "/playlist/del",
                params: params,
                responseType: PlaylistDeleteResponse.self
            )
            
            if response.status != 1 {
                throw UserServiceError.serverError(response.error_code, response.error_msg ?? "删除歌单失败")
            }
        } catch let error as NetworkError {
            throw UserServiceError.networkError(error.localizedDescription)
        } catch let error as UserServiceError {
            throw error
        } catch {
            throw UserServiceError.unknownError
        }
    }
    
    /// 创建歌单
    func createPlaylist(name: String, isPrivate: Bool = false) async throws -> PlaylistCreateResponse.PlaylistCreateData {
        do {
            var params = [
                "name": name,
                "type": "0"  // 0：创建歌单，1：收藏歌单
            ]
            
            if isPrivate {
                params["is_pri"] = "1"  // 1：隐私，0：公开
            }
            
            let response: PlaylistCreateResponse = try await NetworkService.shared.get(
                endpoint: "/playlist/add",
                params: params,
                responseType: PlaylistCreateResponse.self
            )
            
            if response.status == 1, let data = response.data {
                // 创建成功后立即刷新本地歌单列表
                await refreshPlaylists()
                return data
            } else {
                throw UserServiceError.serverError(response.error_code, response.error_msg ?? "创建歌单失败")
            }
        } catch let error as NetworkError {
            throw UserServiceError.networkError(error.localizedDescription)
        } catch let error as UserServiceError {
            throw error
        } catch {
            throw UserServiceError.unknownError
        }
    }
    
    /// 添加歌曲到歌单
    func addTracksToPlaylist(listid: Int, tracks: [PlaylistTrackInfo]) async throws {
        do {
            // 构造data参数：歌曲名称|歌曲 hash|专辑 id|mixsongid/album_audio_id
            let dataItems = tracks.compactMap { track -> String? in
                guard let name = track.name, let hash = track.hash else { return nil }
                
                let albumId = track.album_id ?? ""
                let mixsongid = track.mixsongid.map(String.init) ?? track.audio_id.map(String.init) ?? ""
                
                return "\(name)|\(hash)|\(albumId)|\(mixsongid)"
            }
            
            guard !dataItems.isEmpty else {
                throw UserServiceError.serverError(0, "没有有效的歌曲数据")
            }
            
            let params = [
                "listid": String(listid),
                "data": dataItems.joined(separator: ",")
            ]
            
            let response: PlaylistAddTracksResponse = try await NetworkService.shared.get(
                endpoint: "/playlist/tracks/add",
                params: params,
                responseType: PlaylistAddTracksResponse.self
            )
            
            if response.status != 1 {
                throw UserServiceError.serverError(response.error_code, response.error_msg ?? "添加歌曲到歌单失败")
            }
        } catch let error as NetworkError {
            throw UserServiceError.networkError(error.localizedDescription)
        } catch let error as UserServiceError {
            throw error
        } catch {
            throw UserServiceError.unknownError
        }
    }
    
    /// 从歌单删除歌曲
    func removeTracksFromPlaylist(listid: Int, fileids: [Int]) async throws {
        do {
            let params = [
                "listid": String(listid),
                "fileids": fileids.map(String.init).joined(separator: ",")
            ]
            
            let response: PlaylistRemoveTracksResponse = try await NetworkService.shared.get(
                endpoint: "/playlist/tracks/del",
                params: params,
                responseType: PlaylistRemoveTracksResponse.self
            )
            
            if response.status != 1 {
                throw UserServiceError.serverError(response.error_code, response.error_msg ?? "从歌单删除歌曲失败")
            }
        } catch let error as NetworkError {
            throw UserServiceError.networkError(error.localizedDescription)
        } catch let error as UserServiceError {
            throw error
        } catch {
            throw UserServiceError.unknownError
        }
    }
    
    /// 刷新指定分类的数据
    func refreshSection() async {
        await refreshPlaylists()
    }
    
    /// 清除所有数据
    func clearAllData() {
        userCreatedPlaylists = []
        collectedPlaylists = []
        collectedAlbums = []
        rawPlaylistData = []
        likedPlaylistId = nil
        
        myPlaylistsError = nil
    }
}
