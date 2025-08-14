//
//  ContentView.swift
//  EchoMusic
//
//  Created on 2025/8/4.
//

import SwiftUI

struct ContentView: View {
    let selectedItem: NavigationItemType
    
    var body: some View {
        Group {
            switch selectedItem {
            case .home:
                HomeView()
            case .discover:
                DiscoverView()
            case .favoriteMusic, .myCloud, .recentPlay:
                LibraryView()
            case .userProfile:
                UserProfileView()
            case .videos:
                // TODO: 实现视频页面
                VStack {
                    Image(systemName: "play.rectangle.fill")
                        .font(.system(size: 64))
                        .foregroundColor(.secondary)
                    Text("视频功能正在开发中")
                        .font(.title2)
                        .foregroundColor(.secondary)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(20)
    }
}

#Preview {
    ContentView(selectedItem: .home)
}
