//
//  SearchService.swift
//  EchoMusic
//
//  Created on 2025/8/20.
//

import Foundation

/// 搜索服务，处理所有搜索相关的API调用
class SearchService: ObservableObject {
    static let shared = SearchService()
    
    private let networkService = NetworkService.shared
    
    private init() {}
    
        
    // MARK: - 分类型搜索
    
    /// 搜索单曲
    /// - Parameters:
    ///   - keyword: 搜索关键词
    ///   - page: 页码，默认为1
    ///   - pageSize: 每页数量，默认为30
    /// - Returns: 单曲搜索结果
    func searchSong(
        keyword: String,
        page: Int = 1,
        pageSize: Int = 30
    ) async throws -> SearchSongResult {
        let params: [String: String] = [
            "keywords": keyword,
            "type": SearchType.song.rawValue,
            "page": String((page - 1) * pageSize),
            "pageSize": String(pageSize)
        ]
        
        return try await networkService.get(
            endpoint: "/search",
            params: params,
            responseType: SearchSongResult.self
        )
    }
    
    /// 搜索专辑
    /// - Parameters:
    ///   - keyword: 搜索关键词
    ///   - page: 页码，默认为1
    ///   - pageSize: 每页数量，默认为30
    /// - Returns: 专辑搜索结果
    func searchAlbum(
        keyword: String,
        page: Int = 1,
        pageSize: Int = 30
    ) async throws -> SearchAlbumResult {
        let params: [String: String] = [
            "keywords": keyword,
            "type": SearchType.album.rawValue,
            "page": String((page - 1) * pageSize),
            "pageSize": String(pageSize)
        ]
        
        return try await networkService.get(
            endpoint: "/search",
            params: params,
            responseType: SearchAlbumResult.self
        )
    }
    
    /// 搜索歌手
    /// - Parameters:
    ///   - keyword: 搜索关键词
    ///   - page: 页码，默认为1
    ///   - pageSize: 每页数量，默认为30
    /// - Returns: 歌手搜索结果
    func searchArtist(
        keyword: String,
        page: Int = 1,
        pageSize: Int = 30
    ) async throws -> SearchArtistResult {
        let params: [String: String] = [
            "keywords": keyword,
            "type": SearchType.artist.rawValue,
            "page": String((page - 1) * pageSize),
            "pageSize": String(pageSize)
        ]
        
        return try await networkService.get(
            endpoint: "/search",
            params: params,
            responseType: SearchArtistResult.self
        )
    }
    
    /// 搜索歌单
    /// - Parameters:
    ///   - keyword: 搜索关键词
    ///   - page: 页码，默认为1
    ///   - pageSize: 每页数量，默认为30
    /// - Returns: 歌单搜索结果
    func searchPlaylist(
        keyword: String,
        page: Int = 1,
        pageSize: Int = 30
    ) async throws -> SearchPlaylistResult {
        let params: [String: String] = [
            "keywords": keyword,
            "type": SearchType.playlist.rawValue,
            "page": String((page - 1) * pageSize),
            "pageSize": String(pageSize)
        ]
        
        return try await networkService.get(
            endpoint: "/search",
            params: params,
            responseType: SearchPlaylistResult.self
        )
    }
    
    // MARK: - 综合搜索
    
    /// 综合搜索（同时返回单曲、歌手、歌单等信息）
    /// - Parameters:
    ///   - keyword: 搜索关键词
    ///   - page: 页码，默认为1
    ///   - pageSize: 每页数量，默认为30
    /// - Returns: 综合搜索结果
    func complexSearch(
        keyword: String,
        page: Int = 1,
        pageSize: Int = 30
    ) async throws -> ComplexSearchResult {
        let params: [String: String] = [
            "keywords": keyword,
            "page": String((page - 1) * pageSize),
            "pageSize": String(pageSize)
        ]
        
        return try await networkService.get(
            endpoint: "/search/complex",
            params: params,
            responseType: ComplexSearchResult.self
        )
    }
    
    // MARK: - 搜索建议
    
    /// 获取搜索建议
    /// - Parameters:
    ///   - keyword: 搜索关键词
    ///   - musicTipCount: 音乐返回数量，默认为5
    ///   - albumTipCount: 专辑返回数量，默认为2
    ///   - mvTipCount: MV返回数量，默认为0
    /// - Returns: 搜索建议结果
    func searchSuggest(
        keyword: String,
        musicTipCount: Int = 5,
        albumTipCount: Int = 5,
        mvTipCount: Int = 0
    ) async throws -> SearchSuggestResult {
        let params: [String: String] = [
            "keywords": keyword,
            "musicTipCount": String(musicTipCount),
            "albumTipCount": String(albumTipCount),
            "mvTipCount": String(mvTipCount)
        ]
        
        return try await networkService.get(
            endpoint: "/search/suggest",
            params: params,
            responseType: SearchSuggestResult.self
        )
    }
    
    // MARK: - 热搜
    
    /// 获取热搜列表
    /// - Returns: 热搜结果
    func getHotSearch() async throws -> HotSearchResult {
        return try await networkService.get(
            endpoint: "/search/hot",
            params: [:],
            responseType: HotSearchResult.self
        )
    }
    
    // MARK: - 默认搜索关键词
    
    /// 获取默认搜索关键词
    /// - Returns: 默认搜索关键词结果
    func getDefaultSearchKeyword() async throws -> DefaultSearchResult {
        return try await networkService.get(
            endpoint: "/search/default",
            params: [:],
            responseType: DefaultSearchResult.self
        )
    }
    
    // MARK: - 便利方法
    
    /// 搜索单曲
    func searchSongs(keyword: String, page: Int = 1, pageSize: Int = 30) async throws -> [Song] {
        let result = try await searchSong(keyword: keyword, page: page, pageSize: pageSize)
        return result.data?.lists?.map { $0.toSong() } ?? []
    }
    
    /// 搜索专辑
    func searchAlbums(keyword: String, page: Int = 1, pageSize: Int = 30) async throws -> [Album] {
        let result = try await searchAlbum(keyword: keyword, page: page, pageSize: pageSize)
        return result.data?.lists ?? []
    }
    
    /// 搜索歌手
    func searchArtists(keyword: String, page: Int = 1, pageSize: Int = 30) async throws -> [Artist] {
        let result = try await searchArtist(keyword: keyword, page: page, pageSize: pageSize)
        return result.data?.lists ?? []
    }
    
    /// 搜索歌单
    func searchPlaylists(keyword: String, page: Int = 1, pageSize: Int = 30) async throws -> [Playlist] {
        let result = try await searchPlaylist(keyword: keyword, page: page, pageSize: pageSize)
        return result.data?.lists ?? []
    }
    
}
