import LTMKit
import SwiftUI
import UIKit

/// Microphone permission (always) and speech-recognition permission (only when the user
/// chooses on-device transcription), each with an honest explanation first.
@MainActor
struct PermissionsView: View {
    @EnvironmentObject private var coordinator: CaptureCoordinator
    let onDone: () -> Void
    @State private var micGranted = PhoneCaptureEngine.microphoneGranted
    @State private var micDenied = false
    @State private var speechGranted = PhoneCaptureEngine.speechAuthorized
    @State private var speechDenied = false
    @State private var onDeviceUnsupported = false

    var body: some View {
        Form {
            Section {
                Label(L("permissions.mic.title"), systemImage: "mic.fill")
                    .font(.headline)
                Text(L("permissions.mic.body"))
                if micGranted {
                    Label(L("permissions.granted"), systemImage: "checkmark.circle.fill").foregroundStyle(.green)
                } else {
                    Button(L("permissions.mic.allow")) { Task { await requestMic() } }
                    if micDenied {
                        Text(L("issue.microphoneDenied")).foregroundStyle(.red)
                        settingsLink
                    }
                }
            }

            Section {
                Picker(L("main.transcription"), selection: $coordinator.transcriptionMode) {
                    Text(L("mode.server")).tag(TranscriptionMode.server)
                    Text(L("mode.onDevice")).tag(TranscriptionMode.onDevice)
                }
                .pickerStyle(.segmented)
                Text(coordinator.transcriptionMode == .server ? L("permissions.mode.server") : L("permissions.mode.onDevice"))
                    .font(.footnote)
                if coordinator.transcriptionMode == .onDevice {
                    if onDeviceUnsupported {
                        Text(LF("issue.onDeviceUnavailable", coordinator.settings.languageHint ?? Locale.current.identifier))
                            .foregroundStyle(.orange)
                        Button(L("permissions.useServer")) { coordinator.transcriptionMode = .server }
                    } else if speechGranted {
                        Label(L("permissions.granted"), systemImage: "checkmark.circle.fill").foregroundStyle(.green)
                    } else {
                        Text(L("permissions.speech.body"))
                        Button(L("permissions.speech.allow")) { Task { await requestSpeech() } }
                        if speechDenied {
                            Text(L("issue.speechDenied")).foregroundStyle(.red)
                            settingsLink
                        }
                    }
                }
            } header: {
                Text(L("permissions.mode.title"))
            }

            Section {
                Button {
                    onDone()
                } label: {
                    Text(L("common.continue")).frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .disabled(!micGranted || (coordinator.transcriptionMode == .onDevice && (!speechGranted || onDeviceUnsupported)))
            }
        }
        .navigationTitle(L("permissions.title"))
        .onAppear(perform: checkOnDeviceSupport)
        .onChange(of: coordinator.transcriptionMode) { _, _ in checkOnDeviceSupport() }
    }

    private var settingsLink: some View {
        Group {
            if let url = URL(string: UIApplication.openSettingsURLString) {
                Link(L("common.openSettings"), destination: url)
            }
        }
    }

    private func checkOnDeviceSupport() {
        guard coordinator.transcriptionMode == .onDevice else {
            onDeviceUnsupported = false
            return
        }
        onDeviceUnsupported = !PhoneCaptureEngine.onDeviceRecognitionSupported(languageHint: coordinator.settings.languageHint)
    }

    private func requestMic() async {
        micGranted = await PhoneCaptureEngine.requestMicrophone()
        micDenied = !micGranted
    }

    private func requestSpeech() async {
        speechGranted = await PhoneCaptureEngine.requestSpeech()
        speechDenied = !speechGranted
    }
}
