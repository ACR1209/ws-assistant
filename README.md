# WhatsApp-web.js Country Code Blocker

This app uses `whatsapp-web.js` directly (no WAHA) to auto-block senders whose phone numbers start with configured country codes.

## What it does

- Listens for incoming WhatsApp messages with `whatsapp-web.js`
- Extracts sender phone number from message JID
- Checks if number starts with a blocked country code
- Skips blocking if sender is already in your contacts
- Blocks sender via `contact.block()`
- Logs each decision in JSON format (`blocked` or `not_blocked`)
- Supports an optional admin chat by phone number for bot commands

## Prerequisites

- Node.js 18+
- A WhatsApp account you can pair via QR code

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create your env file:

```bash
cp .env.example .env
```

3. Edit `.env`:

- Set `BLOCKED_COUNTRY_CODES` (example `47,593`)
- Optionally set `ADMIN_PHONE` (digits only, include country code)
- Keep `SESSION_NAME=default` unless you want a separate profile

4. Start app:

```bash
npm start
```

5. Scan QR code shown in terminal logs.

## Run with Docker Compose

1. Make sure `.env` exists.
2. Start container:

```bash
docker compose up -d --build
```

3. Open logs and scan QR:

```bash
docker compose logs -f whatsapp-country-code-blocker
```

4. Health check:

```bash
curl http://localhost:8787/health
```

5. Stop:

```bash
docker compose down
```

## Notes

- Group chats (`@g.us`) are ignored.
- Broadcast/status senders are ignored.
- Commands sent in your own self chat are processed.
- Existing contacts (`isMyContact=true`) are ignored even if country code matches.
- Session auth is persisted in `.wwebjs_auth`.

## Admin Commands

Your own self chat can always run commands.

If `ADMIN_PHONE` is set, that phone number is also treated as admin chat and will never be auto-blocked.

Available commands:

- `!health` returns bot status, session name, blocked country codes, and uptime.
