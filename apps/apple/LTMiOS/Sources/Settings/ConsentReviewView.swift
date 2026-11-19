import LTMKit
import SwiftUI

/// Lists the consent documents with their accepted state; each can be read again and
/// withdrawn. Withdrawing stops capture immediately and the server pauses ingest.
@MainActor
struct ConsentReviewView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var coordinator: CaptureCoordinator
    @State private var pendingWithdraw: ConsentType?
    @State private var errorMessage: String?

    private var items: [ConsentItem] {
        guard let state = coordinator.consentState, let store = model.consentStore else { return [] }
        return store.requiredItems(for: state)
    }

    var body: some View {
        List {
            Section {
                Text(L("consentReview.intro"))
            }
            ForEach(items) { item in
                Section {
                    if let document = item.document {
                        let text = document.text(for: .current)
                        NavigationLink {
                            ScrollView {
                                VStack(alignment: .leading, spacing: 12) {
                                    Text(text.title).font(.title3.bold())
                                    MarkdownText(text.body)
                                }
                                .padding()
                            }
                            .navigationTitle(text.title)
                        } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(text.title)
                                Text(item.requirement.accepted ? LF("consentReview.accepted", item.requirement.version) : L("consentReview.notAccepted"))
                                    .font(.caption)
                                    .foregroundStyle(item.requirement.accepted ? Color.green : Color.orange)
                            }
                        }
                    } else {
                        Text(item.requirement.type.rawValue)
                    }
                    if item.requirement.accepted {
                        Button(L("consentReview.withdraw"), role: .destructive) {
                            pendingWithdraw = item.requirement.type
                        }
                    }
                }
            }
            if let errorMessage {
                Section { Text(errorMessage).foregroundStyle(.red) }
            }
        }
        .navigationTitle(L("settings.consents"))
        .refreshable { await coordinator.refresh() }
        .confirmationDialog(
            L("consentReview.withdraw.confirm"),
            isPresented: Binding(get: { pendingWithdraw != nil }, set: { if !$0 { pendingWithdraw = nil } }),
            titleVisibility: .visible
        ) {
            Button(L("consentReview.withdraw"), role: .destructive) {
                guard let type = pendingWithdraw else { return }
                Task { await withdraw(type) }
            }
        } message: {
            Text(L("consentReview.withdraw.message"))
        }
    }

    private func withdraw(_ type: ConsentType) async {
        errorMessage = nil
        do {
            try await coordinator.withdrawConsents([type])
        } catch {
            errorMessage = ErrorText.describe(error)
        }
    }
}
