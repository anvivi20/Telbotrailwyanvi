// functions/webhook.js
// Nhost Serverless Function — Telegram Webhook + Claude API + PostgreSQL Memory

const TELEGRAM_TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const ANTHROPIC_KEY    = process.env.ANTHROPIC_API_KEY;
const NHOST_DB_URL     = process.env.NHOST_DATABASE_URL; // postgresql://...
const MAX_HISTORY      = 10; // jumlah pesan yang diingat per user
const SYSTEM_PROMPT    = process.env.SYSTEM_PROMPT ||
  "Kamu adalah asisten AI yang membantu dan menjawab dalam Bahasa Indonesia.";

// ─── Kirim pesan ke Telegram ───────────────────────────────────
async function sendTelegram(chatId, text) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

// ─── Ambil history dari PostgreSQL ────────────────────────────
async function getHistory(userId) {
  try {
    const { Client } = await import("pg");
    const client = new Client({ connectionString: NHOST_DB_URL });
    await client.connect();

    const res = await client.query(
      `SELECT role, content FROM chat_history
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [userId, MAX_HISTORY]
    );
    await client.end();

    // Balik urutan agar kronologis
    return res.rows.reverse().map(r => ({ role: r.role, content: r.content }));
  } catch {
    return []; // fallback jika DB belum siap
  }
}

// ─── Simpan pesan ke PostgreSQL ───────────────────────────────
async function saveMessage(userId, role, content) {
  try {
    const { Client } = await import("pg");
    const client = new Client({ connectionString: NHOST_DB_URL });
    await client.connect();

    await client.query(
      `INSERT INTO chat_history (user_id, role, content, created_at)
       VALUES ($1, $2, $3, NOW())`,
      [userId, role, content]
    );

    // Hapus history lama agar tidak membengkak
    await client.query(
      `DELETE FROM chat_history
       WHERE user_id = $1
         AND id NOT IN (
           SELECT id FROM chat_history
           WHERE user_id = $1
           ORDER BY created_at DESC
           LIMIT $2
         )`,
      [userId, MAX_HISTORY * 2]
    );

    await client.end();
  } catch (e) {
    console.error("DB error:", e.message);
  }
}

// ─── Panggil Claude API ────────────────────────────────────────
async function askClaude(history) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: history,
    }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || "Claude error");
  return data.content[0].text;
}

// ─── Main Handler ──────────────────────────────────────────────
export default async function handler(req, res) {
  // Telegram hanya mengirim POST
  if (req.method !== "POST") {
    return res.status(200).json({ ok: true });
  }

  const body    = req.body;
  const message = body?.message;

  // Abaikan jika bukan pesan teks
  if (!message?.text) return res.status(200).json({ ok: true });

  const chatId   = message.chat.id;
  const userId   = String(message.from.id);
  const userText = message.text;

  // Handle command /clear
  if (userText === "/clear") {
    try {
      const { Client } = await import("pg");
      const client = new Client({ connectionString: NHOST_DB_URL });
      await client.connect();
      await client.query("DELETE FROM chat_history WHERE user_id = $1", [userId]);
      await client.end();
    } catch {}
    await sendTelegram(chatId, "🗑️ Riwayat percakapan dihapus.");
    return res.status(200).json({ ok: true });
  }

  if (userText === "/start") {
    await sendTelegram(chatId,
      "👋 Halo! Saya asisten AI berbasis Claude.\n\nKetik pesan untuk mulai.\n/clear — hapus riwayat"
    );
    return res.status(200).json({ ok: true });
  }

  try {
    // Ambil history, tambah pesan baru, tanya Claude
    const history = await getHistory(userId);
    history.push({ role: "user", content: userText });

    const reply = await askClaude(history);

    // Simpan kedua sisi percakapan
    await saveMessage(userId, "user", userText);
    await saveMessage(userId, "assistant", reply);

    await sendTelegram(chatId, reply);
  } catch (e) {
    console.error(e.message);
    await sendTelegram(chatId, "⚠️ Terjadi kesalahan. Coba lagi.");
  }

  return res.status(200).json({ ok: true });
}
