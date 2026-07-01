import Foundation

struct AdminStatus: Decodable {
    struct PendingPairRequest: Decodable {
        let requestId: String
        let clientName: String
        let clientType: String
        let origin: String?
        let requestedCapabilities: [String]
        let requestedProviders: [String]
    }

    let ok: Bool
    let service: String
    let version: String
    let status: String
    let address: String
    let providersReady: Int
    let providersTotal: Int
    let pairedClients: Int
    let activeRequests: Int
    let pendingPairRequests: [PendingPairRequest]
}

struct ProviderStatus: Decodable {
    let id: String
    let name: String
    let installed: Bool
    let ready: Bool
    let reason: String?
    let version: String?
    let models: [String]?
    let message: String?
}

struct ProvidersResponse: Decodable {
    let providers: [ProviderStatus]
}

struct PairingRecord: Decodable {
    let clientId: String
    let clientName: String
    let clientType: String
    let origin: String?
    let capabilities: [String]
    let allowedProviders: [String]
    let defaultProvider: String
    let maxConcurrentRequests: Int
    let maxRequestDurationMs: Int
    let createdAt: String
    let lastUsedAt: String?
    let requestCount: Int
}

struct ClientsResponse: Decodable {
    let clients: [PairingRecord]
}

struct RequestLogSummary: Decodable {
    let requestId: String
    let clientId: String
    let clientName: String
    let provider: String
    let startedAt: String
    let endedAt: String
    let durationMs: Int
    let status: String
    let inputChars: Int
    let outputChars: Int
    let errorCode: String?
}

struct LogsResponse: Decodable {
    let logs: [RequestLogSummary]
}

struct AgentSettings: Codable {
    let host: String
    var port: Int
    var startAtLogin: Bool
    var logRetentionDays: Int
    var logsEnabled: Bool
}

struct SettingsResponse: Decodable {
    let settings: AgentSettings
}

struct SettingsUpdateResponse: Decodable {
    let settings: AgentSettings
    let restartRequired: Bool?
}

struct ClientUpdateResponse: Decodable {
    let client: PairingRecord
}
