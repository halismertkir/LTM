import LTMKit
import SwiftUI

/// Pairs the phone with a server: scan the QR code shown in the web app (Devices → Add
/// device) or type the server address and the code.
@MainActor
struct PairView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var coordinator: CaptureCoordinator
    @State private var serverText = ""
    @State private var codeText = ""
    @State private var showScanner = false
    @State private var errorMessage: String?
    @State private var acceptedInsecure = false

    private var parsedServer: ServerConfig? { ServerConfig.parse(serverText) }
    private var parsedCode: String? { PairingURI.normalizeCode(codeText, uppercase: true) }

    private var canPair: Bool {
        guard let server = parsedServer, parsedCode != nil, !coordinator.isBusy else { return false }
        return !server.needsInsecureWarning || acceptedInsecure
    }

    var body: some View {
        Form {
            Section {
                Text(L("pair.intro"))
                Button {
                    showScanner = true
                } label: {
                    Label(L("pair.scan"), systemImage: "qrcode.viewfinder")
                }
            }

            Section(L("pair.manual")) {
                TextField(L("pair.server.placeholder"), text: $serverText)
                    .keyboardType(.URL)
                    .textContentType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                TextField(L("pair.code.placeholder"), text: $codeText)
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()
            }

            if let server = parsedServer, !server.isSecure {
                Section {
                    if server.needsInsecureWarning {
                        Label(L("pair.insecure.remote"), systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(.orange)
                        Text(L("pair.ats.explanation"))
                            .font(.footnote)
                        Toggle(L("pair.insecure.accept"), isOn: $acceptedInsecure)
                    } else {
                        Label(L("pair.insecure.local"), systemImage: "wifi")
                        Text(L("pair.localNetwork.explanation"))
                            .font(.footnote)
                    }
                }
            }

            if let errorMessage {
                Section {
                    Text(errorMessage)
                        .foregroundStyle(.red)
                }
            }

            Section {
                Button {
                    Task { await pair() }
                } label: {
                    HStack {
                        Text(L("pair.button"))
                        if coordinator.isBusy {
                            Spacer()
                            ProgressView()
                        }
                    }
                }
                .disabled(!canPair)
            } footer: {
                Text(L("pair.footer"))
            }
        }
        .navigationTitle(L("pair.title"))
        .sheet(isPresented: $showScanner) {
            ScannerSheet { scanned in apply(scanned: scanned) }
        }
        .onAppear(perform: applyPendingURI)
        .onChange(of: model.pendingPairingURI) { _, _ in applyPendingURI() }
    }

    private func applyPendingURI() {
        guard let uri = model.pendingPairingURI else { return }
        model.pendingPairingURI = nil
        serverText = uri.server.originString
        codeText = uri.code
        errorMessage = nil
    }

    private func apply(scanned: String) {
        guard let uri = PairingURI.parse(scanned) else {
            errorMessage = L("pair.scan.invalid")
            return
        }
        serverText = uri.server.originString
        codeText = uri.code
        errorMessage = nil
    }

    private func pair() async {
        guard let server = parsedServer else {
            errorMessage = L("error.invalidServerURL")
            return
        }
        guard let code = parsedCode else {
            errorMessage = L("error.invalidPairingCode")
            return
        }
        errorMessage = nil
        let request = PairRequest(
            code: code,
            name: DeviceInfo.name,
            kind: .iphone,
            platform: DeviceInfo.platform,
            appVersion: DeviceInfo.appVersion
        )
        do {
            try await coordinator.pair(server: server, request: request)
        } catch {
            errorMessage = ErrorText.describe(error)
        }
    }
}
