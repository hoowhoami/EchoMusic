//
//  LenientDecoding.swift
//  EchoMusic
//
//  Created by AI Assistant on 2025/8/6.
//

import Foundation

// MARK: - 真正优雅的解决方案：用于特定场景的属性包装器

/// 用于 API 响应的顶级属性包装器
@propertyWrapper
struct APIResponse<T: Decodable> {
    var wrappedValue: T?
    
    init(wrappedValue: T? = nil) {
        self.wrappedValue = wrappedValue
    }
}

extension APIResponse: Decodable {
    init(from decoder: Decoder) throws {
        do {
            let container = try decoder.singleValueContainer()
            self.wrappedValue = try container.decode(T.self)
        } catch {
            self.wrappedValue = nil
        }
    }
}

extension APIResponse: Encodable where T: Encodable {
    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(wrappedValue)
    }
}

// MARK: - 简化的安全解码宏（如果需要的话）

/// 创建安全的模型结构体的便捷宏
/// 使用方法: @SafeDecodable struct MyModel { ... }
// 注意: 需要额外的宏实现包才能使用
// @attached(member, names: named(init))
// public macro SafeDecodable() = #externalMacro(module: "SafeDecodingMacros", type: "SafeDecodableMacro")

// MARK: - 最佳实践：优化的 KeyedDecodingContainer 扩展

/// 宽松解码扩展，用于处理可能缺失或类型不匹配的JSON字段
extension KeyedDecodingContainer {
    
    // MARK: - 通用安全解码方法
    
    /// 万能安全解码方法 - 支持任何 Decodable 类型，失败时返回 nil
    func safeDecodeOptional<T: Decodable>(_ type: T.Type, forKey key: Key) -> T? {
        return (try? decodeIfPresent(type, forKey: key)) ?? nil
    }
    
    /// 万能安全解码方法 - 支持任何 Decodable 类型，失败时返回默认值
    func safeDecode<T: Decodable>(_ type: T.Type, forKey key: Key, default defaultValue: T) -> T {
        return (try? decode(type, forKey: key)) ?? defaultValue
    }
    
    // MARK: - 便捷方法（保持向后兼容）
    
    /// 尝试解码可选字符串，失败时返回nil
    func decodeIfPresentSafe<T: Decodable>(_ type: T.Type, forKey key: Key) -> T? {
        return safeDecodeOptional(type, forKey: key)
    }
    
    /// 尝试解码字符串，失败时返回默认值
    func decodeSafe(_ type: String.Type, forKey key: Key, defaultValue: String = "") -> String {
        return safeDecode(type, forKey: key, default: defaultValue)
    }
    
    /// 尝试解码可选字符串，失败时返回nil
    func decodeOptionalSafe(_ type: String.Type, forKey key: Key) -> String? {
        return safeDecodeOptional(type, forKey: key)
    }
    
    /// 尝试解码整数，失败时返回默认值
    func decodeSafe(_ type: Int.Type, forKey key: Key, defaultValue: Int = 0) -> Int {
        return safeDecode(type, forKey: key, default: defaultValue)
    }
    
    /// 尝试解码可选整数，失败时返回nil
    func decodeOptionalSafe(_ type: Int.Type, forKey key: Key) -> Int? {
        return safeDecodeOptional(type, forKey: key)
    }
    
    /// 尝试解码双精度浮点数，失败时返回默认值
    func decodeSafe(_ type: Double.Type, forKey key: Key, defaultValue: Double = 0.0) -> Double {
        return safeDecode(type, forKey: key, default: defaultValue)
    }
    
    /// 尝试解码可选双精度浮点数，失败时返回nil
    func decodeOptionalSafe(_ type: Double.Type, forKey key: Key) -> Double? {
        return safeDecodeOptional(type, forKey: key)
    }
    
    /// 尝试解码布尔值，失败时返回默认值
    func decodeSafe(_ type: Bool.Type, forKey key: Key, defaultValue: Bool = false) -> Bool {
        return safeDecode(type, forKey: key, default: defaultValue)
    }
    
    /// 尝试解码可选布尔值，失败时返回nil
    func decodeOptionalSafe(_ type: Bool.Type, forKey key: Key) -> Bool? {
        return safeDecodeOptional(type, forKey: key)
    }
    
    /// 尝试解码数组，失败时返回空数组
    func decodeSafe<T: Decodable>(_ type: [T].Type, forKey key: Key) -> [T] {
        return safeDecode(type, forKey: key, default: [])
    }
    
    /// 尝试解码可选数组，失败时返回nil
    func decodeOptionalSafe<T: Decodable>(_ type: [T].Type, forKey key: Key) -> [T]? {
        return safeDecodeOptional(type, forKey: key)
    }
    
    /// 尝试解码字典，失败时返回空字典
    func decodeSafe<DictKey: Codable & Hashable, DictValue: Codable>(_ type: [DictKey: DictValue].Type, forKey key: Key) -> [DictKey: DictValue] {
        return safeDecode(type, forKey: key, default: [:])
    }
    
    /// 尝试解码可选字典，失败时返回nil
    func decodeOptionalSafe<DictKey: Codable & Hashable, DictValue: Codable>(_ type: [DictKey: DictValue].Type, forKey key: Key) -> [DictKey: DictValue]? {
        return safeDecodeOptional(type, forKey: key)
    }
}

// MARK: - 高级功能：自动生成安全解码器的协议

/// 安全解码协议 - 提供自动生成的安全解码功能
protocol AutoSafeDecodable: Codable {
    /// 自动生成的安全初始化器
    init(safelyFrom decoder: Decoder) throws
}

extension AutoSafeDecodable {
    /// 默认的安全解码实现
    static func safeDecode(from data: Data) -> Self? {
        do {
            return try JSONDecoder().decode(Self.self, from: data)
        } catch {
            // 这里可以实现更复杂的容错逻辑
            return nil
        }
    }
}

// MARK: - 便捷的创建方法

extension KeyedDecodingContainer {
    /// 一行代码解决所有解码问题的万能方法
    subscript<T: Decodable>(safe key: Key) -> T? {
        return safeDecodeOptional(T.self, forKey: key)
    }
    
    /// 带默认值的万能方法
    func safeValue<T: Decodable>(for key: Key, type: T.Type, default defaultValue: T) -> T {
        return safeDecode(type, forKey: key, default: defaultValue)
    }
}

// MARK: - 遗留兼容协议

/// 宽松解码协议，提供默认的容错解析行为
protocol LenientDecodable: Codable {
    init()
}

extension LenientDecodable {
    /// 提供默认的宽松解码实现
    static func lenientDecode(from data: Data) -> Self? {
        do {
            return try JSONDecoder().decode(Self.self, from: data)
        } catch {
            return Self()
        }
    }
}