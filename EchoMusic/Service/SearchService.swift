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
    
    // MARK: - 基础搜索
    
    /// 搜索音乐
    /// - Parameters:
    ///   - keyword: 搜索关键词
    ///   - type: 搜索类型，默认为单曲
    ///   - page: 页码，默认为1
    ///   - pageSize: 每页数量，默认为30
    /// - Returns: 搜索结果
    func search(
        keyword: String,
        type: SearchType = .song,
        page: Int = 1,
        pageSize: Int = 30
    ) async throws -> SearchResult {
        let params: [String: String] = [
            "keywords": keyword,
            "type": type.rawValue,
            "offset": String((page - 1) * pageSize),
            "limit": String(pageSize)
        ]
        
        return try await networkService.get(
            endpoint: "/search",
            params: params,
            responseType: SearchResult.self
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
            "offset": String((page - 1) * pageSize),
            "limit": String(pageSize)
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
    ///   - mvTipCount: MV返回数量，默认为2
    /// - Returns: 搜索建议结果
    func searchSuggest(
        keyword: String,
        musicTipCount: Int = 5,
        albumTipCount: Int = 2,
        mvTipCount: Int = 2
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
        let result = try await search(keyword: keyword, type: .song, page: page, pageSize: pageSize)
        return result.data?.songs ?? []
    }
    
    /// 搜索专辑
    func searchAlbums(keyword: String, page: Int = 1, pageSize: Int = 30) async throws -> [Album] {
        let result = try await search(keyword: keyword, type: .album, page: page, pageSize: pageSize)
        return result.data?.albums ?? []
    }
    
    /// 搜索歌手
    func searchArtists(keyword: String, page: Int = 1, pageSize: Int = 30) async throws -> [Artist] {
        let result = try await search(keyword: keyword, type: .artist, page: page, pageSize: pageSize)
        return result.data?.artists ?? []
    }
    
    /// 搜索歌单
    func searchPlaylists(keyword: String, page: Int = 1, pageSize: Int = 30) async throws -> [Playlist] {
        let result = try await search(keyword: keyword, type: .playlist, page: page, pageSize: pageSize)
        return result.data?.playlists ?? []
    }
    
    /// 搜索MV
    func searchMVs(keyword: String, page: Int = 1, pageSize: Int = 30) async throws -> [MV] {
        let result = try await search(keyword: keyword, type: .mv, page: page, pageSize: pageSize)
        return result.data?.mvs ?? []
    }
    
    /// 搜索歌词
    func searchLyrics(keyword: String, page: Int = 1, pageSize: Int = 30) async throws -> SearchResult {
        return try await search(keyword: keyword, type: .lyric, page: page, pageSize: pageSize)
    }
}