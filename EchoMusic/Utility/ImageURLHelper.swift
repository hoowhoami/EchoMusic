//
//  ImageURLHelper.swift
//  EchoMusic
//
//  Created by AI Assistant on 2025/8/6.
//

import Foundation

/// 图片URL处理工具类
struct ImageURLHelper {
    
    /// 处理图片URL，支持尺寸占位符和协议转换
    /// - Parameters:
    ///   - urlString: 原始URL字符串
    ///   - size: 期望的图片尺寸，默认120
    /// - Returns: 处理后的URL
    static func processImageURL(_ urlString: String?, size: Int = 120) -> URL? {
        guard let urlString = urlString, !urlString.isEmpty else { return nil }
        
        var processedURL = urlString
        
        // 1. 处理尺寸占位符
        processedURL = processedURL.replacingOccurrences(of: "{size}", with: String(size))
        
        // 2. 将HTTP转换为HTTPS
        if processedURL.hasPrefix("http://") {
            processedURL = processedURL.replacingOccurrences(of: "http://", with: "https://")
        }
        // 3. 处理协议相对URL
        else if processedURL.hasPrefix("//") {
            processedURL = "https:" + processedURL
        }
        
        return URL(string: processedURL)
    }
    
    /// 获取不同尺寸的图片URL
    /// - Parameters:
    ///   - urlString: 原始URL字符串
    ///   - size: 图片尺寸类型
    /// - Returns: 处理后的URL
    static func processImageURL(_ urlString: String?, size: ImageSize) -> URL? {
        return processImageURL(urlString, size: size.rawValue)
    }
}

/// 图片尺寸枚举
enum ImageSize: Int, CaseIterable {
    case thumbnail = 60      // 缩略图
    case small = 120         // 小图
    case medium = 240        // 中图
    case large = 480         // 大图
    case extraLarge = 640    // 超大图
    
    var displayName: String {
        switch self {
        case .thumbnail: return "缩略图"
        case .small: return "小图"
        case .medium: return "中图"
        case .large: return "大图"
        case .extraLarge: return "超大图"
        }
    }
}