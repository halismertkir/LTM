import LTMKit
import SwiftUI

/// Shows every consent document the server requires, each with its own explicit,
/// initially unchecked toggle. Nothing is captured before all of them are accepted.
@MainActor
struct ConsentView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var coordinator: CaptureCoordinator
    @State private var agreed: Set<String> = []
    @State private var errorMessage: String?
    @State private var confirmUnpair = false

    private var language: UILanguage { .current }

    private var items: [ConsentItem] {
        guard let state = coordinator.consentState, let store = model.consentStore else { return [] }
        return store.outstandingItems(for: state)
    }

    private var canAccept: Bool {
        !items.isEmpty
            && items.allSatisfy { $0.isShowable && agreed.contains($0.id) }
            && !coordinator.isBusy
    }

    var body: some View {
        List {
            Section {
                Text(L("consent.intro"))
            }

            if coordinator.consentState == nil {
                Section {
                    Text(L("consent.loading"))
                    Button(L("common.retry")) { Task { await coordinator.refresh() } }
                    if let error = coordinator.lastError {
                        Text(ErrorText.describe(error)).foregroundStyle(.red)
                    }
                }
            } else if model.consentStore == nil {
                Section {
                    Text(L("consent.bundleMissing")).foregroundStyle(.red)
                }
            }

            ForEach(items) { item in
                Section {
                    if let document = item.document, item.isShowable {
                        let text = document.text(for: language)
                        Text(text.title).font(.headline)
                        MarkdownText(text.body)
                        Toggle(isOn: binding(for: item.id)) {
                            Text(L("consent.agree"))
                                .font(.subheadline.weight(.semibold))
                        }
                    } else {
                        Text(LF("consent.versionMismatch", item.requirement.type.rawValue, item.requirement.version))
                            .foregroundStyle(.orange)
                    }
                }
            }

            if let errorMessage {
                Section { Text(errorMessage).foregroundStyle(.red) }
            }

            Section {
                Button {
                    Task { await accept() }
                } label: {
                    Text(L("consent.accept"))
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .disabled(!canAccept)
            } footer: {
                Text(L("consent.footer"))
            }

            Section {
                Button(L("settings.unpair"), role: .destructive) { confirmUnpair = true }
            }
        }
        .navigationTitle(L("consent.title"))
        .refreshable { await coordinator.refresh() }
        .confirmationDialog(L("settings.unpair.confirm"), isPresented: $confirmUnpair, titleVisibility: .visible) {
            Button(L("settings.unpair"), role: .destructive) {
                Task { await coordinator.unpair(purgeRoles: [.phone, .watch]) }
            }
        }
    }

    private func binding(for id: String) -> Binding<Bool> {
        Binding(
            get: { agreed.contains(id) },
            set: { isOn in
                if isOn { agreed.insert(id) } else { agreed.remove(id) }
            }
        )
    }

    private func accept() async {
        errorMessage = nil
        let accepted = items.filter { agreed.contains($0.id) }.map {
            ConsentAccept.Item(type: $0.requirement.type, version: $0.requirement.version)
        }
        do {
            try await coordinator.acceptConsents(accepted)
        } catch {
            errorMessage = ErrorText.describe(error)
        }
    }
}

/// Renders the consent Markdown (bold, lists as written) without a web view.
@MainActor
struct MarkdownText: View {
    let markdown: String

    init(_ markdown: String) {
        self.markdown = markdown
    }

    var body: some View {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        let attributed = (try? AttributedString(markdown: markdown, options: options)) ?? AttributedString(markdown)
        Text(attributed)
            .font(.callout)
            .textSelection(.enabled)
    }
}
