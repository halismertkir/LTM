import XCTest
@testable import LTMKit

/// Decodes the canonical `packages/protocol/consent/consent.v1.json` straight from the
/// repository (the apps bundle the same file), so a schema change there breaks this test.
final class ConsentTests: XCTestCase {
    private func loadCatalog() throws -> ConsentCatalog {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 { url.deleteLastPathComponent() } // → repository root
        url.appendPathComponent("packages/protocol/consent/consent.v1.json")
        return try ConsentCatalog.decode(Data(contentsOf: url))
    }

    func testDecodesCanonicalFile() throws {
        let catalog = try loadCatalog()
        XCTAssertEqual(catalog.documents.map(\.type), [.recordingResponsibility, .dataProcessing, .thirdPartyAI])
        for document in catalog.documents {
            XCTAssertFalse(document.version.isEmpty)
            XCTAssertGreaterThan(document.en.body.count, 200)
            XCTAssertGreaterThan(document.tr.body.count, 200)
            XCTAssertNotEqual(document.text(for: .en).title, document.text(for: .tr).title)
        }
        XCTAssertEqual(catalog.document(.thirdPartyAI)?.requiredWhen, "third_party_provider")
        XCTAssertTrue(catalog.notices.spoken.tr.contains("kaydeden"))
    }

    func testRequiredItemsFollowTheServer() throws {
        let catalog = try loadCatalog()
        let store = ConsentStore(catalog: catalog)
        let current = try XCTUnwrap(catalog.document(.dataProcessing)?.version)
        let state = ConsentState(satisfied: false, required: [
            ConsentRequirement(type: .recordingResponsibility, version: current, accepted: true),
            ConsentRequirement(type: .dataProcessing, version: current, accepted: false),
            ConsentRequirement(type: .thirdPartyAI, version: "2099-01-01", accepted: false),
        ])
        let items = store.requiredItems(for: state)
        XCTAssertEqual(items.map(\.id), ["recording_responsibility", "data_processing", "third_party_ai"])
        XCTAssertEqual(store.outstandingItems(for: state).map(\.id), ["data_processing", "third_party_ai"])
        XCTAssertTrue(items[1].isShowable)
        XCTAssertFalse(items[2].isShowable, "a newer server version than the bundled text must not be accepted from the app")
        XCTAssertTrue(ConsentStore.usesThirdPartyAI(state))
    }

    func testNoticesAppendThirdPartySentence() throws {
        let store = ConsentStore(catalog: try loadCatalog())
        let plain = store.spokenNotice(language: .en, thirdParty: false)
        let withAI = store.spokenNotice(language: .en, thirdParty: true)
        XCTAssertEqual(plain, store.catalog.notices.spoken.en)
        XCTAssertTrue(withAI.hasPrefix(plain))
        XCTAssertTrue(withAI.hasSuffix(store.catalog.notices.thirdPartyAi.en))
        XCTAssertEqual(store.meetingChatNotice(language: .tr, thirdParty: false), store.catalog.notices.meetingChat.tr)
    }
}
