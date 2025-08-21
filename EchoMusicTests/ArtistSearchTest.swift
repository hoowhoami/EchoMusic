//
//  ArtistSearchTest.swift
//  EchoMusicTests
//
//  Created on 2025/8/21.
//

import XCTest
@testable import EchoMusic

class ArtistSearchTest: XCTestCase {
    
    func testArtistFromSearchItem() {
        // 模拟API返回的歌手数据
        let artistData = """
        {
            "AuthorId": 12345,
            "AuthorName": "周杰伦",
            "Avatar": "http://singerimg.kugou.com/uploadpic/softhead/240/20230420/20230420213535217367.jpg",
            "IsSettledAuthor": 1,
            "AlbumCount": 61,
            "AudioCount": 125,
            "FansNum": 972839
        }
        """.data(using: .utf8)!
        
        // 解码为SearchItem
        let decoder = JSONDecoder()
        let searchItem = try? decoder.decode(SearchItem.self, from: artistData)
        XCTAssertNotNil(searchItem)
        
        // 转换为Artist
        let artist = Artist(from: searchItem!)
        XCTAssertNotNil(artist)
        
        XCTAssertEqual(artist?.id, 12345)
        XCTAssertEqual(artist?.name, "周杰伦")
        XCTAssertEqual(artist?.cover, "http://singerimg.kugou.com/uploadpic/softhead/240/20230420/20230420213535217367.jpg")
        XCTAssertEqual(artist?.albumSize, 61)
        XCTAssertEqual(artist?.musicSize, 125)
        XCTAssertEqual(artist?.fansSize, 972839)
        XCTAssertEqual(artist?.followed, true)
    }
    
    func testArtistFromAlbumSearchItem() {
        // 模拟从专辑搜索结果中提取的歌手信息
        let albumSearchItem = """
        {
            "singer": "邓紫棋",
            "singerid": "67890",
            "img": "http://img.kugou.com/album/67890.jpg",
            "songcount": 15
        }
        """.data(using: .utf8)!
        
        // 解码为SearchItem
        let decoder = JSONDecoder()
        let searchItem = try? decoder.decode(SearchItem.self, from: albumSearchItem)
        XCTAssertNotNil(searchItem)
        
        // 转换为Artist
        let artist = Artist(from: searchItem!)
        XCTAssertNotNil(artist)
        
        XCTAssertEqual(artist?.id, 67890)
        XCTAssertEqual(artist?.name, "邓紫棋")
        XCTAssertEqual(artist?.cover, "http://img.kugou.com/album/67890.jpg")
        XCTAssertEqual(artist?.musicSize, 15)
    }
    
    func testArtistSearchResultParsing() {
        // 模拟完整的歌手搜索结果
        let searchData = """
        {
            "status": 1,
            "error_code": 0,
            "error_msg": "",
            "data": {
                "pagesize": 30,
                "page": 1,
                "from": 0,
                "size": 30,
                "total": 100,
                "lists": [
                    {
                        "AuthorId": 11111,
                        "AuthorName": "林俊杰",
                        "Avatar": "http://singerimg.kugou.com/uploadpic/softhead/240/20230531/20230531160722881.jpg",
                        "IsSettledAuthor": 1,
                        "AlbumCount": 277,
                        "AudioCount": 1444,
                        "FansNum": 6481561
                    },
                    {
                        "AuthorId": 22222,
                        "AuthorName": "陈奕迅",
                        "Avatar": "http://singerimg.kugou.com/uploadpic/softhead/240/20230420/20230420213535217367.jpg",
                        "IsSettledAuthor": 1,
                        "AlbumCount": 150,
                        "AudioCount": 800,
                        "FansNum": 5000000
                    }
                ]
            }
        }
        """.data(using: .utf8)!
        
        // 解码搜索结果
        let decoder = JSONDecoder()
        let searchResult = try? decoder.decode(SearchResult.self, from: searchData)
        XCTAssertNotNil(searchResult)
        XCTAssertEqual(searchResult?.status, 1)
        XCTAssertEqual(searchResult?.data?.total, 100)
        XCTAssertEqual(searchResult?.data?.lists?.count, 2)
        
        // 测试转换为Artist数组
        let artists = searchResult?.data?.artists
        XCTAssertNotNil(artists)
        XCTAssertEqual(artists?.count, 2)
        XCTAssertEqual(artists?.first?.name, "林俊杰")
        XCTAssertEqual(artists?.last?.name, "陈奕迅")
        XCTAssertEqual(artists?.first?.id, 11111)
        XCTAssertEqual(artists?.last?.id, 22222)
    }
    
    func testArtistWithoutID() {
        // 测试没有AuthorId的情况
        let artistData = """
        {
            "AuthorName": "未知歌手",
            "Avatar": "http://singerimg.kugou.com/uploadpic/softhead/240/20230420/20230420213535217367.jpg"
        }
        """.data(using: .utf8)!
        
        let decoder = JSONDecoder()
        let searchItem = try? decoder.decode(SearchItem.self, from: artistData)
        XCTAssertNotNil(searchItem)
        
        let artist = Artist(from: searchItem!)
        XCTAssertNotNil(artist)
        XCTAssertEqual(artist?.name, "未知歌手")
        // ID应该是name的hash值
        XCTAssertEqual(artist?.id, abs("未知歌手".hashValue))
    }
}