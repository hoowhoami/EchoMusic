//
//  AlbumSearchTest.swift
//  EchoMusicTests
//
//  Created on 2025/8/21.
//

import XCTest
@testable import EchoMusic

class AlbumSearchTest: XCTestCase {
    
    func testAlbumFromSearchItem() {
        // 模拟API返回的专辑数据
        let albumData = """
        {
            "albumid": 53218722,
            "albumname": "起风了",
            "singer": "买辣椒也用券",
            "singerid": "0",
            "img": "http://imge.kugou.com/stdmusic/240/20220119/20220119171002204341.jpg",
            "publish_time": "2018-12-03",
            "songcount": 3,
            "language": "华语",
            "company": "某公司"
        }
        """.data(using: .utf8)!
        
        // 解码为SearchItem
        let decoder = JSONDecoder()
        let searchItem = try? decoder.decode(SearchItem.self, from: albumData)
        XCTAssertNotNil(searchItem)
        
        // 转换为Album
        let album = Album(from: searchItem!)
        XCTAssertNotNil(album)
        
        XCTAssertEqual(album?.id, 53218722)
        XCTAssertEqual(album?.name, "起风了")
        XCTAssertEqual(album?.artist?.name, "买辣椒也用券")
        XCTAssertEqual(album?.cover, "http://imge.kugou.com/stdmusic/240/20220119/20220119171002204341.jpg")
        XCTAssertEqual(album?.size, 3)
        XCTAssertEqual(album?.language, "华语")
        XCTAssertEqual(album?.company, "某公司")
    }
    
    func testAlbumSearchResultParsing() {
        // 模拟完整的搜索结果
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
                "total": 500,
                "lists": [
                    {
                        "albumid": 53218722,
                        "albumname": "起风了",
                        "singer": "买辣椒也用券",
                        "img": "http://imge.kugou.com/stdmusic/240/20220119/20220119171002204341.jpg",
                        "publish_time": "2018-12-03",
                        "songcount": 3,
                        "language": "华语"
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
        XCTAssertEqual(searchResult?.data?.total, 500)
        XCTAssertEqual(searchResult?.data?.lists?.count, 1)
        
        // 测试转换为Album数组
        let albums = searchResult?.data?.albums
        XCTAssertNotNil(albums)
        XCTAssertEqual(albums?.count, 1)
        XCTAssertEqual(albums?.first?.name, "起风了")
        XCTAssertEqual(albums?.first?.artist?.name, "买辣椒也用券")
    }
}