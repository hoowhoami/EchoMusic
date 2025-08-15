//
//  UnauthorizedView.swift
//  EchoMusic
//
//  Created by AI Assistant on 2025/8/15.
//

import SwiftUI

/// 通用未登录提示页面
struct UnauthorizedView: View {
    let title: String
    let description: String
    let iconName: String
    let iconColor: Color
    
    @State private var showLoginSheet = false
    
    init(
        title: String,
        description: String = "请先登录以查看此内容",
        iconName: String = "person.circle",
        iconColor: Color = .secondary
    ) {
        self.title = title
        self.description = description
        self.iconName = iconName
        self.iconColor = iconColor
    }
    
    var body: some View {
        VStack(spacing: 24) {
            Spacer()
            
            // 图标
            Image(systemName: iconName)
                .font(.system(size: 80))
                .foregroundColor(iconColor)
            
            // 文本内容
            VStack(spacing: 12) {
                Text(title)
                    .font(.title2)
                    .fontWeight(.semibold)
                    .multilineTextAlignment(.center)
                
                Text(description)
                    .font(.body)
                    .foregroundColor(.secondary)
                    .multilineTextAlignment(.center)
                    .lineLimit(3)
            }
            
            // 登录按钮
            Button(action: {
                showLoginSheet = true
            }) {
                HStack(spacing: 8) {
                    Image(systemName: "person.fill")
                    Text("立即登录")
                }
                .font(.headline)
                .foregroundColor(.white)
                .padding(.horizontal, 32)
                .padding(.vertical, 12)
                .background(Color.accentColor)
                .cornerRadius(25)
            }
            .buttonStyle(.plain)
            
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(NSColor.controlBackgroundColor).opacity(0.3))
        .sheet(isPresented: $showLoginSheet) {
            LoginView()
        }
    }
}

#Preview {
    UnauthorizedView(
        title: "需要登录才能查看喜欢的音乐",
        description: "登录后您可以收藏音乐、创建歌单，享受更多个性化功能",
        iconName: "heart.fill",
        iconColor: .red
    )
    .frame(width: 600, height: 400)
}