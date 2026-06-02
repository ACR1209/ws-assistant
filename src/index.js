require("dotenv").config();

const express = require("express");
const { execSync } = require("child_process");
const path = require("path");
const qrcode = require("qrcode-terminal");
const { Client, LocalAuth } = require("whatsapp-web.js");

const app = express();
app.use(express.json({ limit: "1mb" }));

const port = Number(process.env.PORT || 8787);
const sessionName = process.env.SESSION_NAME || "default";
const authPath = process.env.WWEBJS_AUTH_PATH || ".wwebjs_auth";
const chromePath = process.env.CHROME_PATH || "/usr/bin/chromium";
const headless = String(process.env.HEADLESS || "true").toLowerCase() !== "false";
const blockedCountryCodes = String(process.env.BLOCKED_COUNTRY_CODES || "")
  .split(",")
  .map((code) => code.trim().replace(/^\+/, ""))
  .filter(Boolean);

if (blockedCountryCodes.length === 0) {
  console.error("Missing BLOCKED_COUNTRY_CODES in environment.");
  process.exit(1);
}

const blockedSet = new Set();
const lidToPhoneCache = new Map();
let clientStatus = "starting";

function logMessageOutcome({ eventName = "message", senderId = null, phone = null, action, reason }) {
  console.log(
    JSON.stringify({
      type: "message_result",
      eventName,
      senderId,
      phone,
      action,
      reason,
      at: new Date().toISOString()
    })
  );
}

function normalizePhone(raw) {
  if (!raw || typeof raw !== "string") {
    return "";
  }

  return raw.split("@")[0].replace(/\D/g, "");
}

async function resolvePhoneFromSenderId(senderId) {
  if (!senderId || typeof senderId !== "string") {
    return "";
  }

  if (!senderId.endsWith("@lid")) {
    return normalizePhone(senderId);
  }

  if (lidToPhoneCache.has(senderId)) {
    return lidToPhoneCache.get(senderId);
  }

  try {
    const results = await client.getContactLidAndPhone([senderId]);
    const resolvedPn = Array.isArray(results) && results[0] ? results[0].pn : "";
    const phone = normalizePhone(resolvedPn);
    if (!phone) {
      return "";
    }

    lidToPhoneCache.set(senderId, phone);
    return phone;
  } catch (error) {
    console.error("Failed to resolve LID sender", { senderId, error: error.message });
    return "";
  }
}

function matchCountryCode(phone) {
  return blockedCountryCodes.find((code) => phone.startsWith(code));
}

function isLikelyGroupId(id) {
  return typeof id === "string" && id.endsWith("@g.us");
}

function isBroadcastOrStatusId(id) {
  return typeof id === "string" && (id.includes("@broadcast") || id.startsWith("status"));
}

function cleanupChromiumLocks() {
  const sessionDir = path.resolve(authPath, `session-${sessionName}`);
  const escapedSessionDir = sessionDir.replace(/"/g, '\\"');

  try {
    execSync("pkill -f chromium || true", { stdio: "ignore" });
  } catch {
    // Best-effort cleanup only.
  }

  try {
    execSync(
      `rm -f "${escapedSessionDir}"/Singleton* "${escapedSessionDir}"/DevToolsActivePort "${escapedSessionDir}"/Default/Singleton* "${escapedSessionDir}"/Default/DevToolsActivePort`,
      { stdio: "ignore" }
    );
  } catch (error) {
    console.warn("Failed to cleanup Chromium lock patterns", { sessionDir, error: error.message });
  }
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    status: clientStatus,
    blockedCountryCodes,
    sessionName
  });
});

async function processIncomingMessage(message) {
  const senderId = message.from;

  if (!senderId) {
    logMessageOutcome({ action: "not_blocked", reason: "missing_sender" });
    return;
  }

  if (message.fromMe) {
    logMessageOutcome({ senderId, action: "not_blocked", reason: "from_me" });
    return;
  }

  if (isLikelyGroupId(senderId)) {
    logMessageOutcome({ senderId, action: "not_blocked", reason: "group_message" });
    return;
  }

  if (isBroadcastOrStatusId(senderId)) {
    logMessageOutcome({ senderId, action: "not_blocked", reason: "broadcast_or_status" });
    return;
  }

  const phone = await resolvePhoneFromSenderId(senderId);
  if (!phone) {
    const reason = senderId.endsWith("@lid") ? "lid_not_resolved" : "invalid_sender";
    logMessageOutcome({ senderId, action: "not_blocked", reason });
    return;
  }

  const matchedCode = matchCountryCode(phone);
  if (!matchedCode) {
    logMessageOutcome({ senderId, phone, action: "not_blocked", reason: "country_not_blocked" });
    return;
  }

  try {
    const contact = await message.getContact();
    if (contact?.isMyContact) {
      logMessageOutcome({ senderId, phone, action: "not_blocked", reason: "existing_contact" });
      return;
    }

    if (blockedSet.has(senderId) || blockedSet.has(phone)) {
      logMessageOutcome({ senderId, phone, action: "not_blocked", reason: "already_blocked_in_memory" });
      return;
    }

    await contact.block();
    blockedSet.add(senderId);
    blockedSet.add(phone);

    try {
      const chat = await contact.getChat();
      if (chat) {
        await chat.delete();
        logMessageOutcome({
          senderId,
          phone,
          action: "blocked",
          reason: `country_code_match:${matchedCode}:chat_deleted`
        });
      } else {
        logMessageOutcome({
          senderId,
          phone,
          action: "blocked",
          reason: `country_code_match:${matchedCode}:chat_not_found`
        });
      }
    } catch (chatError) {
      console.error("Failed to delete chat after block", {
        senderId,
        phone,
        error: chatError.message
      });
      logMessageOutcome({
        senderId,
        phone,
        action: "blocked",
        reason: `country_code_match:${matchedCode}:chat_delete_failed`
      });
    }
  } catch (error) {
    console.error("FULL ERROR OBJECT", { error });
    console.error("Failed to block contact", { senderId, phone, error: error.message });
    logMessageOutcome({ senderId, phone, action: "not_blocked", reason: "failed_to_block" });
  }
}

const client = new Client({
  authStrategy: new LocalAuth({ clientId: sessionName, dataPath: authPath }),
  puppeteer: {
    headless,
    executablePath: chromePath,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
  }
});

client.on("qr", (qr) => {
  clientStatus = "qr_required";
  console.log("QR received. Scan this QR to authenticate:");
  qrcode.generate(qr, { small: true });
});

client.on("ready", () => {
  clientStatus = "ready";
  console.log("WhatsApp client is ready.");
});

client.on("authenticated", () => {
  clientStatus = "authenticated";
  console.log("WhatsApp client authenticated.");
});

client.on("auth_failure", (message) => {
  clientStatus = "auth_failure";
  console.error("Authentication failure", { message });
});

client.on("disconnected", (reason) => {
  clientStatus = "disconnected";
  console.error("WhatsApp client disconnected", { reason });
});

client.on("change_state", (state) => {
  clientStatus = state;
  console.log("WhatsApp client state changed", { state });
});

client.on("message", async (message) => {
  await processIncomingMessage(message);
});

app.listen(port, () => {
  console.log(`WhatsApp country-code blocker listening on port ${port}`);
  console.log(`Session: ${sessionName}`);
  console.log(`Blocking country codes: ${blockedCountryCodes.join(", ")}`);
});

cleanupChromiumLocks();

client
  .initialize()
  .catch((error) => {
    clientStatus = "init_failed";
    console.error("Failed to initialize WhatsApp client", { error: error.message });
  });
