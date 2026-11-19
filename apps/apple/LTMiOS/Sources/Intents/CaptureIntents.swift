import AppIntents
import LTMKit

// Shortcuts / Siri actions. They run in the app process and go through the same
// coordinator as the buttons, so every consent and pairing gate still applies.

struct StartListeningIntent: AppIntent {
    static let title: LocalizedStringResource = "intent.start.title"
    /// Recording can only begin while the app is in the foreground.
    static let openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult {
        await AppModel.shared.coordinator.start()
        return .result()
    }
}

struct PauseListeningIntent: AppIntent {
    static let title: LocalizedStringResource = "intent.pause.title"

    @MainActor
    func perform() async throws -> some IntentResult {
        await AppModel.shared.coordinator.pause()
        return .result()
    }
}

struct StopListeningIntent: AppIntent {
    static let title: LocalizedStringResource = "intent.stop.title"

    @MainActor
    func perform() async throws -> some IntentResult {
        await AppModel.shared.coordinator.stop()
        return .result()
    }
}

struct LTMShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: StartListeningIntent(),
            phrases: ["Start listening with \(.applicationName)"],
            shortTitle: "intent.start.short",
            systemImageName: "mic.fill"
        )
        AppShortcut(
            intent: PauseListeningIntent(),
            phrases: ["Pause \(.applicationName)"],
            shortTitle: "intent.pause.short",
            systemImageName: "pause.fill"
        )
        AppShortcut(
            intent: StopListeningIntent(),
            phrases: ["Stop \(.applicationName)"],
            shortTitle: "intent.stop.short",
            systemImageName: "stop.fill"
        )
    }
}
