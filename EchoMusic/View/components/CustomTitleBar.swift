//
//  CustomTitleBar.swift
//  EchoMusic
//
//  Created by AI Assistant on 2025/8/4.
//

import SwiftUI

// 自定义标题栏组件：只有搜索框
struct CustomTitleBarContent: View {
    @State private var searchText = ""

    var body: some View {
        HStack(alignment: .center, spacing: 0) {
            // 中间：搜索框 - 居中显示
            HStack(alignment: .center, spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .foregroundColor(.secondary)
                    .font(.system(size: 13))
                    .frame(width: 13, height: 13)

                TextField("搜索音乐、歌手、歌单、分享码", text: $searchText)
                    .textFieldStyle(.plain)
                    .font(.system(size: 12))
            }
            .frame(width: 360, height: 28)
            .padding(.horizontal, 14)
            .background(Color.gray.opacity(0.1))
            .cornerRadius(10)
            .padding(.horizontal, 32)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(NSColor.windowBackgroundColor))
    }
}

