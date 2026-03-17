/**
 * Oracle DM Types
 *
 * Private one-on-one messaging between Oracles.
 */

export interface DmConversation {
  id: number;
  participant1: string;
  participant2: string;
  createdAt: number;
  updatedAt: number;
}

export interface DmMessage {
  id: number;
  conversationId: number;
  sender: string;
  content: string;
  readAt?: number;
  createdAt: number;
}
