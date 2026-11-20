import LTMKit
import SwiftUI

@MainActor
struct SettingsView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var coordinator: CaptureCoordinator
    @State private var transport: TransportPreference = .automatic
    @State private var language = ""
    @State private var resumeAutomatically = false
    @State private var confirmUnpair = false
    @State private var loaded = false

    private struct LanguageOption: Identifiable {
        let code: String
        let key: String
        var id: String { code }
    }

    /// Language hints offered in the picker ("" = automatic).
    private let languages: [LanguageOption] = [
        LanguageOption(code: "", key: "settings.language.auto"),
        LanguageOption(code: "en", key: "settings.language.en"),
        LanguageOption(code: "tr", key: "settings.language.tr"),
        LanguageOption(code: "de", key: "settings.language.de"),
        LanguageOption(code: "fr", key: "settings.language.fr"),
        LanguageOption(code: "es", key: "settings.language.es"),
    ]

    private var accessText: String {
        switch model.memoryStore.access {
        case .memory: return L("settings.access.memory")
        case .captureOnly: return L("settings.access.capture")
        default:
            let stored = coordinator.settings.deviceAccess
            if stored == .memory { return L("settings.access.memory") }
            if stored == .capture { return L("settings.access.capture") }
            return "—"
        }
    }

    var body: some View {
        Form {
            Section(L("settings.server")) {
                LabeledContent(L("settings.server.address"), value: coordinator.server?.originString ?? "—")
                if let version = coordinator.serverVersion {
                    LabeledContent(L("settings.server.version"), value: "\(version.version) (protocol \(version.protocolVersion))")
                }
                if let me = coordinator.me {
                    LabeledContent(L("settings.server.account"), value: me.user.displayName)
                }
                LabeledContent(L("settings.access"), value: accessText)
                if let server = coordinator.server {
                    Link(destination: server.origin) {
                        Label(L("settings.openDashboard"), systemImage: "safari")
                    }
                }
                Button(L("settings.unpair"), role: .destructive) { confirmUnpair = true }
            }

            Section {
                Picker(L("settings.captureMode"), selection: $transport) {
                    Text(L("settings.captureMode.automatic")).tag(TransportPreference.automatic)
                    Text(L("settings.captureMode.live")).tag(TransportPreference.alwaysLive)
                    Text(L("settings.captureMode.chunks")).tag(TransportPreference.alwaysChunks)
                }
                Picker(L("main.transcription"), selection: $coordinator.transcriptionMode) {
                    Text(L("mode.server")).tag(TranscriptionMode.server)
                    Text(L("mode.onDevice")).tag(TranscriptionMode.onDevice)
                }
                .disabled(coordinator.state.isCapturing)
                Picker(L("settings.language"), selection: $language) {
                    ForEach(languages) { entry in
                        Text(L(entry.key)).tag(entry.code)
                    }
                }
                Toggle(L("settings.resumeAutomatically"), isOn: $resumeAutomatically)
            } header: {
                Text(L("settings.capture"))
            } footer: {
                Text(L("settings.capture.footer"))
            }

            Section(L("settings.watch")) {
                NavigationLink {
                    WatchPairingView()
                } label: {
                    Label(L("settings.watch.manage"), systemImage: "applewatch")
                }
            }

            Section(L("settings.privacy")) {
                NavigationLink {
                    ConsentReviewView()
                } label: {
                    Label(L("settings.consents"), systemImage: "checkmark.shield")
                }
                Text(L("settings.privacy.footer"))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            Section {
                LabeledContent(L("settings.appVersion"), value: DeviceInfo.appVersion)
            }
        }
        .navigationTitle(L("settings.title"))
        .task { await model.refreshReader() }
        .onAppear {
            guard !loaded else { return }
            loaded = true
            transport = coordinator.settings.transportPreference
            language = coordinator.settings.languageHint ?? ""
            resumeAutomatically = coordinator.settings.resumeAutomatically
        }
        .onChange(of: transport) { _, value in
            coordinator.settings.transportPreference = value
            Task { await coordinator.applyTransportPolicy() }
        }
        .onChange(of: language) { _, value in
            coordinator.settings.languageHint = value.isEmpty ? nil : value
            model.watchBridge.pushContext()
        }
        .onChange(of: resumeAutomatically) { _, value in
            coordinator.settings.resumeAutomatically = value
        }
        .confirmationDialog(L("settings.unpair.confirm"), isPresented: $confirmUnpair, titleVisibility: .visible) {
            Button(L("settings.unpair"), role: .destructive) {
                model.watchBridge.unpairWatch()
                Task { await coordinator.unpair(purgeRoles: [.phone, .watch]) }
            }
        } message: {
            Text(L("settings.unpair.message"))
        }
    }
}
