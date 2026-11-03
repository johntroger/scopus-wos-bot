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
 * Tạo nội dung Hướng dẫn sử dụng (Onboarding / Menu trợ giúp) thân thiện cho người mới
 */
function buildUserGuideMessage(displayName = "bạn", isFirstTime = false) {
  const header = isFirstTime
    ? `👋 Chào mừng ${displayName} đến với *Bot Tra cứu Tạp chí Scopus & WoS*!\n(Hệ thống đã tự động bật thông báo định kỳ cho bạn).\n\n`
    : `📖 HƯỚNG DẪN SỬ DỤNG BOT TRA CỨU TẠP CHÍ SCOPUS & WOS\n\n`;

  return (
    header +
    `🔎 CÁCH 1: TRA CỨU TẠP CHÍ TRỰC TIẾP\n` +
    `Bạn chỉ cần nhắn trực tiếp *Mã ISSN* hoặc *Tên tạp chí* vào khung chat này. Ví dụ:\n` +
    `• Nhắn: 1096-3685 (kiểm tra theo ISSN)\n` +
    `• Nhắn: Journal of Business Research (kiểm tra theo tên)\n` +
    `• Nhắn: Sustainability\n\n` +
    `⌨️ CÁCH 2: GÕ PHÍM TẮT (1, 2, 3, 4)\n` +
    `• Gõ 1 : Xem hướng dẫn & ví dụ mẫu\n` +
    `• Gõ 2 : Xem các tạp chí Kinh tế - Quản trị bị loại khỏi Scopus\n` +
    `• Gõ 3 : Xem thông tin phiên bản dữ liệu hiện tại\n` +
    `• Gõ 4 : Bật nhận thông báo định kỳ (Gõ 'huy' để tắt)\n\n` +
    `👉 Hãy thử nhắn ngay: 1096-3685 hoặc 0148-2963`
  );
}

/**
 * Liệt kê mẫu các tạp chí khối Kinh tế - Quản trị - Xã hội bị loại khỏi Scopus
 */
function getBusinessDiscontinuedSamples(lookupDb) {
  const discList = lookupDb.discontinued_journals || [];
  const scopusVer = lookupDb.scopus_version || "Scopus Discontinued List";
  const keywords = [
    "business",
    "econom",
    "marketing",
    "management",
    "finance",
    "accounting",
    "commerce",
    "social",
  ];

  const filtered = discList.filter((item) => {
    const t = (item.title || "").toLowerCase();
    return keywords.some((kw) => t.includes(kw));
  });

  // Sắp xếp ưu tiên các tạp chí bị loại những năm gần đây nhất
  filtered.sort((a, b) =>
    String(b.discontinued_info || "").localeCompare(String(a.discontinued_info || ""))
  );

  const lines = [
    `📊 DANH SÁCH TẠP CHÍ KHỐI KINH TẾ - QUẢN TRỊ - XÃ HỘI BỊ LOẠI KHỎI SCOPUS`,
    `(Tổng cộng: ${filtered.length} tạp chí trong bản ${scopusVer})\n`,
    `Một số tạp chí tiêu biểu bị ngừng lập chỉ mục gần đây:`,
  ];

  for (const item of filtered.slice(0, 10)) {
    const issn = item.issn || item.eissn || "N/A";
    lines.push(
      `• ${item.title}\n  ISSN: ${issn} | Năm ngừng: ${item.discontinued_info || "N/A"} | NXB: ${item.publisher || "N/A"}`
    );
  }

  lines.push(
    `\n💡 Để kiểm tra một tạp chí cụ thể, hãy nhắn trực tiếp Tên tạp chí hoặc mã ISSN của tạp chí đó vào đây.`
  );
  return lines.join("\n").slice(0, 1950);
}

/**
 * Tra cứu tạp chí theo Tên hoặc Mã ISSN
 */
function searchJournal(query, lookupDb) {
  const q = (query || "").trim();
  if (q.length < 3) {
    return buildUserGuideMessage("bạn", false);
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

  lines.push(`\n💡 Mẹo: Gõ '1' để xem hướng dẫn | Gõ '2' xem DS ngành Kinh tế - Quản trị bị loại.`);
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
 * Giao diện Web Tra cứu & Hướng dẫn sử dụng cho người dùng
 */
function renderWebPortal(workerOrigin, botConfigured, subscriberCount) {
  return `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Bot Tra cứu Tạp chí Scopus & WoS (Zalo & Web)</title>
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
    .container { max-width: 840px; margin: 0 auto; }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 24px;
      margin-bottom: 20px;
      box-shadow: 0 2px 8px rgba(15, 23, 42, 0.04);
    }
    h1 { margin-top: 0; font-size: 1.42rem; color: #0f172a; }
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
    .input-row { display: flex; gap: 10px; margin-top: 12px; flex-wrap: wrap; }
    input[type="text"], input[type="password"] {
      flex: 1;
      min-width: 220px;
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
    .chip-row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
    .chip {
      background: #f1f5f9;
      border: 1px solid #cbd5e1;
      color: #334155;
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 0.83rem;
      cursor: pointer;
    }
    .chip:hover { background: #e2e8f0; }
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
    .guide-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 14px;
      margin-top: 12px;
    }
    .guide-box {
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 10px;
      padding: 14px;
    }
    .guide-box strong { color: #0f172a; display: block; margin-bottom: 4px; }
    .share-box {
      background: #eff6ff;
      border: 1px dashed #60a5fa;
      border-radius: 10px;
      padding: 14px;
      font-size: 0.9rem;
      margin-top: 14px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
        <h1>🔍 Hệ thống Tra cứu Tạp chí Scopus Discontinued & Retraction Watch</h1>
        <span class="badge">${botConfigured ? "✅ Bot Tra cứu Tạp chí đang hoạt động (" + subscriberCount + " người nhận tin)" : "⚡ Sẵn sàng kết nối Zalo Bot"}</span>
      </div>
      <p style="color:var(--muted);margin:6px 0 0;">
        Nhập <strong>Tên tạp chí</strong> hoặc <strong>Mã ISSN</strong> để kiểm tra tức thì xem tạp chí có bị loại khỏi Scopus (Discontinued) hoặc có lịch sử rút bài trên Retraction Watch hay không.
      </p>
      <div class="input-row">
        <input type="text" id="qInput" placeholder="Nhập Tên tạp chí hoặc ISSN (VD: 1096-3685, Journal of Business Research...)" />
        <button onclick="doSearch()">Kiểm tra ngay</button>
      </div>
      <div class="chip-row">
        <span style="font-size:0.83rem;color:var(--muted);align-self:center;">Thử nhanh:</span>
        <span class="chip" onclick="quickSearch('1096-3685')">1096-3685 (Đã bị loại)</span>
        <span class="chip" onclick="quickSearch('2281-3993')">2281-3993 (Đã bị loại)</span>
        <span class="chip" onclick="quickSearch('0148-2963')">0148-2963 (JBR - An toàn)</span>
        <span class="chip" onclick="quickSearch('Marketing')">Từ khóa: Marketing</span>
      </div>
      <pre id="searchResult"></pre>
    </div>

    <div class="card">
      <h2>📖 Hướng dẫn sử dụng trên Zalo (Dành cho Giảng viên, NCS & Sinh viên)</h2>
      <p style="color:var(--muted);margin:4px 0 12px;">
        Khi mở <strong>Bot Tra cứu Tạp chí</strong> trên Zalo, người dùng mới sẽ được Bot tự động gửi bảng hướng dẫn ngay từ tin nhắn hoặc nhãn dán (sticker) đầu tiên:
      </p>
      <div class="guide-grid">
        <div class="guide-box">
          <strong>1️⃣ Tra cứu theo Mã ISSN</strong>
          Nhắn trực tiếp mã ISSN (có hoặc không có dấu gạch ngang).<br/>
          <em>Ví dụ:</em> <code>1096-3685</code> hoặc <code>01482963</code>
        </div>
        <div class="guide-box">
          <strong>2️⃣ Tra cứu theo Tên tạp chí</strong>
          Nhắn tên đầy đủ hoặc một phần tên tạp chí.<br/>
          <em>Ví dụ:</em> <code>Journal of Business Research</code>
        </div>
        <div class="guide-box">
          <strong>3️⃣ Menu phím tắt (Gõ 1, 2, 3, 4)</strong>
          • Gõ <code>1</code>: Xem hướng dẫn & ví dụ<br/>
          • Gõ <code>2</code>: DS tạp chí Kinh tế bị loại<br/>
          • Gõ <code>3</code>: Phiên bản dữ liệu<br/>
          • Gõ <code>4</code>: Bật thông báo (<code>huy</code> để tắt)
        </div>
      </div>

      <div class="share-box">
        <strong>📋 Mẫu tin nhắn để bạn copy gửi vào nhóm Zalo Khoa / Nhóm Nghiên cứu:</strong>
        <div id="shareTemplate" style="margin-top:6px;background:#fff;padding:10px;border-radius:6px;border:1px solid #dbeafe;">
          Mời thầy/cô và các bạn sử dụng <strong>Bot Tra cứu Tạp chí Scopus &amp; Retraction Watch</strong> trên Zalo (hoặc tra cứu web tại ${workerOrigin}).<br/>
          • <strong>Cách dùng trên Zalo:</strong> Mở Bot và nhắn trực tiếp <em>Tên tạp chí</em> hoặc <em>Mã ISSN</em> (ví dụ: <code>1096-3685</code> hoặc <code>Journal of Business Research</code>), Bot sẽ trả lời ngay lập tức tạp chí có nằm trong danh sách bị loại (Discontinued) của Scopus hay có lịch sử rút bài trên Retraction Watch hay không.<br/>
          • Gõ <code>1</code> để xem hướng dẫn chi tiết hoặc gõ <code>2</code> để xem danh sách tạp chí khối Kinh tế - Quản trị bị loại khỏi Scopus.
        </div>
      </div>
    </div>

    <details class="card" style="cursor:pointer;">
      <summary style="font-weight:600;color:var(--muted);">⚙️ Cấu hình dành cho Quản trị viên (Cập nhật Zalo Bot Token)</summary>
      <div style="margin-top:12px;cursor:default;">
        <div class="input-row">
          <input type="password" id="tokenInput" placeholder="Dán mã Zalo Bot Token mới nếu muốn thay đổi..." />
          <button onclick="setupZalo()">Cập nhật Webhook</button>
        </div>
        <pre id="setupResult"></pre>
      </div>
    </details>
  </div>

  <script>
    function quickSearch(val) {
      document.getElementById('qInput').value = val;
      doSearch();
    }
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

    // 2. API Tra cứu trực tiếp trên Web (/api/search?q=...)
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
        const displayName = msg.from?.display_name || "bạn";
        const text = (msg.text || "").trim();

        if (!chatId) {
          return Response.json({ ok: true, note: "Verification ping" });
        }

        const botToken =
          env.ZALO_BOT_TOKEN || (await env.SCOPUS_BOT_KV.get("ZALO_BOT_TOKEN"));

        ctx.waitUntil(
          (async () => {
            try {
              const subs = await getSubscribers(env);
              const isNewUser = !subs[String(chatId)];
              if (isNewUser) {
                await addSubscriber(env, chatId, displayName);
              }

              // Nếu người dùng gửi Sticker chào hỏi, gửi ảnh, hoặc gõ lệnh trợ giúp / phím 1
              const cmd = text.toLowerCase();
              const helpTriggers = [
                "",
                "1",
                "menu",
                "/menu",
                "help",
                "/help",
                "start",
                "/start",
                "trogiup",
                "trợ giúp",
                "huongdan",
                "hướng dẫn",
                "cách dùng",
                "cach dung",
                "?",
                "hi",
                "hello",
                "alo",
                "xin chào",
                "xin chao",
                "chào",
                "chao",
                "bot",
                "bot ơi",
              ];

              let replyText = "";

              if (!text || helpTriggers.includes(cmd)) {
                replyText = buildUserGuideMessage(displayName, isNewUser);
              } else if (["2", "kinhte", "kinh tế", "ds", "danh sách"].includes(cmd)) {
                const db = await getLookupDatabase();
                replyText = getBusinessDiscontinuedSamples(db);
              } else if (["3", "thongke", "/thongke", "stats", "status"].includes(cmd)) {
                const db = await getLookupDatabase();
                const updatedSubs = await getSubscribers(env);
                replyText =
                  `📊 THÔNG TIN HỆ THỐNG SCOPUS & WOS BOT:\n` +
                  `• Phiên bản Scopus: ${db.scopus_version}\n` +
                  `• Tổng số tạp chí Discontinued đang lưu: ${(db.discontinued_journals || []).length} tạp chí\n` +
                  `• Số tạp chí có lịch sử Retraction Watch: ${Object.keys(db.retraction_counts_by_journal || {}).length} tạp chí\n` +
                  `• Số thành viên đăng ký nhận cảnh báo: ${Object.keys(updatedSubs).length} người\n` +
                  `• Cập nhật lần cuối: ${db.updated_at}\n\n` +
                  `💡 Gõ '1' để xem hướng dẫn | Gõ '2' xem DS tạp chí Kinh tế bị loại.`;
              } else if (["4", "dangky", "/dangky", "subscribe"].includes(cmd)) {
                const total = await addSubscriber(env, chatId, displayName);
                replyText =
                  `✅ ${displayName} đã bật nhận cảnh báo định kỳ thành công (Tổng số: ${total} thành viên).\n` +
                  `Mỗi khi Scopus công bố danh sách tạp chí bị loại tháng mới hoặc Retraction Watch có biến động lớn, Bot sẽ tự động nhắn cho bạn.\n\n` +
                  `💡 Gõ 'huy' nếu muốn tắt thông báo định kỳ.`;
              } else if (["huy", "/huy", "unsubscribe", "/stop"].includes(cmd)) {
                await removeSubscriber(env, chatId);
                replyText =
                  "✅ Đã tắt thông báo định kỳ. Bạn vẫn có thể nhắn Tên tạp chí hoặc mã ISSN bất cứ lúc nào để tra cứu!";
              } else {
                const db = await getLookupDatabase();
                replyText = searchJournal(text, db);
                // Nếu là người mới hoàn toàn và gõ tra cứu ngay ở tin nhắn đầu tiên, đính kèm lời chào ngắn ở đầu
                if (isNewUser) {
                  replyText =
                    `👋 Chào ${displayName}! (Gõ '1' bất cứ lúc nào để xem bảng hướng dẫn sử dụng).\n\n` +
                    replyText;
                }
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
