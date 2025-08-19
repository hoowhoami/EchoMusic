//
//  History.swift
//  EchoMusic
//
//  Created by 蒋梁通 on 2025/8/19.
//

import Foundation

// MARK: - 用户历史记录数据模型

/// 用户历史记录响应模型
struct UserHistoryResponse: Codable {
    let status: Int
    let error_code: Int
    let data: UserHistoryData?
}

/// 用户历史记录数据
struct UserHistoryData: Codable {
    let userid: String
    let bp: String
    let bp_finished: String
    let has_more: Int
    let id: String
    let songs: [UserHistoryItem]
}

/// 用户历史记录明细
struct UserHistoryItem: Codable {
    let mxid: Int
    let ot: Int
    let op: Int
    let pc: Int
    let sr: Int
    let info: PlaylistTrackInfo?
}

// MARK: - 听歌历史提交相关模型

/// 听歌历史提交响应模型
struct PlayHistoryUploadResponse: Codable {
    let status: Int?
    let error_code: Int?
    let error_msg: String?
    let data: PlayHistoryUploadData?
}

struct PlayHistoryUploadData: Codable {
    let success: Bool?
    let message: String?
}
