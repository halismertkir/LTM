import LTMKit
import SwiftUI

/// Pairs the Apple Watch as its own LTM device with a second pairing code.
@MainActor
struct WatchPairingView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var coordinator: CaptureCoordinator
    @EnvironmentObject private var bridge: PhoneWatchBridge
    @State private var code = ""
    @State private var showScanner = false
    @State private var message: String?
    @State private var messageIsError = false
    @State private var confirmUnpair = false

    var body: some View {
        Form {
            Section(L("watch.status")) {
                statusRow(L("watch.status.app"), ok: bridge.isWatchAppInstalled)
                statusRow(L("watch.status.reachable"), ok: bridge.isReachable)
                statusRow(L("watch.status.paired"), ok: bridge.isWatchPaired)
            }

            if bridge.isWatchPaired {
                Section {
                    Text(L("watch.paired.body"))
                    Button(L("watch.unpair"), role: .destructive) { confirmUnpair = true }
                }
            } else {
                Section {
                    Text(L("watch.howTo"))
                        .font(.callout)
                    Button {
                        showScanner = true
                    } label: {
                        Label(L("watch.scan"), systemImage: "qrcode.viewfinder")
                    }
                    TextField(L("pair.code.placeholder"), text: $code)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                    Button {
                        Task { await pair() }
                    } label: {
                        HStack {
                            Text(L("watch.pair"))
                            if bridge.isPairing {
                                Spacer()
                                ProgressView()
                            }
                        }
                    }
                    .disabled(PairingURI.normalizeCode(code, uppercase: true) == nil || bridge.isPairing || coordinator.server == nil)
                } footer: {
                    Text(L("watch.footer"))
                }
            }

            if let message {
                Section {
                    Text(message).foregroundStyle(messageIsError ? Color.red : Color.green)
                }
            }
        }
        .navigationTitle(L("watch.title"))
        .onAppear {
            bridge.refreshStatus()
            applyPendingURI()
        }
        .onChange(of: model.pendingPairingURI) { _, _ in applyPendingURI() }
        .sheet(isPresented: $showScanner) {
            ScannerSheet { scanned in apply(scanned: scanned) }
        }
        .confirmationDialog(L("watch.unpair.confirm"), isPresented: $confirmUnpair, titleVisibility: .visible) {
            Button(L("watch.unpair"), role: .destructive) { bridge.unpairWatch() }
        } message: {
            Text(L("watch.unpair.message"))
        }
    }

    private func statusRow(_ title: String, ok: Bool) -> some View {
        HStack {
            Text(title)
            Spacer()
            Image(systemName: ok ? "checkmark.circle.fill" : "xmark.circle")
                .foregroundStyle(ok ? Color.green : Color.secondary)
                .accessibilityLabel(ok ? L("common.yes") : L("common.no"))
        }
    }

    /// An `ltm://pair` link opened while this iPhone is already paired is a code for the watch.
    private func applyPendingURI() {
        guard let uri = model.pendingPairingURI, !bridge.isWatchPaired else { return }
        model.pendingPairingURI = nil
        apply(uri: uri)
    }

    private func apply(scanned: String) {
        guard let uri = PairingURI.parse(scanned) else {
            showMessage(L("pair.scan.invalid"), error: true)
            return
        }
        apply(uri: uri)
    }

    private func apply(uri: PairingURI) {
        guard uri.server == coordinator.server else {
            showMessage(L("watch.serverMismatch"), error: true)
            return
        }
        code = uri.code
        message = nil
    }

    private func pair() async {
        message = nil
        do {
            try await bridge.pairWatch(code: code)
            code = ""
            showMessage(L("watch.pair.success"), error: false)
        } catch {
            showMessage(ErrorText.describe(error), error: true)
        }
    }

    private func showMessage(_ text: String, error: Bool) {
        message = text
        messageIsError = error
    }
}
