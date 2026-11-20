import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// The reader routes a device paired with `access: "memory"` may call (`DEVICE_ROUTES`).
/// A protocol so view models can be tested against a fake.
public protocol MemoryAPI: Sendable {
    func deviceSelf() async throws -> Device
    func conversations(query: String?, from: Int64?, to: Int64?, limit: Int, cursor: String?) async throws -> Page<ConversationSummary>
    func conversation(id: String) async throws -> ConversationDetail
    func updateActionItem(conversationId: String, itemId: String, update: ActionItemUpdate) async throws -> ActionItem
    func memories(query: String?, kind: MemoryKind?, conversationId: String?, limit: Int, cursor: String?) async throws -> Page<Memory>
    func createMemory(_ memory: MemoryCreate) async throws -> Memory
    func search(_ request: SearchRequest) async throws -> SearchResponse
    func ask(_ request: AskRequest) async throws -> AskResponse
    func days(from: String?, to: String?, limit: Int, cursor: String?) async throws -> Page<DaySummary>
    func day(date: String) async throws -> DayDetail
    func streams(activeOnly: Bool) async throws -> [StreamInfo]
    func setCapturePaused(_ paused: Bool) async throws -> CapturePauseState
}

extension APIClient: MemoryAPI {
    public func conversations(query: String?, from: Int64?, to: Int64?, limit: Int, cursor: String?) async throws -> Page<ConversationSummary> {
        var items: [(String, String)] = [("limit", String(limit))]
        if let query, !query.isEmpty { items.append(("q", query)) }
        if let from { items.append(("from", String(from))) }
        if let to { items.append(("to", String(to))) }
        if let cursor { items.append(("cursor", cursor)) }
        return try await get(LTMRoute.conversations, query: items)
    }

    public func conversation(id: String) async throws -> ConversationDetail {
        try await get(LTMRoute.conversation(id), query: [])
    }

    public func updateActionItem(conversationId: String, itemId: String, update: ActionItemUpdate) async throws -> ActionItem {
        try await sendJSON(method: "PATCH", path: LTMRoute.actionItem(conversationId: conversationId, itemId: itemId), body: LTMJSON.encode(update))
    }

    public func memories(query: String?, kind: MemoryKind?, conversationId: String?, limit: Int, cursor: String?) async throws -> Page<Memory> {
        var items: [(String, String)] = [("limit", String(limit))]
        if let query, !query.isEmpty { items.append(("q", query)) }
        if let kind { items.append(("kind", kind.rawValue)) }
        if let conversationId { items.append(("conversationId", conversationId)) }
        if let cursor { items.append(("cursor", cursor)) }
        return try await get(LTMRoute.memories, query: items)
    }

    public func createMemory(_ memory: MemoryCreate) async throws -> Memory {
        try await sendJSON(method: "POST", path: LTMRoute.memories, body: LTMJSON.encode(memory))
    }

    public func search(_ request: SearchRequest) async throws -> SearchResponse {
        try await sendJSON(method: "POST", path: LTMRoute.search, body: LTMJSON.encode(request))
    }

    /// Answers take one language-model call; allow far longer than the default 30 s.
    public func ask(_ request: AskRequest) async throws -> AskResponse {
        try await sendJSON(method: "POST", path: LTMRoute.ask, body: LTMJSON.encode(request), timeout: 180)
    }

    public func days(from: String?, to: String?, limit: Int, cursor: String?) async throws -> Page<DaySummary> {
        var items: [(String, String)] = [("limit", String(limit))]
        if let from { items.append(("from", from)) }
        if let to { items.append(("to", to)) }
        if let cursor { items.append(("cursor", cursor)) }
        return try await get(LTMRoute.days, query: items)
    }

    public func day(date: String) async throws -> DayDetail {
        try await get(LTMRoute.day(date), query: [])
    }

    public func streams(activeOnly: Bool) async throws -> [StreamInfo] {
        try await get(LTMRoute.streams, query: activeOnly ? [("active", "true")] : [])
    }

    public func setCapturePaused(_ paused: Bool) async throws -> CapturePauseState {
        try await sendJSON(method: "POST", path: LTMRoute.capturePause, body: LTMJSON.encode(CapturePause(paused: paused)))
    }
}
