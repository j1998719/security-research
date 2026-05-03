import { TELEGRAM_TOKEN, TELEGRAM_CHAT } from "./config.js";

export async function tg(msg: string): Promise<void> {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT, text: msg, parse_mode: "HTML" }),
    });
  } catch { /* non-fatal — never let Telegram errors crash the bot */ }
}
