# Two-Way Telegram Chat (Multi-Bot)

**Task**: T#633
**Author**: Karo
**Priority**: High
**Reviewer**: Bertus (security — approved), Gnarl (architecture — approved)
**Status**: Shipped, tested by Gorn

## Problem

The Telegram bots are one-way — they send notifications TO Gorn but cannot receive messages back. Gorn needs to send messages and photos to Beasts via Telegram while traveling.

## Design — Multi-Bot Architecture

Each Beast has its own Telegram bot. Gorn sends a message to a Beast's bot, the server receives it via long polling, sends a **tmux notification** to the Beast with the message content, and the Beast replies via Telegram.

No DMs are created. Beasts see the message as a notification and reply through their own bot's outbound API.

### 1. Long Polling (not webhooks)

- No public URL / SSL cert needed (Den Book runs locally)
- Each bot polls independently every 3 seconds with staggered start
- Reliable for low-volume single-sender use

### 2. Configuration

**TELEGRAM_BOTS** — JSON array in oracle-v2 `.env`:
```
TELEGRAM_BOTS=[{"token":"...","beast":"karo"},{"token":"...","beast":"sable"},{"token":"...","beast":"leonard"},{"token":"...","beast":"gnarl"}]
TELEGRAM_CHAT_ID=1786526199
```

Fallback: legacy single-bot vars (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_FORWARD_TO`) still supported.

### 3. Message Processing

Per bot, when a Telegram update is received:

1. **Validate sender**: Only process messages from `TELEGRAM_CHAT_ID` (Gorn). Reject all others silently.
2. **Text messages**: Send tmux notification to the Beast with message content.
3. **Photos**: Download largest size via `getFile`, process with sharp (resize >1920px, strip EXIF GPS), save to uploads with `crypto.randomUUID()` filename. Notification includes clickable `denbook.online/api/f/` link so Beast can view the image.
4. **Documents/Voice/Stickers/Other**: Send tmux notification with descriptive text.
5. **No auto-reply**: No confirmation message sent back to Gorn on Telegram (per Gorn's request).

### 4. Beast Replies

Beasts reply to Gorn via their bot's outbound Telegram API:
```bash
curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  -d "chat_id=${TELEGRAM_CHAT_ID}" -d "text=Your message"
```

Beasts can also send photos to Gorn via `sendPhoto`.

Each Beast stores their own bot token in their `.env` for outbound use.

### 5. Security (Bertus-approved)

- Sender validation: string-coerced chat_id, strict `===`
- Token from .env only, never logged or exposed
- File downloads use `crypto.randomUUID()` filenames — no path traversal
- 20MB file size limit (defense-in-depth)
- Polling loop has try/catch — cannot crash server
- Status endpoint owner-only
- No guest access to Telegram — only Gorn's chat_id accepted

### 6. API Endpoint

```
GET /api/telegram/status — returns array of bot states (owner only)
```

Response:
```json
{
  "bots": [
    { "beast": "karo", "polling": true, "chat_id": "1786****", "last_message_at": "...", "message_count": 5 },
    { "beast": "sable", "polling": true, "chat_id": "1786****", "last_message_at": "...", "message_count": 3 },
    { "beast": "leonard", "polling": true, "chat_id": "1786****", "last_message_at": null, "message_count": 0 },
    { "beast": "gnarl", "polling": true, "chat_id": "1786****", "last_message_at": null, "message_count": 0 }
  ],
  "poll_interval_ms": 3000,
  "total_bots": 4
}
```

### 7. Frontend Changes

None.

### 8. Testing — End-to-End Verified

- Gorn sent text → Karo received tmux notification, replied via Telegram
- Gorn sent photo (airline menu) → saved to uploads, Karo viewed via link, replied
- Gorn sent to Sable's bot → Sable received, replied from 35,000 feet
- Gorn sent from different chat → silently ignored
- Server restart → polling resumes, no duplicates
- 4 bots polling simultaneously → correct routing per Beast

## Commits

1. `f3bbb51` — Feature: two-way Telegram chat (single bot, DM-based)
2. `d01be76` — Hardening: file size check + withRetry (Bertus review)
3. `21cae54` — Fix: routing to correct Beast
4. `cd49322` — Refactor: multi-bot support
5. `7190da2` — Fix: tmux notifications instead of DMs (per Gorn)
6. `04bf067` — Fix: remove auto-reply confirmation (per Gorn)
7. `2942413` — Feature: photo download + viewable link in notifications

## Active Bots

| Beast | Bot | Status |
|-------|-----|--------|
| Karo | @gorn_karo_bot | Live |
| Sable | (sable's bot) | Live |
| Leonard | (leonard's bot) | Live |
| Gnarl | @gorn_gnarl_bot | Live |

## Future (separate task)

- Settings page UI for managing bot tokens per Beast
- Guest → Beast Telegram chat
- More Beasts on Telegram
