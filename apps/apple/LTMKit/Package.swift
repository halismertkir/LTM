// swift-tools-version:5.10
import PackageDescription

// Shared core of the LTM iPhone and Apple Watch apps.
//
// The pure parts (wire protocol, frame encoder, energy gate, upload queue bookkeeping,
// stream client) also build for macOS so that `swift test` runs on a Mac without a
// simulator. Platform layers (AVAudioEngine capture, Speech, WatchConnectivity) are
// behind `#if os(...)` / `canImport` and are only compiled for the device platforms.
let package = Package(
    name: "LTMKit",
    platforms: [
        .iOS(.v17),
        .watchOS(.v10),
        .macOS(.v14),
    ],
    products: [
        .library(name: "LTMKit", targets: ["LTMKit"]),
    ],
    targets: [
        .target(
            name: "LTMKit",
            path: "Sources/LTMKit"
        ),
        .testTarget(
            name: "LTMKitTests",
            dependencies: ["LTMKit"],
            path: "Tests/LTMKitTests"
        ),
    ],
    swiftLanguageVersions: [.v5]
)
