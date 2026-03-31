/**
 * Guest API Client
 *
 * All guest-mode API calls go through /api/guest/* endpoints.
 * No calls to private /api/* in guest mode.
 * Spec #32, T#560.
 */

const API_BASE = '/api/guest';

// ============================================================================
// Dashboard
// ============================================================================

export interface GuestDashboard {
  publicThreads: { id: number; title: string; message_count: number; created_at: string }[];
  pack: GuestBeast[];
  dmSummary: { beast: string; unread: number }[];
}

export async function getGuestDashboard(): Promise<GuestDashboard> {
  const res = await fetch(`${API_BASE}/dashboard`);
  return res.json();
}

// ============================================================================
// Pack
// ============================================================================

export interface GuestBeast {
  name: string;
  displayName: string;
  animal: string;
  role: string | null;
  bio: string | null;
  themeColor: string | null;
  avatarUrl?: string | null;
  online?: boolean;
  status?: string;
}

export async function getGuestPack(): Promise<{ beasts: GuestBeast[] }> {
  const res = await fetch(`${API_BASE}/pack`);
  return res.json();
}

// ============================================================================
// Forum (public threads only)
// ============================================================================

export interface GuestThread {
  id: number;
  title: string;
  status: string;
  category: string;
  pinned: boolean;
  message_count: number;
  created_at: string;
  visibility: 'public';
}

export async function getGuestThreads(): Promise<{ threads: GuestThread[]; total: number }> {
  const res = await fetch(`${API_BASE}/threads`);
  return res.json();
}

export async function getGuestThread(id: number, limit?: number, offset = 0): Promise<any> {
  const params = new URLSearchParams();
  if (limit !== undefined) params.set('limit', limit.toString());
  if (offset) params.set('offset', offset.toString());
  const qs = params.toString();
  const res = await fetch(`${API_BASE}/thread/${id}${qs ? '?' + qs : ''}`);
  return res.json();
}

export async function postGuestMessage(threadId: number, message: string, author: string): Promise<any> {
  const res = await fetch(`${API_BASE}/thread`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ thread_id: threadId, message, author }),
  });
  return res.json();
}

// ============================================================================
// DMs (guest-to-Beast)
// ============================================================================

export async function sendGuestDm(to: string, message: string): Promise<any> {
  const res = await fetch(`${API_BASE}/dm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to, message }),
  });
  return res.json();
}

export async function getGuestDmConversation(guestName: string, beastName: string, limit = 30, offset = 0): Promise<any> {
  const params = new URLSearchParams({ limit: limit.toString(), offset: offset.toString() });
  const res = await fetch(`${API_BASE}/dm/${guestName}/${beastName}?${params}`);
  return res.json();
}

// ============================================================================
// Reactions
// ============================================================================

export async function addGuestReaction(messageId: number, emoji: string): Promise<any> {
  const res = await fetch(`${API_BASE}/react/${messageId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ emoji }),
  });
  return res.json();
}

export async function getGuestReactions(messageId: number): Promise<any> {
  const res = await fetch(`${API_BASE}/reactions/${messageId}`);
  return res.json();
}
