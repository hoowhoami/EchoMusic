//
//  Home.swift
//  EchoMusic
//
//  Created on 2025/8/4.
//

import SwiftUI

struct HomeView: View {
    
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                // 标题
                Text("首页")
                    .font(.title2)
                    .fontWeight(.bold)
                
                // 横向滚动歌单
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 16) {
                        Text("测试内容")
                            .font(.headline)
                            .fontWeight(.medium)
                            .padding(.horizontal, 20)
                    }
                    .padding(.horizontal, 16)
                }
            }
            .padding(20)
        }
        .onReceive(NotificationCenter.default.publisher(for: NSNotification.Name("RefreshCurrentContent"))) { _ in
            // 发送刷新完成通知
            NotificationCenter.default.post(
                name: NSNotification.Name("RefreshCompleted"),
                object: nil
            )
        }
    }
}

#Preview {
    HomeView()
}
