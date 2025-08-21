//
//  PlaylistSearchTest.swift
//  EchoMusicTests
//
//  Created on 2025/8/21.
//

import XCTest
@testable import EchoMusic

class PlaylistSearchTest: XCTestCase {
    
    func testPlaylistFromSearchItem() {
        // 模拟API返回的歌单数据
        let playlistData = """
        {
            "playlist_info": {
                "specialid": 5514931,
                "specialname": "2018 | 起风了 去年夏天  纸短情长  病变",
                "nickname": "阿月",
                "song_count": 62,
                "play_count": "1573",
                "collect_count": "0",
                "intro": "",
                "publish_time": "2022-05-13 16:50:09",
                "suid": "586764232",
                "gid": "collection_3_586764232_362_0"
            },
            "img": "http://c1.kgimg.com/custom/150/20220513/20220513163436206186.jpg"
        }
        """.data(using: .utf8)!
        
        // 解码为SearchItem
        let decoder = JSONDecoder()
        let searchItem = try? decoder.decode(SearchItem.self, from: playlistData)
        XCTAssertNotNil(searchItem)
        
        // 转换为Playlist
        let playlist = Playlist(from: searchItem!)
        XCTAssertNotNil(playlist)
        
        XCTAssertEqual(playlist?.id, 5514931)
        XCTAssertEqual(playlist?.name, "2018 | 起风了 去年夏天  纸短情长  病变")
        XCTAssertEqual(playlist?.coverImgUrl, "http://c1.kgimg.com/custom/150/20220513/20220513163436206186.jpg")
        XCTAssertEqual(playlist?.trackCount, 62)
        XCTAssertEqual(playlist?.playCount, 1573)
        XCTAssertEqual(playlist?.creator?.nickname, "阿月")
        XCTAssertEqual(playlist?.creator?.id, 586764232)
    }
    
    func testPlaylistSearchResultParsing() {
        // 模拟完整的歌单搜索结果
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
                "total": 480,
                "lists": [
                    {
                        "playlist_info": {
                            "specialid": 5514931,
                            "specialname": "2018 | 起风了 去年夏天  纸短情长  病变",
                            "nickname": "阿月",
                            "song_count": 62,
                            "play_count": "1573",
                            "collect_count": "0",
                            "intro": "",
                            "publish_time": "2022-05-13 16:50:09",
                            "suid": "586764232",
                            "gid": "collection_3_586764232_362_0"
                        },
                        "img": "http://c1.kgimg.com/custom/150/20220513/20220513163436206186.jpg"
                    },
                    {
                        "playlist_info": {
                            "specialid": 7804424,
                            "specialname": "回忆杀2018年夏天热播抖音最火的歌曲/童话镇 起风了",
                            "nickname": "音巢阿呆",
                            "song_count": 59,
                            "play_count": "16901",
                            "collect_count": "0",
                            "intro": "",
                            "publish_time": "2024-07-18 10:25:27",
                            "suid": "645104354",
                            "gid": "collection_3_645104354_2234_0"
                        },
                        "img": "http://c1.kgimg.com/custom/150/20240718/20240718101939447353.jpg"
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
        XCTAssertEqual(searchResult?.data?.total, 480)
        XCTAssertEqual(searchResult?.data?.lists?.count, 2)
        
        // 测试转换为Playlist数组
        let playlists = searchResult?.data?.playlists
        XCTAssertNotNil(playlists)
        XCTAssertEqual(playlists?.count, 2)
        XCTAssertEqual(playlists?.first?.name, "2018 | 起风了 去年夏天  纸短情长  病变")
        XCTAssertEqual(playlists?.last?.name, "回忆杀2018年夏天热播抖音最火的歌曲/童话镇 起风了")
        XCTAssertEqual(playlists?.first?.creator?.nickname, "阿月")
        XCTAssertEqual(playlists?.last?.creator?.nickname, "音巢阿呆")
    }
    
    func testPlaylistWithLargePlayCount() {
        // 测试大播放数量的格式化
        let playlistData = """
        {
            "playlist_info": {
                "specialid": 378394,
                "specialname": "抖音歌曲最火的歌2025抖音热歌2025最好听",
                "nickname": "无殇少侠",
                "song_count": 228,
                "play_count": "350408",
                "collect_count": "0",
                "intro": "非常热门的歌曲，你听过哪些呢？\\n持续更新中...",
                "publish_time": "2018-04-12 00:00:01",
                "suid": "1134858279",
                "gid": "collection_1_1134858279_378394_0"
            },
            "img": "http://c1.kgimg.com/custom/150/20250318/20250318170334565862.jpg"
        }
        """.data(using: .utf8)!
        
        let decoder = JSONDecoder()
        let searchItem = try? decoder.decode(SearchItem.self, from: playlistData)
        XCTAssertNotNil(searchItem)
        
        let playlist = Playlist(from: searchItem!)
        XCTAssertNotNil(playlist)
        
        XCTAssertEqual(playlist?.playCount, 350408)
        XCTAssertEqual(playlist?.trackCount, 228)
        XCTAssertEqual(playlist?.creator?.nickname, "无殇少侠")
    }
    
    func testPlaylistWithoutOptionalFields() {
        // 测试缺少可选字段的情况
        let playlistData = """
        {
            "playlist_info": {
                "specialid": 123456,
                "specialname": "测试歌单",
                "nickname": "测试用户",
                "song_count": 10,
                "play_count": "100",
                "suid": "123456"
            },
            "img": "http://example.com/cover.jpg"
        }
        """.data(using: .utf8)!
        
        let decoder = JSONDecoder()
        let searchItem = try? decoder.decode(SearchItem.self, from: playlistData)
        XCTAssertNotNil(searchItem)
        
        let playlist = Playlist(from: searchItem!)
        XCTAssertNotNil(playlist)
        
        XCTAssertEqual(playlist?.id, 123456)
        XCTAssertEqual(playlist?.name, "测试歌单")
        XCTAssertEqual(playlist?.trackCount, 10)
        XCTAssertEqual(playlist?.playCount, 100)
        XCTAssertEqual(playlist?.creator?.nickname, "测试用户")
        XCTAssertNil(playlist?.description)
        XCTAssertNil(playlist?.subscribed)
    }
}