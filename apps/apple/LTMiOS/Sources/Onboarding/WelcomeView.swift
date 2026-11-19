import SwiftUI

/// First screen: what LTM does and what it asks of the user, before anything is paired.
@MainActor
struct WelcomeView: View {
    let onContinue: () -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Image(systemName: "waveform.circle.fill")
                    .font(.system(size: 64))
                    .foregroundStyle(.tint)
                    .accessibilityHidden(true)
                Text(L("welcome.title"))
                    .font(.largeTitle.bold())
                Text(L("welcome.body"))
                    .font(.body)
                VStack(alignment: .leading, spacing: 12) {
                    point("server.rack", L("welcome.point.selfHosted"))
                    point("text.bubble", L("welcome.point.transcripts"))
                    point("lock.shield", L("welcome.point.privacy"))
                    point("person.2.wave.2", L("welcome.point.others"))
                }
                Button(action: onContinue) {
                    Text(L("welcome.continue"))
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .padding(.top, 8)
            }
            .padding(24)
        }
    }

    private func point(_ symbol: String, _ text: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: symbol)
                .frame(width: 28)
                .foregroundStyle(.tint)
                .accessibilityHidden(true)
            Text(text)
        }
    }
}
