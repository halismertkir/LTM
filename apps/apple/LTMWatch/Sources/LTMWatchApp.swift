import LTMKit
import SwiftUI
import WatchKit

@main
struct LTMWatchApp: App {
    @WKApplicationDelegateAdaptor(WatchAppDelegate.self) private var appDelegate
    @StateObject private var model = WatchModel.shared

    var body: some Scene {
        WindowGroup {
            WatchRootView()
                .environmentObject(model)
                .environmentObject(model.coordinator)
        }
    }
}

/// Completes background refresh tasks promptly. Uploads use a foreground session while
/// the app runs (it keeps running while it records with the `audio` background mode);
/// anything left is retried on the next launch.
final class WatchAppDelegate: NSObject, WKApplicationDelegate {
    func handle(_ backgroundTasks: Set<WKRefreshBackgroundTask>) {
        for task in backgroundTasks {
            task.setTaskCompletedWithSnapshot(false)
        }
    }
}

@MainActor
struct WatchRootView: View {
    var body: some View {
        TabView {
            WatchMainView()
            WatchInfoView()
        }
        .tabViewStyle(.page)
    }
}
