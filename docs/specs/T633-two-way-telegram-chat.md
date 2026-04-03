# Two-Way Telegram Chat

**Task**: T#633
**Author**: Karo
**Priority**: High
**Reviewer**: Bertus (security — webhook + auth), Gnarl (architecture)
**Deadline**: 2026-04-03 ~12:35 ICT (Gorn landing in Zurich)

## Problem

The Telegram bot (@gorn_karo_bot) is one-way — it sends notifications TO Gorn but cannot receive messages back. Gorn is traveling to Switzerland and wants to send messages and photos to Sable via Telegram while away from his desk.

## Current State

- Telegram bot exists with token in Karo's `.env` (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID)
- `scripts/telegram-send.sh` sends outbound messages via Telegram Bot API
- No webhook or polling — bot cannot receive incoming messages
- Den Book server (oracle-v2) has no Telegram integration
- Withings webhook pattern exists in server as prior art

## Design

### 1. Telegram Update Receiver — Long Polling

Use **long polling** (`getUpdates`) instead of webhooks. Reasons:
- No public URL / SSL cert needed on the bot endpoint (Den Book runs locally)
- Simpler setup — no webhook registration, no nginx config changes
- Withings webhook works because Withings calls a public URL; Telegram would need the same, but our server is behind a reverse proxy that may not be configured for this path
- Long polling is reliable for low-volume use (one user sending messages)

**Implementation**: A polling loop in the Den Book server that calls `getUpdates` every 3 seconds. Runs as a background interval on server start.

### 2. Environment Variables

Add to oracle-v2 `.env`:

```
TELEGRAM_BOT_TOKEN=<same token as Karo's bot>
TELEGRAM_CHAT_ID=<Gorn's chat ID: 1786526199>
TELEGRAM_FORWARD_TO=sable
```

`TELEGRAM_FORWARD_TO` — the Beast who receives forwarded messages as DMs from "gorn".

### 3. Message Processing

When a Telegram update is received:

1. **Validate sender**: Only process messages from `TELEGRAM_CHAT_ID` (Gorn). Ignore all others silently.
2. **Text messages**: Forward as DM from "gorn" to `TELEGRAM_FORWARD_TO` via existing DM API.
3. **Photos**: Download the photo via Telegram `getFile` API, save to Den Book uploads directory, create a DM with the image attached. Use caption as message text if present, otherwise "[Photo]".
4. **Other message types** (stickers, voice, video, documents): Forward as text DM with description, e.g. "[Voice message]", "[Document: filename.pdf]". Photo support is the priority; other types are best-effort.

### 4. Backend Changes (src/server.ts)

**New code block — Telegram polling**:

```typescript
// Telegram long polling — receive messages from Gorn
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TG_FORWARD_TO = process.env.TELEGRAM_FORWARD_TO || 'sable';

if (TG_TOKEN && TG_CHAT_ID) {
  let tgOffset = 0;
  
  const pollTelegram = async () => {
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${TG_TOKEN}/getUpdates?offset=${tgOffset}&timeout=3`
      );
      const data = await res.json();
      if (data.ok && data.result?.length) {
        for (const update of data.result) {
          tgOffset = update.update_id + 1;
          const msg = update.message;
          if (!msg || String(msg.chat.id) !== TG_CHAT_ID) continue;
          
          // Process message — text, photo, or other
          await handleTelegramMessage(msg);
        }
      }
    } catch (e) {
      console.error('[Telegram] Poll error:', e);
    }
  };
  
  setInterval(pollTelegram, 3000);
  console.log('[Telegram] Polling started');
}
```

**handleTelegramMessage function**:
- Text → DM from "gorn" to TELEGRAM_FORWARD_TO
- Photo → download largest photo size via `getFile`, save to uploads, DM with attachment
- Other → DM with type description

**New API endpoint** (admin only):

```
GET /api/telegram/status — returns polling state, last message timestamp, message count
```

Owner-only, for debugging.

### 5. Photo Handling Detail

```typescript
async function handleTelegramPhoto(msg) {
  // Telegram provides multiple sizes — use the largest
  const photo = msg.photo[msg.photo.length - 1];
  const fileRes = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/getFile?file_id=${photo.file_id}`);
  const fileData = await fileRes.json();
  const filePath = fileData.result.file_path;
  
  // Download the file
  const imageRes = await fetch(`https://api.telegram.org/file/bot${TG_TOKEN}/${filePath}`);
  const buffer = await imageRes.arrayBuffer();
  
  // Save to uploads directory with timestamp filename
  const ext = filePath.split('.').pop() || 'jpg';
  const filename = `telegram_${Date.now()}.${ext}`;
  // Save to uploads dir, create DM with image_url
}
```

### 6. Confirmation Reply

After successfully forwarding a message to Sable, send a brief confirmation back to Gorn on Telegram:

```
✓ Forwarded to Sable
```

This gives Gorn confidence the message went through without opening Den Book.

### 7. Security Considerations

- **Sender validation**: Only process messages from TELEGRAM_CHAT_ID — reject all others
- **No bot token in responses**: Never echo the token or internal state to Telegram
- **Photo size limit**: Reject photos > 20MB (Telegram's own limit is 20MB)
- **Rate limiting**: Not needed for v1 — single sender (Gorn), low volume
- **Token storage**: Bot token in .env, same pattern as existing secrets
- **No command injection**: Message content is stored as text via parameterized SQL (existing DM pattern)

### 8. Frontend Changes

None. Messages appear as DMs from "gorn" to "sable" in the existing DM interface.

### 9. Migration

No database changes. Uses existing DM and file upload tables.

### 10. Testing

- Send text message to bot → appears as DM from gorn to sable
- Send photo with caption → appears as DM with image and caption text
- Send photo without caption → appears as DM with image and "[Photo]"
- Send message from different Telegram account → ignored
- Kill and restart server → polling resumes, no duplicate messages (offset tracked)

## Out of Scope (v1)

- Sable replying BACK to Gorn via Telegram (Sable → Telegram direction)
- Group chat support
- Inline keyboards or bot commands
- Message editing/deletion sync
- Other Beasts receiving Telegram forwards (only Sable for now)
