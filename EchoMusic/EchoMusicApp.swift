//
//  EchoMusicApp.swift
//  EchoMusic
//
//  Created by 蒋梁通 on 2025/8/14.
//

import SwiftUI

@main
struct EchoMusicApp: App {
    let persistenceController = PersistenceController.shared

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(\.managedObjectContext, persistenceController.container.viewContext)
        }
    }
}
