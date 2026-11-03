/**
 * Cloudflare Worker: Scopus Discontinued & Retraction Watch Zalo/Telegram Bot + Web Portal
 * Kết nối trực tiếp với cơ sở dữ liệu tự động cập nhật trên GitHub:
 * https://raw.githubusercontent.com/johntroger/scopus-wos-bot/main/discontinued_lookup.json
 */

const GITHUB_LOOKUP_URL =
  "https://raw.githubusercontent.com/johntroger/scopus-wos-bot/main/discontinued_lookup.json";

let memoryCache = {
  data: null,
  fetchedAt: 0,
};

/**
 * Tải và cache dữ liệu tra cứu từ GitHub (cache 15 phút trên RAM & Cloudflare Edge)
 */
async function getLookupDatabase() {
  const now = Date.now();
  if (memoryCache.data && now - memoryCache.fetchedAt < 15 * 60 * 1000) {
    return memoryCache.data;
  }

  const resp = await fetch(GITHUB_LOOKUP_URL, {
    cf: { cacheTtl: 900, cacheEverything: true },
  });
  if (!resp.ok) {
    throw new Error(`Không thể tải dữ liệu từ GitHub (${resp.status})`);
  }
  const data = await resp.json();
  memoryCache = { data, fetchedAt: now };
  return data;
}

function normalizeIssn(val) {
  if (!val) return "";
  return String(val).replace(/[^0-9Xx]/g, "").toUpperCase();
}

/**
 * Tra cứu tạp chí theo Tên hoặc Mã ISSN
 */
function searchJournal(query, lookupDb) {
  const q = (query || "").trim();
  if (q.length < 3) {
    return (
      "ℹ️ HƯỚNG DẪN SỬ DỤNG BOT TRA CỨU SCOPUS & WOS:\n\n" +
      "1️⃣ Tra cứu tạp chí: Nhắn trực tiếp Tên tạp chí (ví dụ: 'Journal of Business Research') hoặc mã ISSN (ví dụ: '1096-3685').\n" +
      "2️⃣ Nhắn 'dangky': Nhận thông báo tự động mỗi khi Scopus loại tạp chí mới.\n" +
      "3️⃣ Nhắn 'huy': Ngừng nhận thông báo tự động.\n" +
      "4️⃣ Nhắn 'thongke': Xem phiên bản dữ liệu hiện tại."
    );
  }

  const normQIssn = normalizeIssn(q);
  const qLower = q.toLowerCase();

  const discList = lookupDb.discontinued_journals || [];
  const retractionMap = lookupDb.retraction_counts_by_journal || {};
  const scopusVer = lookupDb.scopus_version || "Scopus Discontinued List";

  const matchedDisc = [];
  for (const item of discList) {
    const title = item.title || "";
    const issn = normalizeIssn(item.issn || "");
    const eissn = normalizeIssn(item.eissn || "");

    if (
      normQIssn &&
      normQIssn.length === 8 &&
      (normQIssn === issn || normQIssn === eissn)
    ) {
      matchedDisc.push(item);
    } else if (title.toLowerCase().includes(qLower)) {
      matchedDisc.push(item);
    }
  }

  const matchedRetractions = [];
  for (const [jName, count] of Object.entries(retractionMap)) {
    if (jName.toLowerCase().includes(qLower)) {
      matchedRetractions.push([jName, count]);
    }
  }
  matchedRetractions.sort((a, b) => b[1] - a[1]);

  const lines = [
    `🔍 KẾT QUẢ KIỂM TRA: "${q}"`,
    `(Nguồn đối chiếu: ${scopusVer})\n`,
  ];

  if (matchedDisc.length > 0) {
    lines.push(
      `🚨 CẢNH BÁO: Tìm thấy ${matchedDisc.length} kết quả trong danh sách BỊ LOẠI (DISCONTINUED) khỏi Scopus:`
    );
    for (const item of matchedDisc.slice(0, 8)) {
      const issnStr = item.issn || item.eissn || "N/A";
      const eissnStr =
        item.eissn && item.issn ? ` / e-ISSN: ${item.eissn}` : "";
      lines.push(
        `• Tên tạp chí: ${item.title}\n` +
          `  - ISSN: ${issnStr}${eissnStr}\n` +
          `  - NXB: ${item.publisher || "N/A"}\n` +
          `  - Lý do bị loại: ${item.reason || "Discontinued"}\n` +
          `  - Năm ngừng coverage: ${item.discontinued_info || "Đã ngừng"}`
      );
    }
    if (matchedDisc.length > 8) {
      lines.push(`... và ${matchedDisc.length - 8} tạp chí trùng khớp khác.`);
    }
  } else {
    lines.push(
      "✅ TRẠNG THÁI SCOPUS DISCONTINUED:\n" +
        "Không tìm thấy tạp chí này trong danh sách bị loại (Discontinued Titles) của Scopus!"
    );
  }

  lines.push("");
  if (matchedRetractions.length > 0) {
    lines.push("📊 LỊCH SỬ BÀI BÁO BỊ RÚT (RETRACTION WATCH):");
    for (const [jName, cnt] of matchedRetractions.slice(0, 5)) {
      const warn = cnt >= 20 ? " ⚠️ (Số lượng cao)" : "";
      lines.push(`• ${jName}: ${cnt} bài từng bị rút/đính chính${warn}`);
    }
  } else {
    lines.push(
      "📊 RETRACTION WATCH: Tạp chí này không có (hoặc < 2) bài bị rút trong CSDL Retraction Watch."
    );
  }

  return lines.join("\n").slice(0, 1950);
}

/**
 * Gửi tin nhắn phản hồi qua Zalo Bot API
 */
async function sendZaloMessage(botToken, chatId, text) {
  if (!botToken || !chatId) return { ok: false, error: "Missing token/chatId" };
  const url = `https://bot-api.zaloplatforms.com/bot${botToken}/sendMessage`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: String(chatId),
      text: String(text).slice(0, 1980),
    }),
  });
  return await resp.json().catch(() => ({ ok: false }));
}

/**
 * Quản lý danh sách người đăng ký nhận thông báo định kỳ trong Cloudflare KV
 */
async function getSubscribers(env) {
  const raw = await env.SCOPUS_BOT_KV.get("SUBSCRIBERS_MAP");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function addSubscriber(env, chatId, displayName) {
  const subs = await getSubscribers(env);
  subs[String(chatId)] = {
    name: displayName || "Người dùng Zalo",
    subscribed_at: new Date().toISOString(),
  };
  await env.SCOPUS_BOT_KV.put("SUBSCRIBERS_MAP", JSON.stringify(subs));
  return Object.keys(subs).length;
}

async function removeSubscriber(env, chatId) {
  const subs = await getSubscribers(env);
  delete subs[String(chatId)];
  await env.SCOPUS_BOT_KV.put("SUBSCRIBERS_MAP", JSON.stringify(subs));
  return Object.keys(subs).length;
}

/**
 * Giao diện Web Tra cứu & Cài đặt Zalo Bot 1-Click
 */
function renderWebPortal(workerOrigin, botConfigured, subscriberCount) {
  return `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Hệ thống Tra cứu & Cảnh báo Tạp chí Scopus / WoS (Zalo Bot)</title>
  <style>
    :root {
      --bg: #f8fafc;
      --card: #ffffff;
      --primary: #0068ff;
      --text: #0f172a;
      --muted: #475569;
      --border: #e2e8f0;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.6;
      padding: 24px 16px;
    }
    .container { max-width: 820px; margin: 0 auto; }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 24px;
      margin-bottom: 20px;
      box-shadow: 0 2px 8px rgba(15, 23, 42, 0.04);
    }
    h1 { margin-top: 0; font-size: 1.45rem; color: #0f172a; }
    h2 { margin-top: 0; font-size: 1.15rem; color: #1e293b; }
    .badge {
      display: inline-block;
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 0.82rem;
      font-weight: 600;
      background: ${botConfigured ? "#dcfce7" : "#fef3c7"};
      color: ${botConfigured ? "#166534" : "#92400e"};
    }
    .input-row { display: flex; gap: 10px; margin-top: 12px; }
    input[type="text"], input[type="password"] {
      flex: 1;
      padding: 11px 14px;
      border: 1px solid #cbd5e1;
      border-radius: 8px;
      font-size: 0.96rem;
    }
    button {
      background: var(--primary);
      color: #fff;
      border: none;
      border-radius: 8px;
      padding: 11px 18px;
      font-size: 0.95rem;
      font-weight: 600;
      cursor: pointer;
    }
    button:hover { opacity: 0.92; }
    pre {
      background: #0f172a;
      color: #f8fafc;
      padding: 16px;
      border-radius: 10px;
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 0.9rem;
      margin-top: 14px;
      display: none;
    }
    .steps { padding-left: 20px; color: var(--muted); font-size: 0.94rem; }
    .steps li { margin-bottom: 6px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
        <h1>🔍 Hệ thống Kiểm tra Tạp chí Scopus Discontinued & Retraction Watch</h1>
        <span class="badge">${botConfigured ? "✅ Đã kết nối Zalo Bot (" + subscriberCount + " người đăng ký)" : "⚡ Sẵn sàng kết nối Zalo Bot"}</span>
      </div>
      <p style="color:var(--muted);margin:6px 0 0;">
        Nhập <strong>Tên tạp chí</strong> hoặc <strong>Mã ISSN</strong> để kiểm tra tức thì xem tạp chí có bị loại khỏi Scopus (Discontinued) hoặc có lịch sử rút bài trên Retraction Watch hay không.
      </p>
      <div class="input-row">
        <input type="text" id="qInput" placeholder="Ví dụ: 1096-3685 hoặc Academy of Accounting hoặc Journal of Business Research..." />
        <button onclick="doSearch()">Kiểm tra ngay</button>
      </div>
      <pre id="searchResult"></pre>
    </div>

    <div class="card">
      <h2>🤖 Kết nối Zalo Bot 1-Click (Chia sẻ cho nhiều người cùng dùng)</h2>
      <ol class="steps">
        <li>Mở ứng dụng <strong>Zalo</strong> trên điện thoại, tìm <strong>Zalo Bot Manager</strong> &rarr; bấm <strong>Tạo bot</strong> (đặt tên bắt đầu bằng chữ <code>Bot</code>, ví dụ: <code>Bot Kiem Tra Tap Chi</code>).</li>
        <li>Copy mã <strong>Bot Token</strong> mà Zalo Bot Manager gửi cho bạn, dán vào ô bên dưới và bấm <strong>Kích hoạt Zalo Bot</strong>.</li>
        <li>Sau khi kích hoạt xong, bạn có thể gửi link hoặc mã QR của Bot cho đồng nghiệp/sinh viên. Ai nhắn tên tạp chí hoặc ISSN vào Zalo Bot sẽ được trả lời tự động trong <strong>0.5 giây</strong>!</li>
      </ol>
      <div class="input-row">
        <input type="password" id="tokenInput" placeholder="Dán mã Zalo Bot Token (ví dụ: 123456789:abcXYZ...) vào đây" />
        <button onclick="setupZalo()">Kích hoạt Zalo Bot</button>
      </div>
      <pre id="setupResult"></pre>
    </div>
  </div>

  <script>
    async function doSearch() {
      const q = document.getElementById('qInput').value.trim();
      const box = document.getElementById('searchResult');
      box.style.display = 'block';
      box.textContent = 'Đang tra cứu dữ liệu...';
      try {
        const res = await fetch('/api/search?q=' + encodeURIComponent(q));
        const data = await res.json();
        box.textContent = data.result || data.error || 'Không có kết quả';
      } catch (e) {
        box.textContent = 'Lỗi kết nối: ' + e.message;
      }
    }
    document.getElementById('qInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doSearch();
    });

    async function setupZalo() {
      const token = document.getElementById('tokenInput').value.trim();
      const box = document.getElementById('setupResult');
      if (!token) {
        alert('Vui lòng dán Zalo Bot Token!');
        return;
      }
      box.style.display = 'block';
      box.textContent = 'Đang đăng ký Webhook với Zalo Bot Platform...';
      try {
        const res = await fetch('/api/setup-zalo', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bot_token: token })
        });
        const data = await res.json();
        box.textContent = JSON.stringify(data, null, 2);
        if (data.ok) {
          setTimeout(() => location.reload(), 1500);
        }
      } catch (e) {
        box.textContent = 'Lỗi: ' + e.message;
      }
    }
  </script>
</body>
</html>`;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // 1. Trang chủ Web Portal
    if (request.method === "GET" && path === "/") {
      const savedToken =
        env.ZALO_BOT_TOKEN || (await env.SCOPUS_BOT_KV.get("ZALO_BOT_TOKEN"));
      const subs = await getSubscribers(env);
      return new Response(
        renderWebPortal(url.origin, Boolean(savedToken), Object.keys(subs).length),
        { headers: { "Content-Type": "text/html; charset=utf-8" } }
      );
    }

    // 2. API Tra cứu trực tiếp trên Web hoặc từ bên ngoài (/api/search?q=...)
    if (path === "/api/search") {
      const q = url.searchParams.get("q") || "";
      try {
        const db = await getLookupDatabase();
        const result = searchJournal(q, db);
        return Response.json({
          ok: true,
          query: q,
          scopus_version: db.scopus_version,
          result,
        });
      } catch (err) {
        return Response.json({ ok: false, error: err.message }, { status: 500 });
      }
    }

    // 3. API Cài đặt nhanh Zalo Bot 1-Click (/api/setup-zalo)
    if (request.method === "POST" && path === "/api/setup-zalo") {
      try {
        const body = await request.json();
        const botToken = (body.bot_token || "").trim();
        if (!botToken || botToken.length < 10) {
          return Response.json(
            { ok: false, error: "Zalo Bot Token không hợp lệ." },
            { status: 400 }
          );
        }

        // Tạo secret_token ngẫu nhiên hoặc cố định để xác thực Webhook Zalo
        let secretToken = await env.SCOPUS_BOT_KV.get("ZALO_WEBHOOK_SECRET");
        if (!secretToken) {
          secretToken =
            "scopus_wos_secret_" + Math.random().toString(36).slice(2, 12);
          await env.SCOPUS_BOT_KV.put("ZALO_WEBHOOK_SECRET", secretToken);
        }

        const webhookUrl = `${url.origin}/webhook/zalo`;
        const zaloResp = await fetch(
          `https://bot-api.zaloplatforms.com/bot${botToken}/setWebhook`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              url: webhookUrl,
              secret_token: secretToken,
            }),
          }
        );
        const zaloData = await zaloResp.json();

        if (zaloData.ok) {
          await env.SCOPUS_BOT_KV.put("ZALO_BOT_TOKEN", botToken);
        }

        return Response.json({
          ok: Boolean(zaloData.ok),
          webhook_url: webhookUrl,
          zalo_response: zaloData,
          message: zaloData.ok
            ? "✅ Đã kết nối Zalo Bot thành công! Bây giờ bạn và mọi người có thể nhắn tên tạp chí hoặc ISSN vào Zalo Bot để tra cứu ngay."
            : "❌ Kết nối thất bại, vui lòng kiểm tra lại Bot Token.",
        });
      } catch (err) {
        return Response.json({ ok: false, error: err.message }, { status: 500 });
      }
    }

    // 4. Webhook nhận tin nhắn thời gian thực từ Zalo Bot (/webhook/zalo)
    if (path === "/webhook/zalo") {
      if (request.method === "GET") {
        return Response.json({ ok: true, status: "Zalo webhook endpoint ready" });
      }
      if (request.method === "POST") {
        const savedSecret = await env.SCOPUS_BOT_KV.get("ZALO_WEBHOOK_SECRET");
        const headerSecret = request.headers.get("x-bot-api-secret-token");
        if (savedSecret && headerSecret && headerSecret !== savedSecret) {
          return Response.json({ ok: false, error: "Unauthorized" }, { status: 403 });
        }

        let payload = {};
        try {
          payload = await request.json();
        } catch {
          return Response.json({ ok: true });
        }

        const msg = payload.message || {};
        const chatId = msg.chat?.id || msg.from?.id;
        const displayName = msg.from?.display_name || "Bạn";
        const text = (msg.text || "").trim();

        if (!chatId || !text) {
          return Response.json({ ok: true, note: "Verification or non-text event" });
        }

        const botToken =
          env.ZALO_BOT_TOKEN || (await env.SCOPUS_BOT_KV.get("ZALO_BOT_TOKEN"));

        ctx.waitUntil(
          (async () => {
            try {
              const cmd = text.toLowerCase();
              let replyText = "";

              if (["dangky", "/dangky", "subscribe", "/start", "start", "hi", "xin chào", "xin chao", "alo"].includes(cmd)) {
                const total = await addSubscriber(env, chatId, displayName);
                replyText =
                  `👋 Xin chào ${displayName}!\n` +
                  `✅ Bạn đã được đăng ký nhận cảnh báo tự động (Tổng số thành viên: ${total}).\n\n` +
                  `🔍 CÁCH TRA CỨU TẠP CHÍ:\n` +
                  `Hãy nhắn trực tiếp Tên tạp chí hoặc Mã ISSN vào đây, ví dụ:\n` +
                  `• 1096-3685\n` +
                  `• Journal of Business Research\n` +
                  `• Academy of Accounting\n\n` +
                  `(Nhắn 'huy' nếu muốn ngừng nhận thông báo định kỳ).`;
              } else if (["huy", "/huy", "unsubscribe", "/stop"].includes(cmd)) {
                await removeSubscriber(env, chatId);
                replyText =
                  "✅ Đã hủy nhận thông báo định kỳ. Bạn vẫn có thể nhắn Tên tạp chí hoặc ISSN bất cứ lúc nào để tra cứu!";
              } else if (["thongke", "/thongke", "stats", "status"].includes(cmd)) {
                const db = await getLookupDatabase();
                const subs = await getSubscribers(env);
                replyText =
                  `📊 THÔNG TIN HỆ THỐNG SCOPUS & WOS BOT:\n` +
                  `• Phiên bản Scopus: ${db.scopus_version}\n` +
                  `• Số tạp chí Discontinued đang lưu: ${(db.discontinued_journals || []).length} tạp chí\n` +
                  `• Số tạp chí có lịch sử Retraction Watch: ${Object.keys(db.retraction_counts_by_journal || {}).length} tạp chí\n` +
                  `• Số người đang đăng ký nhận cảnh báo: ${Object.keys(subs).length} người\n` +
                  `• Cập nhật lần cuối: ${db.updated_at}`;
              } else {
                // Tự động ghi nhận người dùng mới vào danh sách nếu đây là lần đầu họ nhắn
                const subs = await getSubscribers(env);
                if (!subs[String(chatId)]) {
                  await addSubscriber(env, chatId, displayName);
                }
                const db = await getLookupDatabase();
                replyText = searchJournal(text, db);
              }

              await sendZaloMessage(botToken, chatId, replyText);
            } catch (err) {
              await sendZaloMessage(
                botToken,
                chatId,
                `⚠️ Có lỗi xảy ra khi tra cứu: ${err.message}`
              );
            }
          })()
        );

        return Response.json({ ok: true });
      }
    }

    // 5. API Broadcast cho phép GitHub Actions gửi thông báo định kỳ tới tất cả người đã đăng ký (/api/broadcast)
    if (request.method === "POST" && path === "/api/broadcast") {
      const body = await request.json().catch(() => ({}));
      const message = (body.message || "").trim();
      if (!message) {
        return Response.json({ ok: false, error: "Empty message" }, { status: 400 });
      }

      const botToken =
        body.bot_token ||
        env.ZALO_BOT_TOKEN ||
        (await env.SCOPUS_BOT_KV.get("ZALO_BOT_TOKEN"));
      const subs = await getSubscribers(env);
      const chatIds = Object.keys(subs);

      let sentCount = 0;
      for (const cid of chatIds) {
        const res = await sendZaloMessage(botToken, cid, message);
        if (res && res.ok !== false) sentCount++;
      }

      return Response.json({
        ok: true,
        subscribers_total: chatIds.length,
        sent_count: sentCount,
      });
    }

    return Response.json({ ok: false, error: "Not found" }, { status: 404 });
  },
};
