/**
 * Pack Auto-Responder
 *
 * Event-driven Oracle dispatch with multi-turn conversation support.
 * When a message arrives in a channel thread, the target Oracle responds.
 * If the sender is also an Oracle, the conversation bounces back and forth
 * until it reaches a natural conclusion or hits the turn limit.
 */

import { spawn, execSync } from 'child_process';
import { writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync } from 'fs';
import { addMessage, updateThreadStatus, getMessages, getThread } from './handler.ts';
import { getSetting, sqlite } from '../db/index.ts';
import { enqueueNotification } from '../notify.ts';
import type { ForumMessage } from './types.ts';

// Dynamic Oracle workspace mapping — built from beast_profiles
function getOracles(): Record<string, { workspace: string; memoryDir: string }> {
  try {
    const beasts = sqlite.prepare('SELECT name FROM beast_profiles').all() as any[];
    if (beasts.length > 0) {
      const map: Record<string, { workspace: string; memoryDir: string }> = {};
      for (const b of beasts) {
        const name = b.name.toLowerCase();
        const workspace = name === 'zaghnal'
          ? '/home/gorn/workspace/gorn-oracle'
          : `/home/gorn/workspace/${name}`;
        const memoryDir = name === 'zaghnal'
          ? '/home/gorn/.claude/projects/-home-gorn-workspace-gorn-oracle/memory'
          : `/home/gorn/.claude/projects/-home-gorn-workspace-${name}/memory`;
        map[name] = { workspace, memoryDir };
      }
      return map;
    }
  } catch { /* beast_profiles may not exist */ }

  // Fallback
  return {
    karo:    { workspace: '/home/gorn/workspace/karo',        memoryDir: '/home/gorn/.claude/projects/-home-gorn-workspace-karo/memory' },
    zaghnal: { workspace: '/home/gorn/workspace/gorn-oracle', memoryDir: '/home/gorn/.claude/projects/-home-gorn-workspace-gorn-oracle/memory' },
    gnarl:   { workspace: '/home/gorn/workspace/gnarl',       memoryDir: '/home/gorn/.claude/projects/-home-gorn-workspace-gnarl/memory' },
    bertus:  { workspace: '/home/gorn/workspace/bertus',      memoryDir: '/home/gorn/.claude/projects/-home-gorn-workspace-bertus/memory' },
    leonard: { workspace: '/home/gorn/workspace/leonard',     memoryDir: '/home/gorn/.claude/projects/-home-gorn-workspace-leonard/memory' },
    mara:    { workspace: '/home/gorn/workspace/mara',        memoryDir: '/home/gorn/.claude/projects/-home-gorn-workspace-mara/memory' },
    rax:     { workspace: '/home/gorn/workspace/rax',         memoryDir: '/home/gorn/.claude/projects/-home-gorn-workspace-rax/memory' },
  };
}

// Cached reference — use getOracles() for fresh data
const ORACLES = getOracles();

const MAX_TURNS = 10; // Max auto-response turns per conversation burst
const TURN_DELAY_MS = 2000; // Brief pause between turns

/**
 * Find the tmux pane running a live Claude Code session for an Oracle.
 * Checks both the pane's direct command and child processes.
 * Returns the pane target (e.g., "Oracle:0.1") or null if not found.
 */
function findTmuxPane(oracle: string): string | null {
  const config = ORACLES[oracle];
  if (!config) return null;

  try {
    // List all tmux panes with their PID, command, and path
    const output = execSync(
      `tmux list-panes -a -F "#{session_name}:#{window_index}.#{pane_index} #{pane_pid} #{pane_current_command} #{pane_current_path}" 2>/dev/null || true`,
      { encoding: 'utf-8', timeout: 5000 }
    ).trim();

    if (!output) return null;

    for (const line of output.split('\n')) {
      const parts = line.trim().split(' ');
      if (parts.length < 4) continue;
      const pane = parts[0];
      const panePid = parts[1];
      const cmd = parts[2];
      const path = parts.slice(3).join(' ');

      if (path !== config.workspace) continue;

      // Direct match: pane is running claude
      if (cmd === 'claude') return pane;

      // Indirect match: pane is bash/zsh but has a claude child process
      try {
        const children = execSync(
          `pgrep -P ${panePid} -a 2>/dev/null || true`,
          { encoding: 'utf-8', timeout: 3000 }
        ).trim();
        if (children.includes('claude')) return pane;
      } catch { /* skip */ }
    }
  } catch { /* skip */ }

  return null;
}

/**
 * Inject a message into a live Claude Code session via tmux send-keys.
 * The message becomes user input in the session.
 */
function sendToLiveSession(pane: string, oracle: string, threadId: number, title: string, senderName: string, message: string): boolean {
  const preview = message.length > 300 ? message.slice(0, 300) + '...' : message;

  // Craft the injected prompt — the Oracle will process this as a user message
  const prompt = `[Forum message] From ${senderName} in thread #${threadId} ("${title}"):\n\n${preview}\n\nUse /forum thread ${threadId} to read and /forum post <message> (with thread_id ${threadId}) to reply.`;

  try {
    const success = enqueueNotification(oracle, prompt);
    if (success) {
      console.log(`[notify] Queued message for ${oracle}'s session`);
    }
    return success;
  } catch (err) {
    console.error(`[notify] Failed to queue for ${oracle}:`, err instanceof Error ? err.message : err);
    return false;
  }
}

// Concurrency control
let activeDispatch: string | null = null;
const queue: Array<{ threadId: number; oracle: string; title: string }> = [];
// Track active conversation threads to prevent re-entry
const activeConversations = new Set<number>();

/**
 * Extract target oracle name from thread title.
 * Supports: channel:{name}, topic:{name}:{slug}
 */
export function extractTargetOracle(title: string): string | null {
  const channelMatch = title.match(/^channel:(\w+)$/);
  if (channelMatch) return channelMatch[1].toLowerCase();

  const topicMatch = title.match(/^topic:(\w+):/);
  if (topicMatch) return topicMatch[1].toLowerCase();

  return null;
}

/**
 * Extract oracle name from author string.
 * e.g., "karo@auto-responder" → "karo", "opus@github.com/.../karo" → "karo"
 */
function extractOracleFromAuthor(author: string): string | null {
  if (!author) return null;
  const lower = author.toLowerCase();

  for (const name of Object.keys(ORACLES)) {
    if (lower.includes(name)) return name;
  }
  return null;
}

/**
 * Build prompt context from thread messages.
 */
function buildPrompt(oracle: string, title: string, messages: ForumMessage[], turnNumber: number): string {
  const recentMessages = messages.slice(-15); // Last 15 messages for context
  const context = recentMessages.map(m => {
    const author = m.author || m.role;
    return `[${author}]: ${m.content}`;
  }).join('\n\n');

  const turnGuidance = turnNumber >= MAX_TURNS - 2
    ? '\n\nThis conversation has been going for a while. Wrap up with a clear conclusion or action items.'
    : turnNumber >= 3
      ? '\n\nIf the conversation has reached a natural conclusion (agreement, action items decided, question answered), end with "[RESOLVED]" on its own line. Otherwise continue naturally.'
      : '';

  return `You are responding to a message in the Oracle forum thread "${title}".

IMPORTANT: You are in non-interactive print mode. Do NOT attempt to use tools, search, read files, or take any actions. Simply write your response text directly. No tool calls. No file reads. Just respond with your message.

Conversation so far:

${context}
${turnGuidance}
Write your response to the latest message. Be concise, helpful, and stay in character as defined in your CLAUDE.md.`;
}

/**
 * Dispatch a message to an Oracle via claude -p.
 */
function invokeOracle(oracle: string, prompt: string): Promise<string> {
  const config = ORACLES[oracle];
  if (!config) return Promise.reject(new Error(`Unknown oracle: ${oracle}`));

  return new Promise((resolve, reject) => {
    const claudePath = '/home/gorn/.local/bin/claude';
    const args = [
      '-p',
      '--model', 'sonnet',
      '--no-session-persistence',
      '--max-budget-usd', '0.50',
      prompt
    ];

    const child = spawn(claudePath, args, {
      cwd: config.workspace,
      env: { ...process.env, HOME: '/home/gorn' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

    child.on('close', (code) => {
      if (code === 0 && stdout.trim()) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`claude -p exited with code ${code}: ${stderr}`));
      }
    });

    child.on('error', reject);
  });
}

/**
 * Check if a response signals the conversation is done.
 */
function isConversationComplete(response: string): boolean {
  const lower = response.toLowerCase();
  return lower.includes('[resolved]');
}

/**
 * Strip the [RESOLVED] tag from the response before posting.
 */
function cleanResponse(response: string): string {
  return response.replace(/\[RESOLVED\]/gi, '').trim();
}

/**
 * Save conversation to each participating Oracle's persistent memory.
 * Writes to both:
 * 1. ψ/memory/learnings/ (workspace brain)
 * 2. ~/.claude/projects/{project}/memory/ (Claude Code persistent memory — auto-loaded)
 */
async function saveConversationMemory(
  threadId: number,
  title: string,
  messages: ForumMessage[]
): Promise<void> {
  // Find all participating oracles
  const participants = new Set<string>();
  for (const msg of messages) {
    const oracle = extractOracleFromAuthor(msg.author || '');
    if (oracle && ORACLES[oracle]) participants.add(oracle);
  }

  if (participants.size === 0) return;

  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const slug = title.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 40);

  // Build conversation transcript
  const transcript = messages.map(m => {
    const author = m.author || m.role;
    return `**${author}**: ${m.content}`;
  }).join('\n\n---\n\n');

  const participantNames = [...participants].join(', ');

  // Generate summary
  const summaryPrompt = `Summarize this Oracle forum conversation in 3-5 bullet points. Focus on decisions made, action items, and key insights. Be concise.

Thread: "${title}"
Participants: ${participantNames}

${transcript}

Output ONLY the bullet point summary, nothing else.`;

  let summary = '';
  try {
    summary = await invokeOracle([...participants][0], summaryPrompt);
  } catch {
    summary = `Conversation in "${title}" between ${participantNames} (${messages.length} messages)`;
  }

  const memoryFilename = `forum_thread-${threadId}_${slug}.md`;
  const memoryDescription = `Forum discussion: ${title} between ${participantNames} (${dateStr})`;

  // Save to each oracle
  for (const oracle of participants) {
    const config = ORACLES[oracle];
    if (!config) continue;

    // 1. Save to ψ/memory/learnings/ (workspace brain)
    const learningsDir = `${config.workspace}/ψ/memory/learnings`;
    const psiFilename = `${dateStr}_forum-${slug}.md`;
    const psiFilepath = `${learningsDir}/${psiFilename}`;

    if (!existsSync(psiFilepath)) {
      mkdirSync(learningsDir, { recursive: true });
      try {
        writeFileSync(psiFilepath, `---\ndate: ${dateStr}\nsource: forum-thread:${threadId}\ntitle: "${title}"\nparticipants: [${[...participants].map(p => `"${p}"`).join(', ')}]\ntags: [forum, auto-responder]\n---\n\n# Forum: ${title}\n\n## Summary\n\n${summary}\n\n## Full Conversation\n\n${transcript}\n`);
        console.log(`[memory] Saved to ${oracle} ψ: ${psiFilename}`);
      } catch (err) {
        console.error(`[memory] Failed ψ save for ${oracle}:`, err instanceof Error ? err.message : err);
      }
    }

    // 2. Save to persistent Claude Code memory (auto-loaded in sessions)
    const memoryDir = config.memoryDir;
    const memoryFilepath = `${memoryDir}/${memoryFilename}`;

    if (existsSync(memoryFilepath)) continue;

    mkdirSync(memoryDir, { recursive: true });

    const memoryContent = `---
name: Forum — ${title}
description: ${memoryDescription}
type: project
---

Forum thread #${threadId}: "${title}" (${dateStr})
Participants: ${participantNames}

## Key Takeaways

${summary}
`;

    try {
      writeFileSync(memoryFilepath, memoryContent);
      console.log(`[memory] Saved to ${oracle} persistent: ${memoryFilename}`);

      // 3. Update MEMORY.md index
      const indexPath = `${memoryDir}/MEMORY.md`;
      const indexEntry = `- [${memoryFilename}](${memoryFilename}) — ${memoryDescription}\n`;

      if (existsSync(indexPath)) {
        const existing = require('fs').readFileSync(indexPath, 'utf-8');
        if (!existing.includes(memoryFilename)) {
          writeFileSync(indexPath, existing.trimEnd() + '\n' + indexEntry);
        }
      } else {
        writeFileSync(indexPath, `# Memory Index\n\n${indexEntry}`);
      }

      console.log(`[memory] Updated ${oracle} MEMORY.md index`);
    } catch (err) {
      console.error(`[memory] Failed persistent save for ${oracle}:`, err instanceof Error ? err.message : err);
    }
  }
}

/**
 * Run a multi-turn conversation in a thread.
 * The target oracle responds, then if the sender was also an oracle,
 * the sender gets to reply, and so on.
 */
async function runConversation(threadId: number, title: string): Promise<void> {
  const tag = `[conversation:${threadId}]`;
  console.log(`${tag} Starting multi-turn conversation`);

  const targetOracle = extractTargetOracle(title);
  if (!targetOracle) return;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    // Get current messages
    const { messages } = getMessages(threadId);
    if (messages.length === 0) break;

    const lastMessage = messages[messages.length - 1];
    const lastAuthorOracle = extractOracleFromAuthor(lastMessage.author || '');

    // Determine who should respond next
    let nextResponder: string | null = null;

    if (lastAuthorOracle === targetOracle) {
      // Target oracle just spoke — find the other oracle to respond
      // Look back through messages to find the other party
      for (let i = messages.length - 2; i >= 0; i--) {
        const otherOracle = extractOracleFromAuthor(messages[i].author || '');
        if (otherOracle && otherOracle !== targetOracle && ORACLES[otherOracle]) {
          nextResponder = otherOracle;
          break;
        }
      }
      // If the other party is a human (not an oracle), stop — human will reply manually
      if (!nextResponder) {
        console.log(`${tag} Turn ${turn}: Other party is human, stopping auto-conversation`);
        break;
      }
    } else if (!lastAuthorOracle || lastAuthorOracle !== targetOracle) {
      // Someone else spoke (another oracle or human) — target oracle responds
      nextResponder = targetOracle;
    } else {
      break;
    }

    if (!nextResponder || !ORACLES[nextResponder]) break;

    console.log(`${tag} Turn ${turn}: ${nextResponder} responding...`);
    activeDispatch = nextResponder;

    try {
      const prompt = buildPrompt(nextResponder, title, messages, turn);
      const response = await invokeOracle(nextResponder, prompt);
      const done = isConversationComplete(response);
      const cleanedResponse = cleanResponse(response);

      // Post response
      addMessage(threadId, 'claude', cleanedResponse, {
        author: `${nextResponder}@auto-responder`,
      });

      console.log(`${tag} Turn ${turn}: ${nextResponder} posted (${cleanedResponse.length} chars)${done ? ' [RESOLVED]' : ''}`);

      if (done) {
        updateThreadStatus(threadId, 'answered');
        console.log(`${tag} Conversation resolved after ${turn + 1} turns`);
        // Save to each oracle's brain
        const { messages: finalMessages } = getMessages(threadId);
        await saveConversationMemory(threadId, title, finalMessages);
        return;
      }

      // Brief pause between turns
      await new Promise(r => setTimeout(r, TURN_DELAY_MS));

    } catch (err) {
      console.error(`${tag} Turn ${turn}: ${nextResponder} failed:`, err instanceof Error ? err.message : err);
      break;
    } finally {
      activeDispatch = null;
    }
  }

  // Mark as answered after max turns or natural end
  updateThreadStatus(threadId, 'answered');
  console.log(`${tag} Conversation ended`);

  // Save to each oracle's brain
  const { messages: finalMessages } = getMessages(threadId);
  await saveConversationMemory(threadId, title, finalMessages);
}

/**
 * Process the queue sequentially.
 */
async function processQueue(): Promise<void> {
  while (queue.length > 0) {
    const item = queue.shift()!;
    try {
      await runConversation(item.threadId, item.title);
    } finally {
      activeConversations.delete(item.threadId);
      activeDispatch = null;
    }
  }
}

/**
 * Determine who should respond next in a thread.
 * Returns the oracle name that should speak, or null if no one should.
 */
function getNextResponder(threadId: number, title: string): string | null {
  const targetOracle = extractTargetOracle(title);
  if (!targetOracle) return null;

  const { messages } = getMessages(threadId);
  if (messages.length === 0) return null;

  const lastMessage = messages[messages.length - 1];
  const lastAuthorOracle = extractOracleFromAuthor(lastMessage.author || '');

  // If the last message is from the target oracle, the OTHER oracle should respond
  if (lastAuthorOracle === targetOracle) {
    for (let i = messages.length - 2; i >= 0; i--) {
      const otherOracle = extractOracleFromAuthor(messages[i].author || '');
      if (otherOracle && otherOracle !== targetOracle && ORACLES[otherOracle]) {
        return otherOracle;
      }
    }
    return null; // Other party is human — they'll reply manually
  }

  // If the last message is from another oracle or human, the target oracle responds
  // But don't respond to our own auto-responder messages
  if (lastAuthorOracle && lastAuthorOracle !== targetOracle) {
    return targetOracle;
  }

  // Last message is from human or unidentified sender → target oracle responds
  return targetOracle;
}

/**
 * Main entry point — called after a message is added to a thread.
 * Fire-and-forget: does not block the API response.
 */
export function maybeAutoRespond(threadId: number, title: string): void {
  // Check if auto-responder is enabled
  const enabled = getSetting('auto_responder_enabled');
  if (enabled === 'false') return;

  // Must be a channel or topic thread
  const targetOracle = extractTargetOracle(title);
  if (!targetOracle) return;
  if (!ORACLES[targetOracle]) {
    console.log(`[responder] Unknown oracle "${targetOracle}" in thread "${title}", skipping`);
    return;
  }

  // Don't re-enter an active conversation
  if (activeConversations.has(threadId)) return;

  // Figure out who should respond next
  const nextResponder = getNextResponder(threadId, title);
  if (!nextResponder) return;

  const { messages } = getMessages(threadId);
  const lastMessage = messages[messages.length - 1];

  // Don't respond to own messages (prevent loops)
  const lastAuthorOracle = extractOracleFromAuthor(lastMessage.author || '');
  if (lastAuthorOracle === nextResponder) return;

  // Check if the next responder has a live tmux session
  const pane = findTmuxPane(nextResponder);
  if (pane) {
    const senderName = lastMessage.author || lastMessage.role;

    // Inject directly into the live session — the real Oracle handles it
    const sent = sendToLiveSession(pane, nextResponder, threadId, title, senderName, lastMessage.content);
    if (sent) {
      console.log(`[responder] Injected into ${nextResponder}'s live session (${pane}) — real Oracle will handle it`);
      return;
    }
    // If tmux injection failed, fall through to auto-responder
    console.log(`[responder] tmux injection failed for ${nextResponder} — falling back to auto-responder`);
  }

  // No live session — auto-respond immediately
  activeConversations.add(threadId);
  console.log(`[responder] No live session for ${nextResponder} — auto-responding in thread #${threadId} ("${title}")`);
  queue.push({ threadId, oracle: targetOracle, title });

  // Start processing if not already running
  if (!activeDispatch) {
    processQueue().catch(err => {
      console.error('[responder] Queue processing error:', err);
      activeConversations.delete(threadId);
    });
  }
}
