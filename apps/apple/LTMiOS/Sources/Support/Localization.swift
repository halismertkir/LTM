import Foundation
import LTMKit
import UIKit

/// Looks up a key in `Localizable.strings` (en / tr). Keys are semantic so a missing
/// translation is visible instead of silently falling back to English text.
func L(_ key: String) -> String {
    NSLocalizedString(key, comment: "")
}

/// Localised format string (`%@`, `%ld`).
func LF(_ key: String, _ arguments: CVarArg...) -> String {
    String(format: L(key), locale: Locale.current, arguments: arguments)
}

enum DeviceInfo {
    static var appVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
    }

    /// Since iOS 16 this is the generic model name ("iPhone") unless the app has a special
    /// entitlement — good enough; the user can rename the device in the web app.
    @MainActor static var name: String { UIDevice.current.name }

    @MainActor static var platform: String { "iOS \(UIDevice.current.systemVersion)" }
}

/// User-facing explanations for errors and capture problems.
enum ErrorText {
    static func describe(_ error: Error) -> String {
        if let issue = error as? CaptureIssue { return describe(issue) }
        return describe(LTMError.from(error))
    }

    static func describe(_ error: LTMError) -> String {
        switch error {
        case .server(let code, let message, _):
            switch code {
            case .unauthorized: return L("error.unauthorized")
            case .consentRequired: return L("error.consentRequired")
            case .ingestPaused: return L("error.ingestPaused")
            case .unsupportedProtocol: return L("error.unsupportedProtocol")
            case .rateLimited: return L("error.rateLimited")
            case .notFound: return L("error.pairingCodeInvalid")
            case .badRequest: return message.isEmpty ? L("error.badRequest") : LF("error.serverSaid", message)
            default: return message.isEmpty ? LF("error.serverCode", code.rawValue) : LF("error.serverSaid", message)
            }
        case .unexpectedStatus(let status):
            return LF("error.httpStatus", status)
        case .unsupportedProtocol(let server, let client):
            return LF("error.protocolMismatch", server, client)
        case .notAnLTMServer:
            return L("error.notAnLTMServer")
        case .invalidServerURL:
            return L("error.invalidServerURL")
        case .invalidPairingCode:
            return L("error.invalidPairingCode")
        case .insecureConnectionBlocked:
            return L("error.atsBlocked")
        case .tlsFailure:
            return L("error.tls")
        case .transport:
            return L("error.offline")
        case .decoding:
            return L("error.decoding")
        case .notPaired:
            return L("error.notPaired")
        case .cancelled:
            return L("error.cancelled")
        }
    }

    static func describe(_ issue: CaptureIssue) -> String {
        switch issue {
        case .microphonePermissionDenied: return L("issue.microphoneDenied")
        case .speechPermissionDenied: return L("issue.speechDenied")
        case .onDeviceRecognitionUnavailable(let language): return LF("issue.onDeviceUnavailable", language)
        case .audioSession: return L("issue.audioSession")
        case .audioEngine: return L("issue.audioEngine")
        case .storage: return L("issue.storage")
        case .unauthorized: return L("error.unauthorized")
        case .server(let error): return describe(error)
        }
    }
}
