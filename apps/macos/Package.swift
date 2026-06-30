// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "LocalCLIAgent",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "LocalCLIAgent", targets: ["LocalCLIAgent"])
    ],
    targets: [
        .executableTarget(
            name: "LocalCLIAgent",
            path: "Sources/LocalCLIAgent"
        ),
        .testTarget(
            name: "LocalCLIAgentTests",
            dependencies: ["LocalCLIAgent"],
            path: "Tests/LocalCLIAgentTests"
        )
    ]
)
