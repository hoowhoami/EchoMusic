//
//  DateUtils.swift
//  EchoMusic
//
//  Created on 2025/8/4.
//

import Foundation

struct DateHelper {
    /// 格式化日期为字符串
    static func formatDate(_ date: Date, format: String = "yyyy-MM-dd HH:mm") -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = format
        return formatter.string(from: date)
    }
}
