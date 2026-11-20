import LTMKit
import SwiftUI
import UIKit

@main
struct LTMApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var model = AppModel.shared

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                .environmentObject(model.coordinator)
                .environmentObject(model.watchBridge)
                .environmentObject(model.memoryStore)
                .onOpenURL { url in model.handle(url: url) }
        }
    }
}

/// Receives background `URLSession` events: when uploads finish while the app is
/// suspended, iOS relaunches it in the background and calls this; the handler must be
/// called once the session has delivered all events (see `BackgroundUploadTransport`).
@MainActor
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        handleEventsForBackgroundURLSession identifier: String,
        completionHandler: @escaping () -> Void
    ) {
        let model = AppModel.shared
        guard identifier == model.transport.identifier else {
            completionHandler()
            return
        }
        model.transport.setBackgroundEventsCompletionHandler(completionHandler)
    }
}

/// Chooses the screen from the coordinator's state: onboarding until paired and
/// consented, then the main screen.
@MainActor
struct RootView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var coordinator: CaptureCoordinator
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage("ltm.welcomeSeen") private var welcomeSeen = false
    @AppStorage("ltm.permissionsSeen") private var permissionsSeen = false
    @State private var handledLaunch = false

    var body: some View {
        Group {
            if !welcomeSeen {
                WelcomeView { welcomeSeen = true }
            } else {
                switch coordinator.state {
                case .notPaired:
                    NavigationStack { PairView() }
                        .onAppear { model.resetReader() }
                case .consentRequired:
                    NavigationStack { ConsentView() }
                default:
                    if permissionsSeen {
                        ReaderTabView()
                    } else {
                        NavigationStack { PermissionsView { permissionsSeen = true } }
                    }
                }
            }
        }
        .onChange(of: scenePhase, initial: true) { _, phase in
            coordinator.setForeground(phase == .active)
            model.setForeground(phase == .active)
            if phase == .active && !handledLaunch {
                handledLaunch = true
                // Only when the user enabled "resume automatically"; never by default.
                Task { await coordinator.resumeAfterLaunchIfAllowed() }
            }
        }
    }
}
