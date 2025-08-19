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
            case .myCloud:
                CloudMusicView()
            case .recentPlay:
                RecentMusicView()
            case .playlists:
                PlaylistView()
            case .userProfile:
                UserProfileView()
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(10)
    }
    
}

#Preview {
    ContentView(selectedItem: .home)
}
