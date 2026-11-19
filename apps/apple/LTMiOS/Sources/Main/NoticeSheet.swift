import LTMKit
import SwiftUI
import UIKit

/// "Tell people you're recording": the canonical notice templates from consent.v1.json,
/// ready to read aloud or paste into a meeting chat.
@MainActor
struct NoticeSheet: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var coordinator: CaptureCoordinator
    @Environment(\.dismiss) private var dismiss
    @State private var language: UILanguage = .current
    @State private var copied: String?

    private var thirdParty: Bool { ConsentStore.usesThirdPartyAI(coordinator.consentState) }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text(L("notice.intro"))
                    Picker(L("notice.language"), selection: $language) {
                        Text("English").tag(UILanguage.en)
                        Text("Türkçe").tag(UILanguage.tr)
                    }
                    .pickerStyle(.segmented)
                }
                if let store = model.consentStore {
                    noticeSection(title: L("notice.spoken"), text: store.spokenNotice(language: language, thirdParty: thirdParty))
                    noticeSection(title: L("notice.meetingChat"), text: store.meetingChatNotice(language: language, thirdParty: thirdParty))
                } else {
                    Text(L("consent.bundleMissing")).foregroundStyle(.red)
                }
            }
            .navigationTitle(L("notice.title"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(L("common.done")) { dismiss() }
                }
            }
        }
    }

    private func noticeSection(title: String, text: String) -> some View {
        Section(title) {
            Text(text)
                .font(.body)
                .textSelection(.enabled)
            HStack {
                Button {
                    UIPasteboard.general.string = text
                    copied = title
                } label: {
                    Label(copied == title ? L("notice.copied") : L("notice.copy"), systemImage: "doc.on.doc")
                }
                .buttonStyle(.borderless)
                Spacer()
                ShareLink(item: text) {
                    Label(L("notice.share"), systemImage: "square.and.arrow.up")
                }
                .buttonStyle(.borderless)
            }
        }
    }
}
