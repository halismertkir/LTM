import Foundation

/// The canonical consent documents and notice templates, decoded from the bundled
/// `packages/protocol/consent/consent.v1.json` (copied into each app bundle by the
/// project spec — the texts are never duplicated in Swift).
public struct ConsentCatalog: Decodable, Sendable, Equatable {
    public struct Text: Decodable, Sendable, Equatable {
        public var title: String
        /// Markdown.
        public var body: String
    }

    public struct Document: Decodable, Sendable, Equatable, Identifiable {
        public var type: ConsentType
        public var version: String
        /// "always" or "third_party_provider".
        public var requiredWhen: String
        public var en: Text
        public var tr: Text

        public var id: String { type.rawValue }

        public func text(for language: UILanguage) -> Text {
            language == .tr ? tr : en
        }
    }

    public struct Localized: Decodable, Sendable, Equatable {
        public var en: String
        public var tr: String

        public func text(for language: UILanguage) -> String {
            language == .tr ? tr : en
        }
    }

    public struct Notices: Decodable, Sendable, Equatable {
        /// To read aloud in a face-to-face conversation.
        public var spoken: Localized
        /// To paste into a meeting chat.
        public var meetingChat: Localized
        /// Extra sentence when a third-party AI provider is in use.
        public var thirdPartyAi: Localized
    }

    public var documents: [Document]
    public var notices: Notices

    public static let resourceName = "consent.v1"

    public static func decode(_ data: Data) throws -> ConsentCatalog {
        try LTMJSON.decode(ConsentCatalog.self, from: data)
    }

    /// Loads the catalog from an app bundle (`consent.v1.json` at the bundle root).
    public static func load(from bundle: Bundle = .main) throws -> ConsentCatalog {
        guard let url = bundle.url(forResource: resourceName, withExtension: "json") else {
            throw LTMError.decoding("consent.v1.json missing from bundle")
        }
        return try decode(Data(contentsOf: url))
    }

    public func document(_ type: ConsentType) -> Document? {
        documents.first { $0.type == type }
    }
}

/// The two UI languages the clients ship. Everything else falls back to English.
public enum UILanguage: String, Sendable, Equatable {
    case en
    case tr

    /// The language the app UI is actually shown in (the bundle's chosen localization).
    public static var current: UILanguage {
        let preferred = Bundle.main.preferredLocalizations.first ?? "en"
        return preferred.lowercased().hasPrefix("tr") ? .tr : .en
    }
}

/// One document the user has to (re-)accept, joined with the server's requirement.
public struct ConsentItem: Sendable, Equatable, Identifiable {
    public var requirement: ConsentRequirement
    /// The bundled document of the same type, if this build has it.
    public var document: ConsentCatalog.Document?

    public var id: String { requirement.type.rawValue }

    /// True when the bundled text is exactly the version the server asks for. If not,
    /// the app must not accept on the user's behalf (they would accept a text they never
    /// saw) and points them to an app update or the web app instead.
    public var isShowable: Bool { document?.version == requirement.version }
}

/// Joins the server's consent state with the bundled texts.
public struct ConsentStore: Sendable {
    public let catalog: ConsentCatalog

    public init(catalog: ConsentCatalog) {
        self.catalog = catalog
    }

    public static func bundled(_ bundle: Bundle = .main) -> ConsentStore? {
        guard let catalog = try? ConsentCatalog.load(from: bundle) else { return nil }
        return ConsentStore(catalog: catalog)
    }

    /// Every document the server currently requires, in server order.
    public func requiredItems(for state: ConsentState) -> [ConsentItem] {
        state.required.map { ConsentItem(requirement: $0, document: catalog.document($0.type)) }
    }

    /// Only those not yet accepted at the current version.
    public func outstandingItems(for state: ConsentState) -> [ConsentItem] {
        requiredItems(for: state).filter { !$0.requirement.accepted }
    }

    /// Notice text to read aloud, with the third-party sentence when that consent applies.
    public func spokenNotice(language: UILanguage, thirdParty: Bool) -> String {
        compose(catalog.notices.spoken.text(for: language), thirdParty: thirdParty, language: language)
    }

    public func meetingChatNotice(language: UILanguage, thirdParty: Bool) -> String {
        compose(catalog.notices.meetingChat.text(for: language), thirdParty: thirdParty, language: language)
    }

    private func compose(_ base: String, thirdParty: Bool, language: UILanguage) -> String {
        guard thirdParty else { return base }
        return base + " " + catalog.notices.thirdPartyAi.text(for: language)
    }

    /// True when the server requires the third-party AI document (an external provider is configured).
    public static func usesThirdPartyAI(_ state: ConsentState?) -> Bool {
        state?.required.contains { $0.type == .thirdPartyAI } ?? false
    }
}
