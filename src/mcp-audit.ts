/**
 * MCP Audit Logger — append-only file logging for MCP tool calls.
 * T#646: Simple file-based audit trail per Beast workspace.
 */

import fs from 'fs';
import path from 'path';

let logPath: string | null = null;

function ensureLogPath(repoRoot: string): string {
  if (logPath) return logPath;
  const dir = path.join(repoRoot, 'data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  logPath = path.join(dir, 'mcp-audit.log');
  return logPath;
}

export function logMcpToolCall(
  repoRoot: string,
  toolName: string,
  args: Record<string, unknown> | undefined,
  status: 'success' | 'error' | 'read_only_blocked',
  durationMs: number,
  errorMessage?: string,
): void {
  try {
    const file = ensureLogPath(repoRoot);
    const entry = {
      ts: new Date().toISOString(),
      tool: toolName,
      args: args ?? {},
      status,
      durationMs,
      ...(errorMessage ? { error: errorMessage } : {}),
    };
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  } catch {
    // Never throw — audit logging must not break tool calls
  }
}
