import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { AgentSettings, ChatSessionMetadata, PairingRecord, RequestLogSummary } from "./types.ts";

const execFileAsync = promisify(execFile);

export const DEFAULT_SETTINGS: AgentSettings = {
  host: "localhost",
  port: 17624,
  startAtLogin: false,
  logRetentionDays: 7,
  logsEnabled: true,
};

export function defaultDataDir(): string {
  return (
    process.env.LOCAL_CLI_AGENT_DATA_DIR ??
    join(homedir(), "Library", "Application Support", "Local CLI Agent")
  );
}

function sqlString(value: string | null): string {
  if (value === null) {
    return "NULL";
  }
  return `'${value.replaceAll("'", "''")}'`;
}

function jsonString(value: unknown): string {
  return sqlString(JSON.stringify(value));
}

export class SQLiteStore {
  readonly dataDir: string;
  readonly dbPath: string;
  private operationQueue: Promise<unknown> = Promise.resolve();

  constructor(dataDir = defaultDataDir()) {
    this.dataDir = dataDir;
    this.dbPath = join(dataDir, "local-cli-agent.db");
  }

  async init(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });

    await this.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS pairings (
        client_id TEXT PRIMARY KEY,
        origin TEXT,
        credential_hash TEXT NOT NULL,
        json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS logs (
        request_id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        client_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        status TEXT NOT NULL,
        json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        mode TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    if (!existsSync(this.dbPath)) {
      throw new Error(`SQLite database was not created at ${this.dbPath}`);
    }

    await this.getSettings();
    await this.deleteDuplicatePairingsByClientIdentity();
  }

  async getSettings(): Promise<AgentSettings> {
    const rows = await this.query<{ value: string }>(
      `SELECT value FROM settings WHERE key = 'agent' LIMIT 1;`,
    );

    if (rows.length === 0) {
      await this.saveSettings(DEFAULT_SETTINGS);
      return { ...DEFAULT_SETTINGS };
    }

    return { ...DEFAULT_SETTINGS, ...JSON.parse(rows[0].value) };
  }

  async saveSettings(settings: AgentSettings): Promise<void> {
    await this.exec(`
      INSERT INTO settings (key, value)
      VALUES ('agent', ${jsonString(settings)})
      ON CONFLICT(key) DO UPDATE SET value = excluded.value;
    `);
  }

  async getPairing(clientId: string): Promise<PairingRecord | null> {
    const rows = await this.query<{ json: string }>(`
      SELECT json FROM pairings WHERE client_id = ${sqlString(clientId)} LIMIT 1;
    `);

    return rows.length === 0 ? null : JSON.parse(rows[0].json);
  }

  async listPairings(): Promise<PairingRecord[]> {
    const rows = await this.query<{ json: string }>(
      `SELECT json FROM pairings ORDER BY updated_at DESC;`,
    );
    return rows.map((row) => JSON.parse(row.json));
  }

  async hasPairingOrigin(origin: string): Promise<boolean> {
    const rows = await this.query<{ client_id: string }>(`
      SELECT client_id FROM pairings WHERE origin = ${sqlString(origin)} LIMIT 1;
    `);
    return rows.length > 0;
  }

  async upsertPairing(record: PairingRecord): Promise<void> {
    await this.exec(this.upsertPairingSql(record));
  }

  async updatePairing(
    clientId: string,
    updater: (record: PairingRecord) => PairingRecord,
  ): Promise<PairingRecord | null> {
    return this.enqueue(async () => {
      const rows = await this.rawQuery<{ json: string }>(`
        SELECT json FROM pairings WHERE client_id = ${sqlString(clientId)} LIMIT 1;
      `);
      if (rows.length === 0) {
        return null;
      }
      const next = updater(JSON.parse(rows[0].json));
      await this.rawExec(this.upsertPairingSql(next));
      return next;
    });
  }

  async deletePairing(clientId: string): Promise<boolean> {
    await this.exec(`
      DELETE FROM pairings WHERE client_id = ${sqlString(clientId)};
      DELETE FROM sessions WHERE client_id = ${sqlString(clientId)};
    `);
    return true;
  }

  async deletePairingsForClientIdentity(origin: string | null, clientName: string): Promise<number> {
    return this.enqueue(async () => {
      const rows = await this.rawQuery<{ json: string }>(`
        SELECT json FROM pairings WHERE ${origin === null ? "origin IS NULL" : `origin = ${sqlString(origin)}`};
      `);
      const duplicateClientIds = rows
        .map((row) => JSON.parse(row.json) as PairingRecord)
        .filter((record) => record.clientName === clientName)
        .map((record) => record.clientId);

      if (duplicateClientIds.length === 0) {
        return 0;
      }

      await this.rawExec(`
        DELETE FROM pairings
        WHERE client_id IN (${duplicateClientIds.map(sqlString).join(", ")});
        DELETE FROM sessions
        WHERE client_id IN (${duplicateClientIds.map(sqlString).join(", ")});
      `);
      return duplicateClientIds.length;
    });
  }

  async deleteDuplicatePairingsByClientIdentity(): Promise<number> {
    return this.enqueue(async () => {
      const rows = await this.rawQuery<{ client_id: string; json: string; updated_at: string }>(
        `SELECT client_id, json, updated_at FROM pairings ORDER BY updated_at DESC;`,
      );
      const seen = new Set<string>();
      const duplicateClientIds: string[] = [];

      for (const row of rows) {
        const record = JSON.parse(row.json) as PairingRecord;
        const identity = JSON.stringify([record.origin, record.clientName]);
        if (seen.has(identity)) {
          duplicateClientIds.push(row.client_id);
        } else {
          seen.add(identity);
        }
      }

      if (duplicateClientIds.length === 0) {
        return 0;
      }

      await this.rawExec(`
        DELETE FROM pairings
        WHERE client_id IN (${duplicateClientIds.map(sqlString).join(", ")});
        DELETE FROM sessions
        WHERE client_id IN (${duplicateClientIds.map(sqlString).join(", ")});
      `);
      return duplicateClientIds.length;
    });
  }

  async upsertSession(session: ChatSessionMetadata): Promise<void> {
    await this.exec(this.upsertSessionSql(session));
  }

  async getSession(sessionId: string): Promise<ChatSessionMetadata | null> {
    const rows = await this.query<{ json: string }>(`
      SELECT json FROM sessions WHERE session_id = ${sqlString(sessionId)} LIMIT 1;
    `);
    return rows.length === 0 ? null : JSON.parse(rows[0].json);
  }

  async listSessions(clientId?: string): Promise<ChatSessionMetadata[]> {
    const where = clientId ? `WHERE client_id = ${sqlString(clientId)}` : "";
    const rows = await this.query<{ json: string }>(
      `SELECT json FROM sessions ${where} ORDER BY updated_at DESC;`,
    );
    return rows.map((row) => JSON.parse(row.json));
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.exec(`DELETE FROM sessions WHERE session_id = ${sqlString(sessionId)};`);
  }

  async deleteExpiredSessions(nowIso: string): Promise<void> {
    await this.exec(`DELETE FROM sessions WHERE expires_at <= ${sqlString(nowIso)};`);
  }

  async appendLog(summary: RequestLogSummary, retentionDays: number): Promise<void> {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    await this.enqueue(async () => {
      await this.rawExec(`
        INSERT INTO logs (request_id, started_at, client_id, provider, status, json)
        VALUES (
          ${sqlString(summary.requestId)},
          ${sqlString(summary.startedAt)},
          ${sqlString(summary.clientId)},
          ${sqlString(summary.provider)},
          ${sqlString(summary.status)},
          ${jsonString(summary)}
        )
        ON CONFLICT(request_id) DO UPDATE SET json = excluded.json;
        DELETE FROM logs WHERE started_at < ${sqlString(cutoff)};
      `);
    });
  }

  async listLogs(limit = 100): Promise<RequestLogSummary[]> {
    const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    const rows = await this.query<{ json: string }>(`
      SELECT json FROM logs ORDER BY started_at DESC LIMIT ${safeLimit};
    `);
    return rows.map((row) => JSON.parse(row.json));
  }

  async clearLogs(): Promise<void> {
    await this.exec(`DELETE FROM logs;`);
  }

  private async exec(sql: string): Promise<void> {
    await this.enqueue(() => this.rawExec(sql));
  }

  private async query<T>(sql: string): Promise<T[]> {
    return this.enqueue(() => this.rawQuery<T>(sql));
  }

  private async rawExec(sql: string): Promise<void> {
    await execFileAsync("sqlite3", ["-cmd", ".timeout 5000", this.dbPath, sql], {
      maxBuffer: 1024 * 1024 * 8,
    });
  }

  private async rawQuery<T>(sql: string): Promise<T[]> {
    const { stdout } = await execFileAsync("sqlite3", ["-cmd", ".timeout 5000", "-json", this.dbPath, sql], {
      maxBuffer: 1024 * 1024 * 8,
    });
    const trimmed = stdout.trim();
    return trimmed.length === 0 ? [] : JSON.parse(trimmed);
  }

  private upsertPairingSql(record: PairingRecord): string {
    const now = new Date().toISOString();
    return `
      INSERT INTO pairings (client_id, origin, credential_hash, json, updated_at)
      VALUES (
        ${sqlString(record.clientId)},
        ${sqlString(record.origin)},
        ${sqlString(record.credentialHash)},
        ${jsonString(record)},
        ${sqlString(now)}
      )
      ON CONFLICT(client_id) DO UPDATE SET
        origin = excluded.origin,
        credential_hash = excluded.credential_hash,
        json = excluded.json,
        updated_at = excluded.updated_at;
    `;
  }

  private upsertSessionSql(session: ChatSessionMetadata): string {
    const now = new Date().toISOString();
    return `
      INSERT INTO sessions (session_id, client_id, provider, mode, expires_at, json, updated_at)
      VALUES (
        ${sqlString(session.sessionId)},
        ${sqlString(session.clientId)},
        ${sqlString(session.provider)},
        ${sqlString(session.mode)},
        ${sqlString(session.expiresAt)},
        ${jsonString(session)},
        ${sqlString(now)}
      )
      ON CONFLICT(session_id) DO UPDATE SET
        client_id = excluded.client_id,
        provider = excluded.provider,
        mode = excluded.mode,
        expires_at = excluded.expires_at,
        json = excluded.json,
        updated_at = excluded.updated_at;
    `;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.operationQueue.then(operation, operation);
    this.operationQueue = run.catch(() => undefined);
    return run;
  }
}
