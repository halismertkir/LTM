import LTMKit
import SwiftUI

/// The capture screen: an unmistakable state indicator, start/pause/stop, elapsed time,
/// upload backlog, the latest caption, and the transcription-mode switch.
@MainActor
struct MainView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var coordinator: CaptureCoordinator
    @State private var showNotice = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 24) {
                    StateIndicator(state: coordinator.state)
                        .padding(.top, 16)

                    if let since = coordinator.listeningSince {
                        Text(since, style: .timer)
                            .font(.system(.title, design: .monospaced).weight(.semibold))
                            .accessibilityLabel(L("main.elapsed"))
                    }

                    controls

                    if coordinator.isInterrupted {
                        Banner(symbol: "phone.fill", text: L("main.interrupted"), tint: .orange)
                    }
                    if let reason = coordinator.uploadsPausedReason {
                        Banner(symbol: "icloud.slash", text: reason == .consentRequired ? L("main.uploads.consent") : L("main.uploads.paused"), tint: .orange)
                    }
                    if let error = coordinator.lastError, !coordinator.state.isCapturing {
                        Banner(symbol: "exclamationmark.triangle", text: ErrorText.describe(error), tint: Color.secondary)
                    }

                    captionCard

                    VStack(alignment: .leading, spacing: 8) {
                        Picker(L("main.transcription"), selection: $coordinator.transcriptionMode) {
                            Text(L("mode.server")).tag(TranscriptionMode.server)
                            Text(L("mode.onDevice")).tag(TranscriptionMode.onDevice)
                        }
                        .pickerStyle(.segmented)
                        .disabled(coordinator.state.isCapturing || isPaused)
                        Text(coordinator.transcriptionMode == .server ? L("main.mode.server.hint") : L("main.mode.onDevice.hint"))
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }

                    HStack {
                        Label(LF("main.backlog", coordinator.backlogCount), systemImage: "tray.and.arrow.up")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                        Spacer()
                        if case .listening(let mode) = coordinator.state {
                            Text(mode.transport == .live ? L("main.transport.live") : L("main.transport.chunks"))
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                .padding(20)
            }
            .navigationTitle("LTM")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        showNotice = true
                    } label: {
                        Label(L("notice.button"), systemImage: "person.wave.2")
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    NavigationLink {
                        SettingsView()
                    } label: {
                        Label(L("settings.title"), systemImage: "gearshape")
                    }
                }
            }
            .sheet(isPresented: $showNotice) {
                NoticeSheet()
            }
            .refreshable { await coordinator.refresh() }
        }
    }

    private var isPaused: Bool {
        if case .paused = coordinator.state { return true }
        return false
    }

    @ViewBuilder
    private var controls: some View {
        switch coordinator.state {
        case .idle:
            Button {
                Task { await coordinator.start() }
            } label: {
                Label(L("main.start"), systemImage: "mic.fill").frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(coordinator.isBusy)
        case .listening:
            HStack(spacing: 12) {
                Button {
                    Task { await coordinator.pause() }
                } label: {
                    Label(L("main.pause"), systemImage: "pause.fill").frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .controlSize(.large)
                Button(role: .destructive) {
                    Task { await coordinator.stop() }
                } label: {
                    Label(L("main.stop"), systemImage: "stop.fill").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
            }
        case .paused(let reason):
            VStack(spacing: 8) {
                if reason == .server {
                    Text(L("main.pausedByServer")).font(.footnote).multilineTextAlignment(.center)
                }
                HStack(spacing: 12) {
                    Button {
                        Task { await coordinator.resume() }
                    } label: {
                        Label(L("main.resume"), systemImage: "play.fill").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .disabled(reason == .server)
                    Button(role: .destructive) {
                        Task { await coordinator.stop() }
                    } label: {
                        Label(L("main.stop"), systemImage: "stop.fill").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.large)
                }
            }
        case .error(let issue):
            VStack(spacing: 12) {
                Text(ErrorText.describe(issue))
                    .multilineTextAlignment(.center)
                switch issue {
                case .unauthorized:
                    Button(L("main.pairAgain")) {
                        Task { await coordinator.unpair(purgeRoles: [.phone, .watch]) }
                    }
                    .buttonStyle(.borderedProminent)
                case .onDeviceRecognitionUnavailable:
                    Button(L("permissions.useServer")) {
                        coordinator.transcriptionMode = .server
                        coordinator.clearError()
                    }
                    .buttonStyle(.borderedProminent)
                    Button(L("common.dismiss")) { coordinator.clearError() }
                default:
                    Button(L("common.dismiss")) { coordinator.clearError() }
                        .buttonStyle(.bordered)
                }
            }
        case .notPaired, .consentRequired:
            EmptyView()
        }
    }

    private var captionCard: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(L("main.caption"))
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            Text(coordinator.liveCaption ?? L("main.caption.empty"))
                .font(.body)
                .lineLimit(3)
                .frame(maxWidth: .infinity, alignment: .leading)
                .foregroundStyle(coordinator.liveCaption == nil ? Color.secondary : Color.primary)
        }
        .padding(14)
        .background(Color.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
    }
}

/// Big, colour + symbol + word, so the state is clear at a glance and without colour.
@MainActor
struct StateIndicator: View {
    let state: CaptureState

    private var color: Color {
        switch state {
        case .listening: return .red
        case .paused: return .orange
        case .error: return .yellow
        default: return .gray
        }
    }

    private var symbol: String {
        switch state {
        case .listening: return "waveform"
        case .paused: return "pause.fill"
        case .error: return "exclamationmark.triangle.fill"
        default: return "mic.slash.fill"
        }
    }

    private var title: String {
        switch state {
        case .listening: return L("state.listening")
        case .paused(.server): return L("state.pausedServer")
        case .paused: return L("state.paused")
        case .error: return L("state.error")
        case .idle: return L("state.idle")
        case .notPaired: return L("state.notPaired")
        case .consentRequired: return L("state.consentRequired")
        }
    }

    var body: some View {
        ZStack {
            Circle()
                .fill(color.opacity(0.15))
            Circle()
                .strokeBorder(color, lineWidth: 6)
            VStack(spacing: 8) {
                Image(systemName: symbol)
                    .font(.system(size: 54, weight: .bold))
                Text(title)
                    .font(.title2.bold())
                    .multilineTextAlignment(.center)
            }
            .foregroundStyle(color)
            .padding(24)
        }
        .frame(width: 220, height: 220)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(title)
    }
}

@MainActor
struct Banner: View {
    let symbol: String
    let text: String
    let tint: Color

    var body: some View {
        Label(text, systemImage: symbol)
            .font(.footnote)
            .foregroundStyle(tint)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .background(tint.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
    }
}
