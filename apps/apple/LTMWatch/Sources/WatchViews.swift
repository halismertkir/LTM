import LTMKit
import SwiftUI

/// Primary page: capture state, big start/stop, elapsed time, pending uploads, pause.
@MainActor
struct WatchMainView: View {
    @EnvironmentObject private var model: WatchModel
    @EnvironmentObject private var coordinator: CaptureCoordinator

    var body: some View {
        ScrollView {
            VStack(spacing: 8) {
                indicator
                if let since = coordinator.listeningSince {
                    Text(since, style: .timer)
                        .font(.system(.title3, design: .monospaced))
                }
                controls
                if coordinator.backlogCount > 0 {
                    Text(LF("watch.pending", coordinator.backlogCount))
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private var color: Color {
        switch coordinator.state {
        case .listening: return .red
        case .paused: return .orange
        case .error: return .yellow
        default: return .gray
        }
    }

    private var title: String {
        switch coordinator.state {
        case .listening: return L("watch.state.listening")
        case .paused(.server): return L("watch.state.pausedServer")
        case .paused: return L("watch.state.paused")
        case .idle: return L("watch.state.idle")
        case .notPaired: return L("watch.state.notPaired")
        case .consentRequired: return L("watch.state.consent")
        case .error: return L("watch.state.error")
        }
    }

    private var indicator: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(color)
                .frame(width: 14, height: 14)
                .accessibilityHidden(true)
            Text(title)
                .font(.headline)
                .multilineTextAlignment(.center)
        }
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var controls: some View {
        switch coordinator.state {
        case .idle:
            Button {
                Task { await model.start() }
            } label: {
                Label(L("watch.start"), systemImage: "mic.fill")
            }
            .tint(.red)
            .disabled(coordinator.isBusy)
        case .listening:
            Button(role: .destructive) {
                Task { await model.stop() }
            } label: {
                Label(L("watch.stop"), systemImage: "stop.fill")
            }
            Button {
                Task { await model.togglePause() }
            } label: {
                Label(L("watch.pause"), systemImage: "pause.fill")
            }
        case .paused(let reason):
            Button {
                Task { await model.togglePause() }
            } label: {
                Label(L("watch.resume"), systemImage: "play.fill")
            }
            .disabled(reason == .server)
            Button(role: .destructive) {
                Task { await model.stop() }
            } label: {
                Label(L("watch.stop"), systemImage: "stop.fill")
            }
        case .notPaired:
            Text(L("watch.help.pair"))
                .font(.footnote)
                .multilineTextAlignment(.center)
        case .consentRequired:
            Text(L("watch.help.consent"))
                .font(.footnote)
                .multilineTextAlignment(.center)
        case .error(let issue):
            Text(model.describe(issue))
                .font(.footnote)
                .multilineTextAlignment(.center)
            Button(L("watch.dismiss")) { coordinator.clearError() }
        }
    }
}

/// Second page: pairing status and the "tell people" reminder.
@MainActor
struct WatchInfoView: View {
    @EnvironmentObject private var model: WatchModel
    @EnvironmentObject private var coordinator: CaptureCoordinator

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                Text(L("watch.info.status"))
                    .font(.headline)
                Text(coordinator.isPaired ? L("watch.info.paired") : L("watch.info.notPaired"))
                    .font(.footnote)
                if let server = coordinator.server {
                    Text(server.host)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                if let access = coordinator.settings.deviceAccess {
                    Text(access == .memory ? L("watch.info.accessMemory") : L("watch.info.accessCapture"))
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                if coordinator.isIngestPaused {
                    Label(L("watch.state.pausedServer"), systemImage: "pause.circle")
                        .font(.footnote)
                        .foregroundStyle(.orange)
                }
                Text(model.phoneReachable ? L("watch.info.phoneReachable") : L("watch.info.phoneUnreachable"))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                if let lastSync = model.lastSync {
                    Text(LF("watch.info.lastSync", lastSync.formatted(date: .omitted, time: .shortened)))
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                Divider()

                Text(L("watch.info.tellPeople"))
                    .font(.headline)
                if let store = model.consentStore {
                    Text(store.spokenNotice(language: .current, thirdParty: ConsentStore.usesThirdPartyAI(coordinator.consentState)))
                        .font(.footnote)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
