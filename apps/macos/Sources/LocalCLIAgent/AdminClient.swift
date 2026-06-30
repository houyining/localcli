import Foundation

@MainActor
final class AdminClient {
    private let baseURL: URL
    private let adminToken: String
    private let session: URLSession

    init(port: Int = 17624, adminToken: String, session: URLSession = .shared) {
        self.baseURL = URL(string: "http://127.0.0.1:\(port)")!
        self.adminToken = adminToken
        self.session = session
    }

    func status() async throws -> AdminStatus {
        try await get("/admin/status")
    }

    func providers() async throws -> [ProviderStatus] {
        let response: ProvidersResponse = try await get("/admin/providers")
        return response.providers
    }

    func clients() async throws -> [PairingRecord] {
        let response: ClientsResponse = try await get("/admin/clients")
        return response.clients
    }

    func logs() async throws -> [RequestLogSummary] {
        let response: LogsResponse = try await get("/admin/logs?limit=100")
        return response.logs
    }

    func settings() async throws -> AgentSettings {
        let response: SettingsResponse = try await get("/admin/settings")
        return response.settings
    }

    func updateSettings(
        port: Int,
        logRetentionDays: Int,
        logsEnabled: Bool,
        startAtLogin: Bool
    ) async throws -> SettingsUpdateResponse {
        try await patch("/admin/settings", body: [
            "port": port,
            "logRetentionDays": logRetentionDays,
            "logsEnabled": logsEnabled,
            "startAtLogin": startAtLogin
        ])
    }

    func allowPairing(requestId: String) async throws {
        try await post("/admin/pairing/\(requestId)/allow")
    }

    func denyPairing(requestId: String) async throws {
        try await post("/admin/pairing/\(requestId)/deny")
    }

    func deleteClient(clientId: String) async throws {
        var request = makeRequest(path: "/admin/clients/\(clientId)")
        request.httpMethod = "DELETE"
        let (data, response) = try await session.data(for: request)
        try validate(response: response, data: data)
    }

    func updateClient(
        clientId: String,
        defaultProvider: String,
        allowedProviders: [String],
        capabilities: [String],
        maxConcurrentRequests: Int,
        maxRequestDurationMs: Int
    ) async throws -> PairingRecord {
        let response: ClientUpdateResponse = try await patch("/admin/clients/\(clientId)", body: [
            "defaultProvider": defaultProvider,
            "allowedProviders": allowedProviders,
            "capabilities": capabilities,
            "maxConcurrentRequests": maxConcurrentRequests,
            "maxRequestDurationMs": maxRequestDurationMs
        ])
        return response.client
    }

    func clearLogs() async throws {
        try await post("/admin/logs/clear")
    }

    func startEvents(onEvent: @escaping @MainActor (_ type: String, _ payload: [String: Any]) -> Void) {
        let request = makeRequest(path: "/admin/events")
        Task { [session] in
            do {
                let (bytes, _) = try await session.bytes(for: request)
                for try await line in bytes.lines {
                    guard line.hasPrefix("data:") else { continue }
                    let json = String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces)
                    guard
                        let data = json.data(using: .utf8),
                        let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                        let type = object["type"] as? String
                    else {
                        continue
                    }
                    let payload = object["payload"] as? [String: Any] ?? [:]
                    onEvent(type, payload)
                }
            } catch {
                // The owner restarts the stream when the sidecar restarts.
            }
        }
    }

    private func get<T: Decodable>(_ path: String) async throws -> T {
        let request = makeRequest(path: path)
        let (data, response) = try await session.data(for: request)
        try validate(response: response, data: data)
        return try JSONDecoder().decode(T.self, from: data)
    }

    private func post(_ path: String) async throws {
        var request = makeRequest(path: path)
        request.httpMethod = "POST"
        request.httpBody = Data("{}".utf8)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let (data, response) = try await session.data(for: request)
        try validate(response: response, data: data)
    }

    private func patch<T: Decodable>(_ path: String, body: [String: Any]) async throws -> T {
        var request = makeRequest(path: path)
        request.httpMethod = "PATCH"
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let (data, response) = try await session.data(for: request)
        try validate(response: response, data: data)
        return try JSONDecoder().decode(T.self, from: data)
    }

    private func makeRequest(path: String) -> URLRequest {
        var request = URLRequest(url: URL(string: path, relativeTo: baseURL)!)
        request.setValue(adminToken, forHTTPHeaderField: "X-Local-Agent-Admin-Token")
        return request
    }

    private func validate(response: URLResponse, data: Data) throws {
        guard let http = response as? HTTPURLResponse else { return }
        guard (200..<300).contains(http.statusCode) else {
            let message = String(data: data, encoding: .utf8) ?? "HTTP \(http.statusCode)"
            throw NSError(domain: "LocalCLIAgent.AdminClient", code: http.statusCode, userInfo: [
                NSLocalizedDescriptionKey: message
            ])
        }
    }
}
