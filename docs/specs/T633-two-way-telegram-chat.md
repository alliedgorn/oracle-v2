# Two-Way Telegram Chat (Multi-Bot)

**Task**: T#633
**Author**: Karo
**Priority**: High
**Reviewer**: Bertus (security — approved), Gnarl (architecture — approved)
**Status**: Shipped, in review

## Problem

The Telegram bots are one-way — they send notifications TO Gorn but cannot receive messages back. Gorn needs to send messages and photos to Beasts via Telegram while traveling.

## Design — Multi-Bot Architecture

Each Beast can have its own Telegram bot. Gorn sends a message to a Beast's bot, the server receives it via long polling and forwards it as a DM from "gorn" to that Beast.

### 1. Long Polling (not webhooks)

- No public URL / SSL cert needed (Den Book runs locally)
- Each bot polls independently every 3 seconds with staggered start
- Reliable for low-volume single-sender use

### 2. Configuration

**Option A — JSON array** (preferred for multi-bot):
```
TELEGRAM_BOTS=[{"token":"bot1_token","beast":"karo"},{"token":"bot2_token","beast":"sable"}]
TELEGRAM_CHAT_ID=1786526199
```

**Option B — Legacy single-bot** (fallback):
```
TELEGRAM_BOT_TOKEN=<token>
TELEGRAM_CHAT_ID=<gorn's chat ID>
TELEGRAM_FORWARD_TO=<beast name>
```

### 3. Message Processing

Per bot, when a Telegram update is received:

1. **Validate sender**: Only process messages from `TELEGRAM_CHAT_ID` (Gorn). Reject all others.
2. **Text messages**: Forward as DM from "gorn" to the bot's Beast.
3. **Photos**: Download largest size via `getFile`, process with sharp (resize >1920px, strip EXIF GPS), save to uploads, DM with markdown image.
4. **Documents**: Forward as text DM with filename note.
5. **Voice/Stickers/Other**: Forward as descriptive text DM.
6. **Confirmation**: Reply to Gorn on Telegram (e.g. `✓ Forwarded to karo`).

### 4. Security (Bertus-approved)

- Sender validation: string-coerced chat_id, strict `===`
- Token from .env only, never logged or exposed
- File downloads use `crypto.randomUUID()` filenames — no path traversal
- DMs use parameterized SQL via `sendDm` — no injection
- 20MB file size limit (defense-in-depth)
- `sendDm` wrapped in `withRetry` to prevent silent message loss
- Polling loop has try/catch — cannot crash server
- Status endpoint owner-only

### 5. API Endpoint

```
GET /api/telegram/status — returns array of bot states (owner only)
```

Response:
```json
{
  "bots": [
    { "beast": "karo", "polling": true, "chat_id": "1786****", "last_message_at": "...", "message_count": 3 }
  ],
  "poll_interval_ms": 3000,
  "total_bots": 1
}
```

### 6. Frontend Changes

None. Messages appear as DMs in the existing interface.

### 7. Testing

- Send text to bot → DM from gorn to that Beast
- Send photo with caption → DM with image + caption
- Send photo without caption → DM with image + "[Photo]"
- Send from different Telegram account → ignored
- Restart server → polling resumes, no duplicate messages (offset tracked)
- Multiple bots → each polls independently, messages route to correct Beast

## Commits

1. `f3bbb51` — Feature: two-way Telegram chat (single bot)
2. `d01be76` — Hardening: file size check + withRetry (Bertus review)
3. `21cae54` — Fix: routing to correct Beast
4. `cd49322` — Refactor: multi-bot support

## Future (separate task)

- Settings page UI for managing bot tokens per Beast
- Beast → Gorn direction (reply from Den Book, send via Telegram)
- Group chat support
