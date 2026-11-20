import Foundation

/// A cursor-paged list with pull-to-refresh / load-more bookkeeping.
///
/// Every request is tagged with a generation; a response for an older generation (a
/// refresh or new search started meanwhile) is discarded, so a slow page can never
/// overwrite newer results.
public struct PagedList<Item: Identifiable & Decodable & Sendable & Equatable>: Sendable, Equatable where Item.ID == String {
    public private(set) var items: [Item] = []
    public private(set) var nextCursor: String?
    public private(set) var isLoading = false
    /// True once a page came back without a cursor.
    public private(set) var reachedEnd = false
    /// True after the first page arrived (distinguishes "empty" from "not loaded").
    public private(set) var loaded = false
    public private(set) var error: LTMError?
    private var generation = 0
    private var inFlight: Int?

    public init() {}

    /// Starts a refresh (first page). Returns the generation to pass back with the result.
    public mutating func beginRefresh() -> Int {
        generation += 1
        inFlight = generation
        isLoading = true
        error = nil
        return generation
    }

    /// Starts loading the next page, or returns nil when there is nothing (more) to load.
    public mutating func beginLoadMore() -> (generation: Int, cursor: String)? {
        guard !isLoading, !reachedEnd, loaded, let cursor = nextCursor else { return nil }
        inFlight = generation
        isLoading = true
        error = nil
        return (generation, cursor)
    }

    /// Applies a page. `replace` is true for the first page of a refresh.
    @discardableResult
    public mutating func apply(_ page: Page<Item>, generation: Int, replace: Bool) -> Bool {
        guard generation == self.generation, inFlight == generation else { return false }
        if replace {
            items = Self.unique(page.items)
        } else {
            let known = Set(items.map(\.id))
            items.append(contentsOf: Self.unique(page.items).filter { !known.contains($0.id) })
        }
        nextCursor = page.nextCursor
        reachedEnd = page.nextCursor == nil
        loaded = true
        isLoading = false
        inFlight = nil
        return true
    }

    public mutating func fail(_ error: LTMError, generation: Int) {
        guard generation == self.generation else { return }
        self.error = error
        isLoading = false
        inFlight = nil
    }

    /// Replaces an item in place, or inserts it (at the front, or sorted with `before`).
    public mutating func upsert(_ item: Item, insertIfMissing: Bool = true, before: ((Item, Item) -> Bool)? = nil) {
        if let index = items.firstIndex(where: { $0.id == item.id }) {
            items[index] = item
        } else if insertIfMissing {
            if let before, let index = items.firstIndex(where: { before(item, $0) }) {
                items.insert(item, at: index)
            } else if before != nil {
                items.append(item)
            } else {
                items.insert(item, at: 0)
            }
        }
    }

    public mutating func remove(id: String) {
        items.removeAll { $0.id == id }
    }

    public mutating func update(id: String, _ body: (inout Item) -> Void) {
        guard let index = items.firstIndex(where: { $0.id == id }) else { return }
        body(&items[index])
    }

    private static func unique(_ items: [Item]) -> [Item] {
        var seen = Set<String>()
        return items.filter { seen.insert($0.id).inserted }
    }

    public static func == (lhs: PagedList, rhs: PagedList) -> Bool {
        lhs.items == rhs.items && lhs.nextCursor == rhs.nextCursor && lhs.isLoading == rhs.isLoading
            && lhs.reachedEnd == rhs.reachedEnd && lhs.loaded == rhs.loaded && lhs.error == rhs.error
    }
}

/// A value that is loaded on demand and refreshed by pulling.
public enum Loadable<Value: Sendable & Equatable>: Sendable, Equatable {
    case idle
    case loading(previous: Value?)
    case loaded(Value)
    case failed(LTMError, previous: Value?)

    public var value: Value? {
        switch self {
        case .idle: return nil
        case .loading(let previous): return previous
        case .loaded(let value): return value
        case .failed(_, let previous): return previous
        }
    }

    public var isLoading: Bool {
        if case .loading = self { return true }
        return false
    }

    public var error: LTMError? {
        if case .failed(let error, _) = self { return error }
        return nil
    }
}

/// Which time span a question to `/ask` covers.
public enum AskScope: String, Sendable, CaseIterable, Equatable {
    case today
    case week
    case all

    /// `(from, to)` in epoch ms. `all` sends neither.
    public func range(now: Date, timeZone: TimeZone = .current) -> (from: Int64?, to: Int64?) {
        switch self {
        case .today:
            return (EpochMs.from(DayDate.startOfDay(now, timeZone: timeZone)), nil)
        case .week:
            return (EpochMs.from(now.addingTimeInterval(-7 * 24 * 3_600)), nil)
        case .all:
            return (nil, nil)
        }
    }
}

/// One question and its answer in the Ask thread.
public struct AskTurn: Sendable, Equatable, Identifiable {
    public let id: String
    public var question: String
    public var scope: AskScope
    public var answer: AskResponse?
    public var error: LTMError?
    public var isLoading: Bool

    public init(id: String = UUID().uuidString, question: String, scope: AskScope, answer: AskResponse? = nil, error: LTMError? = nil, isLoading: Bool = false) {
        self.id = id
        self.question = question
        self.scope = scope
        self.answer = answer
        self.error = error
        self.isLoading = isLoading
    }
}

public enum Citations {
    /// The 1-based citation numbers that occur as `[n]` (also `[1, 3]` / `[2][4]`) in an
    /// answer, in first-use order, limited to existing citations.
    public static func referenced(in answer: String, count: Int) -> [Int] {
        var result: [Int] = []
        var seen = Set<Int>()
        var index = answer.startIndex
        while let open = answer[index...].firstIndex(of: "[") {
            guard let close = answer[open...].firstIndex(of: "]") else { break }
            let inner = answer[answer.index(after: open)..<close]
            let numbers = inner.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
            if !numbers.isEmpty, numbers.allSatisfy({ Int($0) != nil }) {
                for number in numbers.compactMap({ Int($0) }) where (1...max(count, 1)).contains(number) && count > 0 {
                    if seen.insert(number).inserted { result.append(number) }
                }
            }
            index = answer.index(after: close)
        }
        return result
    }

    /// Where tapping a citation should lead.
    public enum Target: Sendable, Equatable {
        case conversation(id: String)
        case memory(id: String)
        case none
    }

    public static func target(of hit: SearchHit) -> Target {
        switch hit.type {
        case .conversation:
            return .conversation(id: hit.id)
        case .utterance:
            return hit.conversationId.map { .conversation(id: $0) } ?? .none
        case .memory:
            return .memory(id: hit.id)
        default:
            return hit.conversationId.map { .conversation(id: $0) } ?? .none
        }
    }
}

/// Splits Markdown into blocks the UI can render one by one. SwiftUI's `Text` renders
/// only inline Markdown (bold, italic, code, links) and flattens headings, lists and
/// paragraphs into one run, so block structure is handled here and each block's text is
/// rendered as inline Markdown (falling back to plain text if that fails).
public enum MarkdownBlocks {
    public enum Block: Sendable, Equatable {
        case heading(level: Int, text: String)
        case bullet(text: String, depth: Int)
        case numbered(number: Int, text: String)
        case quote(text: String)
        case code(text: String)
        case paragraph(text: String)
        case rule
    }

    public static func parse(_ markdown: String) -> [Block] {
        var blocks: [Block] = []
        var paragraph: [String] = []
        var code: [String]?

        func flushParagraph() {
            if !paragraph.isEmpty {
                blocks.append(.paragraph(text: paragraph.joined(separator: " ")))
                paragraph.removeAll()
            }
        }

        for rawLine in markdown.components(separatedBy: .newlines) {
            if var lines = code {
                if rawLine.trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                    blocks.append(.code(text: lines.joined(separator: "\n")))
                    code = nil
                } else {
                    lines.append(rawLine)
                    code = lines
                }
                continue
            }
            let line = rawLine.trimmingCharacters(in: .whitespaces)
            if line.isEmpty {
                flushParagraph()
                continue
            }
            if line.hasPrefix("```") {
                flushParagraph()
                code = []
                continue
            }
            if let heading = headingLevel(line) {
                flushParagraph()
                blocks.append(.heading(level: heading.level, text: heading.text))
                continue
            }
            if line == "---" || line == "***" || line == "___" {
                flushParagraph()
                blocks.append(.rule)
                continue
            }
            if line.hasPrefix("- ") || line.hasPrefix("* ") || line.hasPrefix("+ ") {
                flushParagraph()
                let indent = rawLine.prefix { $0 == " " }.count
                blocks.append(.bullet(text: String(line.dropFirst(2)).trimmingCharacters(in: .whitespaces), depth: indent / 2))
                continue
            }
            if let numbered = numberedItem(line) {
                flushParagraph()
                blocks.append(.numbered(number: numbered.number, text: numbered.text))
                continue
            }
            if line.hasPrefix(">") {
                flushParagraph()
                blocks.append(.quote(text: String(line.dropFirst()).trimmingCharacters(in: .whitespaces)))
                continue
            }
            paragraph.append(line)
        }
        if let lines = code { blocks.append(.code(text: lines.joined(separator: "\n"))) }
        flushParagraph()
        return blocks
    }

    private static func headingLevel(_ line: String) -> (level: Int, text: String)? {
        let hashes = line.prefix { $0 == "#" }.count
        guard (1...6).contains(hashes) else { return nil }
        let rest = line.dropFirst(hashes)
        guard rest.first == " " else { return nil }
        return (hashes, rest.trimmingCharacters(in: .whitespaces))
    }

    private static func numberedItem(_ line: String) -> (number: Int, text: String)? {
        let digits = line.prefix { $0.isASCII && $0.isNumber }
        guard !digits.isEmpty, digits.count <= 3, let number = Int(digits) else { return nil }
        let rest = line.dropFirst(digits.count)
        guard rest.hasPrefix(". ") || rest.hasPrefix(") ") else { return nil }
        return (number, rest.dropFirst(2).trimmingCharacters(in: .whitespaces))
    }
}
