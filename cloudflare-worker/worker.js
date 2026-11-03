function matchTitleSafely(targetText, queryText) {
  if (!targetText || !queryText) return false;
  const t = targetText.toLowerCase();
  const q = queryText.toLowerCase();
  if (t === q) return true;
  if (q.length <= 5) {
    const escaped = q.replace(/[.*+?^$\{\}()|[\]\\]/g, '\\$&');
    const re = new RegExp('(?:^|[^a-z0-9])' + escaped + '(?:[^a-z0-9]|$)', 'i');
    return re.test(t);
  }
  return t.includes(q);
}

/**
 * Cloudflare Worker: Scopus Discontinued & Retraction Watch Zalo/Telegram Bot + Web Portal
 * Kết nối trực tiếp với cơ sở dữ liệu tự động cập nhật trên GitHub:
 * https://raw.githubusercontent.com/johntroger/scopus-wos-bot/main/discontinued_lookup.json
 *
 * Cơ chế nhận tin nhắn Zalo:
 * Sử dụng kết hợp Long-Polling (getUpdates) chạy liên tục mỗi phút qua Cloudflare Cron Trigger (* * * * *)
 * để vượt qua việc Cloudflare WAF chặn User-Agent "Java/<version>" của máy chủ Zalo khi gọi Webhook.
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
  if (memoryCache.data && now - memoryCache.fetchedAt < 60 * 60 * 1000) {
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
  const greeting = isFirstTime
    ? `👋 Kính chào ${displayName}!\n(Hệ thống đã tự động bật thông báo cảnh báo tạp chí mới cho bạn).\n\n`
    : `👋 Chào ${displayName}!\n\n`;

  return (
    greeting +
    `🤖 CẨM NANG TRA CỨU TẠP CHÍ & BÀI BÁO KHOA HỌC\n` +
    `───────────────────────────────────────\n` +
    `Bạn có thể gửi bất kỳ thông tin nào sau đây vào khung chat:\n\n` +
    `1️⃣ TRA THEO MÃ BÀI BÁO (DOI):\n` +
    `• Nhắn mã: 10.1016/j.jbusres.2021.08.043\n` +
    `  ↳ Bot tự tra Tên bài, Tác giả, Phí APC & Thẩm định tạp chí mẹ\n\n` +
    `2️⃣ TRA THEO TÊN VIẾT TẮT:\n` +
    `• Nhắn: VJCS (Tạp chí ĐH Nguyễn Tất Thành)\n` +
    `• Nhắn: JABES, JED, JSAMD, JBR, JCR, JBE...\n\n` +
    `3️⃣ TRA THEO MÃ ISSN HOẶC TÊN TẠP CHÍ:\n` +
    `• Nhắn mã ISSN: 0148-2963 hoặc 2196-8896\n` +
    `• Nhắn tên tiếng Việt: Kinh tế và Quản lý, Tạp chí Cộng sản, Kinh tế và Phát triển...\n\n` +
    `⌨️ PHÍM TẮT NHANH:\n` +
    `• Gõ 1 : Mở lại bảng hướng dẫn này\n` +
    `• Gõ 2 : Xem các tạp chí Kinh tế bị loại khỏi Scopus\n` +
    `• Gõ 3 : Xem thông tin phiên bản CSDL\n` +
    `• Gõ 4 : Bật/tắt nhận thông báo định kỳ (Gõ 'huy' để tắt)\n` +
    `• Gõ 5 : Xem 16 Tạp chí Việt Nam trong Scopus / WoS quốc tế\n` +
    `• Gõ 6 : Danh mục điểm 28 Hội đồng Giáo sư Nhà nước (QĐ 26/QĐ-HĐGSNN)\n` +
    `• Gõ aci : Xem danh mục Tạp chí Việt Nam trong ASEAN Citation Index\n` +
    `• Gõ nafosted : Xem chuẩn công nhận bài báo Quỹ NAFOSTED Quốc gia\n\n` +
    `👉 Hãy thử nhắn: VJCS, aci, nafosted, hdgs y hoc hoặc 10.1016/j.jbusres.2021.08.043`
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

const KNOWN_ACRONYMS = {
  jabeg: "journal of asian business and economic studies",
  jabes: "journal of asian business and economic studies",
  jbr: "journal of business research",
  jcr: "journal of consumer research",
  jbe: "journal of business ethics",
  jams: "journal of the academy of marketing science",
  jm: "journal of marketing",
  jfe: "journal of financial economics",
  aer: "american economic review",
  amj: "academy of management journal",
  amr: "academy of management review",
  jom: "journal of management",
  misq: "mis quarterly",
  ijhm: "international journal of hospitality management",
  ijchm: "international journal of contemporary hospitality management",
  jhtm: "journal of hospitality and tourism management",
  trr: "tourism recreation research",
  jed: "journal of economics and development",
  ejor: "european journal of operational research",
  ijpe: "international journal of production economics",
  ijpr: "international journal of production research",
  jf: "journal of finance",
  rfs: "review of financial studies",
  res: "review of economic studies",
  qje: "quarterly journal of economics",
  jpe: "journal of political economy",
  jebo: "journal of economic behavior & organization",
  smj: "strategic management journal",
  jwb: "journal of world business",
  jibs: "journal of international business studies",
  apjm: "asia pacific journal of management",
  ijim: "international journal of information management",
  eswa: "expert systems with applications",
  ktpt: "journal of economics and development",
  vjcs: "vietnam journal of computer science",
  vjm: "vietnam journal of mathematics",
  vjes: "vietnam journal of earth sciences",
  vjc: "vietnam journal of chemistry",
  vjst: "vietnam journal of science and technology",
  ansn: "advances in natural sciences: nanoscience and nanotechnology",
  jsamd: "journal of science: advanced materials and devices",
  jit: "journal of information and telecommunication",
};

/**
 * Liệt kê 16 Tạp chí Việt Nam đã gia nhập thành công Scopus & WoS quốc tế
 */
function getVietnamScopusList(lookupDb) {
  const vnList = lookupDb.vn_standards_2026 || [];
  const sjrMap = lookupDb.sjr_rankings || {};
  const intlVn = vnList.filter((item) => item.intl || item.stt <= 16);

  const lines = [
    `🇻🇳 DANH MỤC 16 TẠP CHÍ VIỆT NAM TRONG SCOPUS & WOS QUỐC TẾ`,
    `(Theo Quyết định Chuẩn Khoa học Quốc gia năm 2026)\n`,
  ];

  for (const j of intlVn) {
    const tLower = j.title.toLowerCase();
    const matchedSjr = sjrMap[tLower] || null;
    const qStr = matchedSjr ? `🌟 Scopus ${matchedSjr.quartile} (SJR: ${matchedSjr.sjr})` : `Scopus / WoS Quốc tế`;
    lines.push(
      `• [STT ${j.stt}] ${toTitleCase(j.title)}\n  ${qStr}\n  Cơ quan: ${j.org}`
    );
  }

  lines.push(`\n💡 Nhắn tên viết tắt (vd: VJCS, JABES, JED, JSAMD) để xem báo cáo thẩm định chi tiết.`);
  return lines.join("\n").slice(0, 1950);
}

const STOPWORDS = new Set(["of", "and", "the", "in", "for", "on", "with", "at", "by", "to", "a", "an", "&"]);

function normalizeVnText(str) {
  if (!str) return "";
  return str
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanVnJournalName(s) {
  const norm = normalizeVnText(s);
  return norm.replace(/^(tap chi|tap chi dien tu|the journal of|journal of)\s+/, "");
}

function toTitleCase(str) {
  if (!str) return "";
  return str
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function formatIssn(issn) {
  if (!issn) return "N/A";
  const clean = normalizeIssn(issn);
  if (clean.length === 8) return clean.slice(0, 4) + "-" + clean.slice(4);
  return issn;
}

/**
 * Tra cứu tạp chí đa nguồn chuyên sâu:
 * - Scopus Discontinued (danh sách loại trừ)
 * - Tạp chí Giả mạo / Cướp tên miền (Hijacked Journals)
 * - SCImago Scopus Quartile (Q1 - Q4) & ABDC (A*, A, B, C)
 * - Danh mục 341 Tạp chí đạt Tiêu chuẩn Khoa học Việt Nam năm 2026
 * - Khung điểm Hội đồng Giáo sư Nhà nước ngành Kinh tế (Quyết định 26/QĐ-HĐGSNN)
 * - Retraction Watch (Lịch sử rút bài)
 */

/**
 * Thuật toán Gợi ý Tên Tạp chí gần đúng (Did you mean / Fuzzy suggestion)
 * khi người dùng gõ sai chính tả hoặc không nhớ chính xác toàn bộ tên dài.
 */
function findClosestSuggestions(rawQuery, lookupDb, maxResults = 3) {
  const qClean = cleanVnJournalName(rawQuery);
  if (qClean.length < 3) return [];
  const qWords = qClean.split(' ').filter(w => w.length >= 2);
  if (qWords.length === 0) return [];

  const pool = new Map();

  if (lookupDb.hdgs_by_title) {
    for (const [k, v] of Object.entries(lookupDb.hdgs_by_title)) {
      if (v.title && !pool.has(v.title)) pool.set(v.title, cleanVnJournalName(v.title));
    }
  }

  if (lookupDb.vn_standards_2026) {
    for (const item of lookupDb.vn_standards_2026) {
      if (item.title && !pool.has(item.title)) pool.set(item.title, cleanVnJournalName(item.title));
    }
  }

  if (lookupDb.aci_journals && lookupDb.aci_journals.raw_list) {
    for (const item of lookupDb.aci_journals.raw_list) {
      if (item.title && !pool.has(item.title)) pool.set(item.title, cleanVnJournalName(item.title));
    }
  }

  const matches = [];
  for (const [originalTitle, candClean] of pool.entries()) {
    const candWords = candClean.split(' ').filter(w => w.length >= 2);
    if (candWords.length === 0) continue;

    let matchCount = 0;
    for (const qw of qWords) {
      if (candClean.includes(qw)) matchCount += 1;
    }

    if (matchCount > 0) {
      const union = new Set([...qWords, ...candWords]).size;
      const score = matchCount / union;
      if (score >= 0.25 || (qWords.length === 1 && candClean.includes(qWords[0]))) {
        matches.push({ title: originalTitle, score });
      }
    }
  }

  matches.sort((a, b) => b.score - a.score);
  const seenClean = new Set();
  const uniqueMatches = [];
  for (const m of matches) {
    const c = cleanVnJournalName(m.title);
    if (!seenClean.has(c)) {
      seenClean.add(c);
      uniqueMatches.push(m.title);
    }
  }
  return uniqueMatches.slice(0, maxResults);
}

function searchJournal(query, lookupDb) {
  const q = (query || "").trim();
  if (q.length < 2) {
    return buildUserGuideMessage("bạn", false);
  }

  const normQIssn = normalizeIssn(q);
  const qLower = q.toLowerCase();
  const scopusVer = lookupDb.scopus_version || "Scopus Discontinued List";

  // Giải mã từ viết tắt nếu có
  const resolvedQuery = KNOWN_ACRONYMS[qLower] || qLower;
  const normQVn = normalizeVnText(resolvedQuery);
  const cleanQVn = cleanVnJournalName(resolvedQuery);

  const discList = lookupDb.discontinued_journals || [];
  const hijackedList = lookupDb.hijacked_journals || [];
  const abdcMap = lookupDb.abdc_rankings || {};
  const sjrMap = lookupDb.sjr_rankings || {};
  const retractionMap = lookupDb.retraction_counts_by_journal || {};
  const vnList = lookupDb.vn_standards_2026 || [];
  const hdgsData = lookupDb.hdgsnn_kinhte || {};
  const hdgsJournals = hdgsData.journals || {};
  const hdgsByIssn = lookupDb.hdgs_by_issn || {};
  const hdgsByTitle = lookupDb.hdgs_by_title || {};
  const issnLinkedMap = lookupDb.issn_linked_map || {};
  const aciData = lookupDb.aci_journals || {};
  const aciByIssn = aciData.by_issn || {};
  const aciByTitle = aciData.by_title || {};
  const nafostedData = lookupDb.nafosted_national || {};
  const nafostedByIssn = nafostedData.by_issn || {};
  const nafostedByTitle = nafostedData.by_title || {};
  const wosDelistedList = lookupDb.wos_delisted_journals || [];
  const beallJournalsList = lookupDb.beall_standalone_journals || [];
  const beallPublishersList = lookupDb.beall_publishers || [];

  // So khớp Web of Science Delisted / Suppressed
  let matchedWosDelisted = null;
  for (const item of wosDelistedList) {
    const issn = normalizeIssn(item.issn || "");
    const eissn = normalizeIssn(item.e_issn || "");
    const title = (item.name || "").toLowerCase();
    if (
      (normQIssn && normQIssn.length === 8 && (normQIssn === issn || normQIssn === eissn)) ||
      (title && title === resolvedQuery) ||
      (title && resolvedQuery.length >= 8 && (title.includes(resolvedQuery) || resolvedQuery.includes(title)))
    ) {
      matchedWosDelisted = item;
      break;
    }
  }

  // So khớp Beall's List - Tạp chí săn mồi độc lập (Standalone Predatory Journals)
  let matchedBeallJournal = null;
  for (const item of beallJournalsList) {
    const name = (item.name || "").toLowerCase();
    const abbr = (item.abbr || "").toLowerCase();
    if (
      (abbr && abbr === resolvedQuery) ||
      (name && name === resolvedQuery) ||
      (name && resolvedQuery.length >= 8 && (name.includes(resolvedQuery) || resolvedQuery.includes(name)))
    ) {
      matchedBeallJournal = item;
      break;
    }
  }

  // So khớp Beall's List - Nhà xuất bản săn mồi (Predatory Publishers)
  let matchedBeallPublisher = null;
  for (const item of beallPublishersList) {
    const name = (item.name || "").toLowerCase();
    const abbr = (item.abbr || "").toLowerCase();
    if (
      (abbr && abbr === resolvedQuery) ||
      (name && matchTitleSafely(name, resolvedQuery))
    ) {
      matchedBeallPublisher = item;
      break;
    }
  }

  // 1. So khớp Tạp chí Giả mạo / Cướp tên miền (Hijacked)
  let matchedHijacked = null;
  for (const h of hijackedList) {
    const hTitle = (h.title || h.journal_title || "").toLowerCase();
    const hIssn = normalizeIssn(h.issn || "");
    if (
      (normQIssn && normQIssn.length === 8 && normQIssn === hIssn) ||
      (hTitle && matchTitleSafely(hTitle, resolvedQuery))
    ) {
      matchedHijacked = h;
      break;
    }
  }

  // 2. So khớp Scopus Discontinued (Tạp chí bị loại)
  let matchedDisc = null;
  for (const item of discList) {
    const title = item.title || "";
    const issn = normalizeIssn(item.issn || "");
    const eissn = normalizeIssn(item.eissn || "");

    if (
      normQIssn &&
      normQIssn.length === 8 &&
      (normQIssn === issn || normQIssn === eissn)
    ) {
      matchedDisc = item;
      break;
    } else if (matchTitleSafely(title, resolvedQuery)) {
      matchedDisc = item;
      break;
    }
  }

  // 3. Tra cứu SCImago SJR Scopus Active
  let matchedSjr = null;
  let sjrTitle = "";
  if (sjrMap[resolvedQuery]) {
    matchedSjr = sjrMap[resolvedQuery];
    sjrTitle = resolvedQuery;
  } else {
    for (const [title, info] of Object.entries(sjrMap)) {
      const issns = String(info.issn || "").split(",").map(normalizeIssn).filter(Boolean);
      if (normQIssn && normQIssn.length === 8 && issns.includes(normQIssn)) {
        matchedSjr = info;
        sjrTitle = title;
        break;
      }
    }
    if (!matchedSjr) {
      for (const [title, info] of Object.entries(sjrMap)) {
        if (matchTitleSafely(title, resolvedQuery)) {
          matchedSjr = info;
          sjrTitle = title;
          break;
        }
      }
    }
  }

  // 4. Tra cứu Phân hạng ABDC (Úc)
  let matchedAbdc = null;
  let abdcTitle = "";
  if (abdcMap[resolvedQuery]) {
    matchedAbdc = abdcMap[resolvedQuery];
    abdcTitle = resolvedQuery;
  } else if (sjrTitle && abdcMap[sjrTitle]) {
    matchedAbdc = abdcMap[sjrTitle];
    abdcTitle = sjrTitle;
  } else {
    for (const [title, info] of Object.entries(abdcMap)) {
      const issns = String(info.issn || "").split(",").map(normalizeIssn).filter(Boolean);
      if (normQIssn && normQIssn.length === 8 && issns.includes(normQIssn)) {
        matchedAbdc = info;
        abdcTitle = title;
        break;
      } else if (matchTitleSafely(title, resolvedQuery)) {
        matchedAbdc = info;
        abdcTitle = title;
        break;
      }
    }
  }

  // 5. Tra cứu Danh mục Tiêu chuẩn Khoa học Việt Nam năm 2026 (341 tạp chí)
  let matchedVn = null;
  // Khớp chính xác tên hoặc alias
  for (const item of vnList) {
    const tNorm = normalizeVnText(item.title);
    const tClean = cleanVnJournalName(item.title);
    if (tNorm === normQVn || tClean === cleanQVn) {
      matchedVn = item;
      break;
    }
    if (item.aliases && item.aliases.some((a) => normalizeVnText(a) === normQVn || cleanVnJournalName(a) === cleanQVn)) {
      matchedVn = item;
      break;
    }
  }
  // Khớp chuỗi con nếu chưa tìm thấy
  if (!matchedVn && cleanQVn.length >= 4) {
    for (const item of vnList) {
      const tClean = cleanVnJournalName(item.title);
      if (matchTitleSafely(tClean, cleanQVn) || (cleanQVn.length >= 8 && cleanQVn.includes(tClean))) {
        matchedVn = item;
        break;
      }
      if (item.aliases && item.aliases.some((a) => {
        const aClean = cleanVnJournalName(a);
        return matchTitleSafely(aClean, cleanQVn) || (cleanQVn.length >= 8 && cleanQVn.includes(aClean));
      })) {
        matchedVn = item;
        break;
      }
    }
  }

  // 6. Tra cứu Khung điểm 28 Hội đồng Giáo sư Nhà nước (QĐ 26/QĐ-HĐGSNN)
  let matchedHdgs = null;

  // 6.1. Tra cứu theo ISSN (trực tiếp hoặc qua liên kết p-ISSN <-> e-ISSN)
  if (normQIssn && normQIssn.length === 8) {
    if (hdgsByIssn[normQIssn]) {
      matchedHdgs = hdgsByIssn[normQIssn];
    } else if (issnLinkedMap[normQIssn]) {
      for (const linked of issnLinkedMap[normQIssn]) {
        if (hdgsByIssn[linked]) {
          matchedHdgs = hdgsByIssn[linked];
          break;
        }
      }
    }
  }

  // 6.2. Tra cứu qua ISSN của Tạp chí Chuẩn VN hoặc SJR đã khớp
  if (!matchedHdgs && matchedVn) {
    const vnIssns = [matchedVn.issn, matchedVn.eissn].filter(Boolean).map(normalizeIssn).filter(Boolean);
    for (const vi of vnIssns) {
      if (hdgsByIssn[vi]) {
        matchedHdgs = hdgsByIssn[vi];
        break;
      }
      if (issnLinkedMap[vi]) {
        for (const linked of issnLinkedMap[vi]) {
          if (hdgsByIssn[linked]) {
            matchedHdgs = hdgsByIssn[linked];
            break;
          }
        }
      }
      if (matchedHdgs) break;
    }
  }

  if (!matchedHdgs && matchedSjr && matchedSjr.issn) {
    const sjrIssns = String(matchedSjr.issn).split(',').map(normalizeIssn).filter(Boolean);
    for (const si of sjrIssns) {
      if (hdgsByIssn[si]) {
        matchedHdgs = hdgsByIssn[si];
        break;
      }
      if (issnLinkedMap[si]) {
        for (const linked of issnLinkedMap[si]) {
          if (hdgsByIssn[linked]) {
            matchedHdgs = hdgsByIssn[linked];
            break;
          }
        }
      }
      if (matchedHdgs) break;
    }
  }

  // 6.3. Tra cứu theo Tên chuẩn hóa (O(1) và Fuzzy)
  if (!matchedHdgs && cleanQVn.length >= 4) {
    if (hdgsByTitle[cleanQVn]) {
      matchedHdgs = hdgsByTitle[cleanQVn];
    } else {
      for (const [titleClean, info] of Object.entries(hdgsByTitle)) {
        if (titleClean === cleanQVn || matchTitleSafely(titleClean, cleanQVn) || (cleanQVn.length >= 8 && cleanQVn.includes(titleClean))) {
          matchedHdgs = info;
          break;
        }
      }
    }
  }

  if (!matchedHdgs && matchedVn) {
    const vnClean = cleanVnJournalName(matchedVn.title);
    if (hdgsByTitle[vnClean]) {
      matchedHdgs = hdgsByTitle[vnClean];
    } else {
      for (const [titleClean, info] of Object.entries(hdgsByTitle)) {
        if (titleClean === vnClean || matchTitleSafely(titleClean, vnClean) || vnClean.includes(titleClean)) {
          matchedHdgs = info;
          break;
        }
      }
    }
  }

  // 6.4. Fallback tương thích ngược: hdgsJournals cũ (Kinh tế)
  if (!matchedHdgs) {
    for (const [title, info] of Object.entries(hdgsJournals)) {
      const tClean = cleanVnJournalName(title);
      if (tClean === cleanQVn || (cleanQVn.length >= 4 && matchTitleSafely(tClean, cleanQVn))) {
        matchedHdgs = { title, scores: [{ council: "Kinh tế", points: info.points }] };
        break;
      }
    }
  }

  // 6.5. Tra cứu Danh mục ACI (ASEAN Citation Index) & NAFOSTED Quốc gia
  let matchedAci = null;
  let matchedNafostedNational = null;

  // Tra cứu ACI theo ISSN
  if (normQIssn && normQIssn.length === 8) {
    if (aciByIssn[normQIssn]) matchedAci = aciByIssn[normQIssn];
    else if (issnLinkedMap[normQIssn]) {
      for (const li of issnLinkedMap[normQIssn]) {
        if (aciByIssn[li]) { matchedAci = aciByIssn[li]; break; }
      }
    }
  }

  // Tra cứu ACI theo Title
  if (!matchedAci && cleanQVn.length >= 4) {
    if (aciByTitle[cleanQVn]) matchedAci = aciByTitle[cleanQVn];
    else {
      for (const [t, info] of Object.entries(aciByTitle)) {
        if (matchTitleSafely(t, cleanQVn) || (cleanQVn.length >= 8 && cleanQVn.includes(t))) {
          matchedAci = info;
          break;
        }
      }
    }
  }

  // Tra cứu NAFOSTED Quốc gia theo ISSN
  if (normQIssn && normQIssn.length === 8) {
    if (nafostedByIssn[normQIssn]) matchedNafostedNational = nafostedByIssn[normQIssn];
    else if (issnLinkedMap[normQIssn]) {
      for (const li of issnLinkedMap[normQIssn]) {
        if (nafostedByIssn[li]) { matchedNafostedNational = nafostedByIssn[li]; break; }
      }
    }
  }

  // Tra cứu NAFOSTED Quốc gia theo Title
  if (!matchedNafostedNational && cleanQVn.length >= 4) {
    if (nafostedByTitle[cleanQVn]) matchedNafostedNational = nafostedByTitle[cleanQVn];
    else {
      for (const [t, info] of Object.entries(nafostedByTitle)) {
        if (matchTitleSafely(t, cleanQVn) || (cleanQVn.length >= 8 && cleanQVn.includes(t))) {
          matchedNafostedNational = info;
          break;
        }
      }
    }
  }

  // Đồng bộ ACI & NAFOSTED qua Tạp chí Chuẩn VN
  if (matchedVn) {
    const vnIssns = [matchedVn.issn, matchedVn.eissn].filter(Boolean).map(normalizeIssn).filter(Boolean);
    const vnClean = cleanVnJournalName(matchedVn.title);
    if (!matchedAci) {
      for (const vi of vnIssns) { if (aciByIssn[vi]) { matchedAci = aciByIssn[vi]; break; } }
      if (!matchedAci && aciByTitle[vnClean]) matchedAci = aciByTitle[vnClean];
    }
    if (!matchedNafostedNational) {
      for (const vi of vnIssns) { if (nafostedByIssn[vi]) { matchedNafostedNational = nafostedByIssn[vi]; break; } }
      if (!matchedNafostedNational && nafostedByTitle[vnClean]) matchedNafostedNational = nafostedByTitle[vnClean];
    }
  }

  // 7. Đồng bộ hai chiều cho Tạp chí Việt Nam với SCImago Scopus
  if (!matchedSjr && matchedVn) {
    const vnTitleLower = (matchedVn.title || "").toLowerCase();
    if (sjrMap[vnTitleLower]) {
      matchedSjr = sjrMap[vnTitleLower];
      sjrTitle = vnTitleLower;
    } else if (matchedVn.aliases) {
      for (const a of matchedVn.aliases) {
        const aLower = a.toLowerCase();
        if (sjrMap[aLower]) {
          matchedSjr = sjrMap[aLower];
          sjrTitle = aLower;
          break;
        }
      }
    }
    if (!matchedSjr) {
      for (const [k, v] of Object.entries(sjrMap)) {
        if (k.length >= 10 && (vnTitleLower.includes(k) || k.includes(vnTitleLower))) {
          if (Math.min(k.length, vnTitleLower.length) / Math.max(k.length, vnTitleLower.length) > 0.65) {
            matchedSjr = v;
            sjrTitle = k;
            break;
          }
        }
      }
    }
  }

  // 8. Tra cứu Retraction Watch chính xác (chống false-positive với các tên ngắn như Science, RNA, Cell...)
  const targetJournalName = matchedVn?.title || matchedHdgs?.title || matchedDisc?.title || sjrTitle || abdcTitle || matchedHijacked?.title || resolvedQuery;
  const cleanTarget = (targetJournalName || "").toLowerCase().replace(/[^a-z0-9]/g, " ").replace(/\s+/g, " ").trim();
  let retractionCount = 0;

  for (const [jName, cnt] of Object.entries(retractionMap)) {
    const cleanJ = jName.toLowerCase().replace(/[^a-z0-9]/g, " ").replace(/\s+/g, " ").trim();
    if (!cleanJ || cleanJ.length < 3) continue;

    // Khớp tuyệt đối
    if (cleanJ === cleanTarget) {
      retractionCount = Math.max(retractionCount, cnt);
      break;
    }

    // Khớp chuỗi con có điều kiện: từ khóa phải dài từ 8 ký tự và chứa khoảng trắng (tránh khớp 'Science' hay 'RNA')
    if (cleanJ.length >= 8 && cleanJ.includes(" ") && cleanTarget.includes(" ")) {
      if (cleanTarget.includes(cleanJ) || cleanJ.includes(cleanTarget)) {
        const lenRatio = Math.min(cleanTarget.length, cleanJ.length) / Math.max(cleanTarget.length, cleanJ.length);
        if (lenRatio > 0.6) {
          retractionCount = Math.max(retractionCount, cnt);
        }
      }
    }
  }

  // TRƯỜNG HỢP: KHÔNG TÌM THẤY TẠP CHÍ NÀO TRONG MỌI NGUỒN DỮ LIỆU
  if (!matchedDisc && !matchedHijacked && !matchedSjr && !matchedAbdc && !matchedVn && !matchedHdgs && !matchedWosDelisted && !matchedBeallJournal && !matchedBeallPublisher) {
    const suggestions = findClosestSuggestions(q, lookupDb, 3);
    const lines = [
      `🔍 KẾT QUẢ TRA CỨU: "${q}"`,
      `\n❓ KHÔNG TÌM THẤY TRONG CSDL KHOA HỌC (SCOPUS / ABDC / CHUẨN VN 2026 / HĐGSNN / ACI)`,
      `Hệ thống không tìm thấy tạp chí nào khớp hoàn toàn với từ khóa bạn vừa nhập.`,
    ];

    if (suggestions.length > 0) {
      lines.push(`\n💡 CÓ PHẢI BẠN MUỐN TÌM:`);
      suggestions.forEach((s, idx) => lines.push(`${idx + 1}. ${s}`));
      lines.push(`\n👉 Bạn chỉ cần copy và gửi lại tên tạp chí ở trên để tra cứu ngay!`);
    }

    lines.push(
      `\n───────────────────────────────────────`,
      `💡 MẸO TRA CỨU CHÍNH XÁC:`,
      `• Nhắn mã ISSN (ví dụ: 0148-2963 hoặc 2515-964X)`,
      `• Nhắn mã DOI bài báo (ví dụ: 10.1016/j.jbusres.2021.08.043) để tra tự động`,
      `• Nhắn từ viết tắt chuẩn (VJCS, JABES, JED, JSAMD, JBR, JCR...)`,
      `• Gõ '6' để xem 28 Hội đồng GSNN | Gõ 'aci' xem ACI | Gõ 'nafosted' xem NAFOSTED`,
      `• Gõ '1' để xem lại toàn bộ hướng dẫn tra cứu.`
    );

    return lines.join("\n").slice(0, 1950);
  }

  // TRƯỜNG HỢP: TÌM THẤY TẠP CHÍ -> XUẤT BÁO CÁO THẨM ĐỊNH HỌC THUẬT TOÀN DIỆN
  const finalTitle = toTitleCase(
    matchedVn?.title ||
    matchedHdgs?.title ||
    matchedDisc?.title ||
    matchedWosDelisted?.name ||
    matchedBeallJournal?.name ||
    matchedBeallPublisher?.name ||
    sjrTitle ||
    abdcTitle ||
    matchedHijacked?.title ||
    q
  );

  const finalIssn = formatIssn(
    matchedHdgs?.issn ||
    matchedDisc?.issn ||
    matchedDisc?.eissn ||
    matchedWosDelisted?.issn ||
    matchedWosDelisted?.e_issn ||
    matchedSjr?.issn ||
    matchedAbdc?.issn ||
    matchedHijacked?.issn ||
    "Đang cập nhật"
  );

  const orgPublisher = matchedVn?.org || matchedHdgs?.org || matchedDisc?.publisher || matchedWosDelisted?.publisher || (matchedBeallPublisher ? matchedBeallPublisher.name : "");

  const lines = [`🔬 BÁO CÁO THẨM ĐỊNH TẠP CHÍ KHOA HỌC`];
  lines.push(`📖 Tạp chí: "${finalTitle}"`);
  if (KNOWN_ACRONYMS[qLower]) {
    lines.push(`(Được giải mã từ tên viết tắt: ${q.toUpperCase()})`);
  }

  // PHẦN 1: ĐỊNH DANH & CƠ QUAN CHỦ QUẢN
  lines.push(`\n📋 1. ĐỊNH DANH & CƠ QUAN CHỦ QUẢN:`);
  lines.push(`• Tên chính thức: ${finalTitle}`);
  lines.push(`• Mã ISSN / eISSN: ${finalIssn}`);
  if (orgPublisher) {
    lines.push(`• Cơ quan chủ quản / NXB: ${orgPublisher}`);
  }

  // PHẦN 2: CẢNH BÁO NGUY HIỂM (NẾU CÓ)
  if (matchedHijacked) {
    lines.push(`\n⛔ CẢNH BÁO: TẠP CHÍ BỊ GIẢ MẠO / CƯỚP TÊN MIỀN (HIJACKED)!`);
    if (matchedHijacked.hijacked_url) lines.push(`  ❌ Website giả mạo: ${matchedHijacked.hijacked_url}`);
    if (matchedHijacked.authentic_url) lines.push(`  ✅ Website chính thức: ${matchedHijacked.authentic_url}`);
  }

  if (matchedDisc) {
    lines.push(`\n🚨 CẢNH BÁO NGUY HIỂM: ĐÃ BỊ LOẠI KHỎI SCOPUS (DISCONTINUED)!`);
    lines.push(`• Danh mục đối chiếu: ${scopusVer}`);
    lines.push(`• Thời điểm ngừng chỉ mục: ${matchedDisc.discontinued_info || "Đã ngừng"}`);
    lines.push(`• Lý do loại bỏ: ${matchedDisc.reason || "Publication Concerns (Nghi vấn biên tập)"}`);
    lines.push(`• Đánh giá rủi ro: CỰC KỲ NGUY HIỂM. Bài đăng sau ngày bị loại sẽ bị 0 điểm HĐGSNN và không được tính chuẩn đầu ra Tiến sĩ.`);
  }

  if (matchedWosDelisted) {
    lines.push(`\n🚨 CẢNH BÁO NGUY HIỂM: ĐÃ BỊ LOẠI KHỎI WEB OF SCIENCE (WoS DELISTED)!`);
    lines.push(`• Nhà xuất bản: ${matchedWosDelisted.publisher || "N/A"}`);
    lines.push(`• Năm bị tước chỉ mục WoS: ${matchedWosDelisted.year || "2023"}`);
    lines.push(`• Lý do xử phạt: ${matchedWosDelisted.reason || "Vi phạm liêm chính khoa học / Nghi vấn paper mill"}`);
    lines.push(`• Đánh giá rủi ro: CỰC KỲ NGUY HIỂM. Bị tước Impact Factor (JIF), bài báo công bố không được tính chuẩn đầu ra WoS Core Collection!`);
  }

  if (matchedBeallJournal) {
    lines.push(`\n⚠️ CẢNH BÁO: TẠP CHÍ SĂN MỒI (BEALL'S LIST - STANDALONE JOURNAL)!`);
    lines.push(`• Nguồn cảnh báo: Danh mục tạp chí săn mồi độc lập của Jeffrey Beall & Stop Predatory Journals.`);
    if (matchedBeallJournal.url) lines.push(`• Website ghi nhận: ${matchedBeallJournal.url}`);
    lines.push(`• Khuyến cáo: Không nộp bài do quy trình bình duyệt không đạt chuẩn học thuật, nguy cơ mất uy tín công trình!`);
  }

  if (matchedBeallPublisher) {
    lines.push(`\n⚠️ CẢNH BÁO: THUỘC NHÀ XUẤT BẢN SĂN MỒI (BEALL'S LIST - PREDATORY PUBLISHER)!`);
    lines.push(`• Nhà xuất bản: ${matchedBeallPublisher.name}`);
    if (matchedBeallPublisher.url) lines.push(`• Website NXB: ${matchedBeallPublisher.url}`);
    lines.push(`• Đánh giá rủi ro: NXB này nằm trong danh sách đen các nhà xuất bản săn mồi (Predatory Publisher) theo Beall's List.`);
  }

  // PHẦN 3: TIÊU CHUẨN KHOA HỌC VIỆT NAM (2026), NAFOSTED & ĐIỂM HĐGSNN
  const isNafostedIntl =
    matchedSjr &&
    ["Q1", "Q2", "Q3"].includes(matchedSjr.quartile) &&
    !matchedDisc &&
    !matchedBeallJournal &&
    !matchedBeallPublisher &&
    !matchedWosDelisted;

  if (matchedVn || matchedHdgs || matchedSjr || matchedAci || matchedNafostedNational) {
    lines.push(`\n🇻🇳 2. TIÊU CHUẨN VIỆT NAM, NAFOSTED & HĐGSNN:`);
    if (matchedVn) {
      lines.push(`• Chuẩn khoa học VN 2026: ✅ ĐẠT TIÊU CHUẨN QUỐC GIA (STT: ${matchedVn.stt} / 341)`);
      lines.push(`• Phân nhóm: ${matchedVn.cat}`);
    } else if (matchedSjr || matchedAbdc) {
      lines.push(`• Chuẩn khoa học VN 2026: Tạp chí quốc tế (công nhận tính điểm theo quy chế đào tạo & HĐGSNN)`);
    }

    // Tiêu chuẩn Quỹ NAFOSTED (QĐ 14/QĐ-HĐQL-NAFOSTED)
    if (matchedNafostedNational) {
      lines.push(`• Chuẩn Quỹ NAFOSTED: 🇻🇳 ĐẠT CHUẨN QUỐC GIA UY TÍN (HĐ ngành: ${matchedNafostedNational.council} - Đủ điều kiện nghiệm thu đề tài NAFOSTED)`);
    } else if (isNafostedIntl) {
      lines.push(`• Chuẩn Quỹ NAFOSTED: 🎖️ ĐẠT CHUẨN QUỐC TẾ UY TÍN (Scopus ${matchedSjr.quartile} theo QĐ 14/QĐ-HĐQL-NAFOSTED - Đủ điều kiện chủ nhiệm/nghiệm thu đề tài cấp Quốc gia)`);
    }

    // Chỉ mục ASEAN Citation Index (ACI)
    if (matchedAci) {
      lines.push(`• Chỉ mục ACI (Đông Nam Á): 🌟 ĐẠT CHUẨN ACI (${matchedAci.title} - Tính điểm HĐGSNN tối đa 1,25 điểm & chuẩn Tiến sĩ)`);
    }

    // Điểm HĐGSNN 2025 theo Quyết định 26/QĐ-HĐGSNN
    if (matchedHdgs && matchedHdgs.scores && matchedHdgs.scores.length > 0) {
      lines.push(`• Điểm HĐGSNN 2025 (QĐ 26/QĐ-HĐGSNN):`);
      const maxDisplay = 5;
      const displayScores = matchedHdgs.scores.slice(0, maxDisplay);
      for (const sc of displayScores) {
        lines.push(`  🎯 HĐGS ${sc.council}: ${sc.points}`);
      }
      if (matchedHdgs.scores.length > maxDisplay) {
        lines.push(`  🎯 (+${matchedHdgs.scores.length - maxDisplay} Hội đồng ngành khác cũng tính điểm)`);
      }
    } else if (matchedHdgs?.points) {
      lines.push(`• Điểm công trình HĐGSNN: 🎯 ${matchedHdgs.points} (QĐ 26/QĐ-HĐGSNN)`);
    } else if (matchedSjr?.quartile === "Q1") {
      lines.push(`• Điểm công trình HĐGSNN: 🎯 0 - 2,0 điểm (Khung chung Scopus Q1 / QĐ 26/QĐ-HĐGSNN)`);
    } else if (matchedSjr?.quartile) {
      lines.push(`• Điểm công trình HĐGSNN: 🎯 0 - 1,5 điểm (Khung chung Scopus ${matchedSjr.quartile} / QĐ 26/QĐ-HĐGSNN)`);
    }
  }

  // PHẦN 4: PHÂN HẠNG QUỐC TẾ (SCOPUS / ABDC)
  if (!matchedDisc && (matchedSjr || matchedAbdc)) {
    lines.push(`\n🏆 3. XẾP HẠNG QUỐC TẾ (SCOPUS / ABDC):`);
    if (matchedSjr) {
      const qTier = matchedSjr.quartile || "N/A";
      const sjrVal = matchedSjr.sjr || "N/A";
      let tierDesc = "";
      if (qTier === "Q1") tierDesc = "Top 25% tạp chí hàng đầu thế giới";
      else if (qTier === "Q2") tierDesc = "Nhóm 25% - 50% thế giới";
      else if (qTier === "Q3") tierDesc = "Nhóm 50% - 75% danh mục";
      else if (qTier === "Q4") tierDesc = "Nhóm 75% - 100% danh mục";
      lines.push(`• SCImago Scopus: 🌟 ${qTier} (SJR: ${sjrVal} - ${tierDesc})`);
    }

    if (matchedAbdc) {
      const rank = matchedAbdc.abdc || "Listed";
      let abdcDesc = "";
      if (rank === "A*") abdcDesc = "Tạp chí tinh hoa quốc tế (Top 7% Kinh tế/Quản trị)";
      else if (rank === "A") abdcDesc = "Tạp chí xuất sắc, uy tín quốc tế rất cao";
      else if (rank === "B") abdcDesc = "Tạp chí chất lượng tốt, quốc tế công nhận";
      else if (rank === "C") abdcDesc = "Tạp chí đạt chuẩn bình duyệt quốc tế";
      lines.push(`• Phân hạng ABDC (Úc): 🎖️ Hạng ${rank} (${abdcDesc})`);
    }
  } else if (!matchedDisc && matchedVn && !matchedSjr && !matchedAbdc) {
    lines.push(`\n🌐 3. CHỈ MỤC QUỐC TẾ:`);
    lines.push(`• Tình trạng: Tạp chí khoa học uy tín trong nước (Chưa nằm trong CSDL Scopus/WoS quốc tế).`);
  }

  // PHẦN 5: LIÊM CHÍNH & RỦI RO
  lines.push(`\n🛡️ 4. KIỂM ĐỊNH LIÊM CHÍNH & RỦI RO:`);
  if (!matchedDisc) {
    if (matchedSjr) {
      lines.push(`• Tình trạng Scopus: ✅ ĐANG HOẠT ĐỘNG (Active - An toàn)`);
    } else {
      lines.push(`• Scopus Discontinued: ✅ Không nằm trong danh mục bị loại`);
    }
  }
  if (!matchedWosDelisted) {
    lines.push(`• Web of Science: ✅ Không nằm trong danh sách bị loại (WoS Delisted)`);
  }
  if (!matchedHijacked) {
    lines.push(`• Tạp chí giả mạo: ✅ AN TOÀN (Chưa ghi nhận website cướp tên miền)`);
  }
  if (!matchedBeallJournal && !matchedBeallPublisher) {
    lines.push(`• Danh sách Beall's List: ✅ An toàn (Không thuộc NXB/Tạp chí săn mồi)`);
  }
  if (retractionCount > 0) {
    lines.push(`• Lịch sử rút bài (Retraction Watch): ⚠️ Có ${retractionCount} bài từng bị rút/đính chính`);
  } else {
    lines.push(`• Lịch sử rút bài (Retraction Watch): ✅ 0 bài bị rút (Chỉ số liêm chính cao)`);
  }

  // PHẦN 6: KHUYẾN NGHỊ NỘP BÀI (VERDICT)
  lines.push(`\n🎯 5. KHUYẾN NGHỊ NỘP BÀI (VERDICT):`);
  if (matchedDisc || matchedHijacked || matchedWosDelisted || matchedBeallJournal) {
    lines.push(`⛔ TUYỆT ĐỐI KHÔNG NỘP BÀI: Tạp chí có rủi ro pháp lý học thuật rất lớn, bài báo sẽ không được công nhận.`);

    // GỢI Ý TẠP CHÍ THAY THẾ AN TOÀN CÙNG CHUYÊN NGÀNH
    const alts = getSafeAlternatives(finalTitle);
    lines.push(`\n💡 6. GỢI Ý TẠP CHÍ THAY THẾ AN TOÀN (CÙNG CHUYÊN NGÀNH):`);
    lines.push(`Để không gián đoạn kế hoạch công bố, bạn có thể cân nhắc nộp bài vào các tạp chí uy tín đang hoạt động sau:`);
    for (const a of alts) {
      lines.push(`• ${a.name}\n  ISSN: ${a.issn} | ${a.note}`);
    }
  } else if (matchedBeallPublisher) {
    lines.push(`⚠️ CẢNH GIÁC CAO: Đơn vị xuất bản nằm trong danh mục NXB săn mồi của Beall's List. Cần kiểm tra kỹ lưỡng ban biên tập và chính sách phản biện trước khi nộp bài.`);
  } else if (matchedSjr?.quartile === "Q1" || matchedAbdc?.abdc === "A*" || matchedAbdc?.abdc === "A") {
    lines.push(`✅ RẤT NÊN NỘP: Tạp chí quốc tế hàng đầu, đủ điều kiện bảo vệ Luận án Tiến sĩ, xét PGS/GS và nghiệm thu đề tài NCKH trọng điểm.`);
  } else if (matchedSjr || matchedAbdc) {
    lines.push(`✅ ĐỦ CHUẨN: Tạp chí quốc tế uy tín, phù hợp công bố kết quả nghiên cứu khoa học.`);
  } else if (matchedVn || matchedHdgs) {
    lines.push(`✅ ĐỦ CHUẨN QUỐC GIA: Đạt chuẩn khoa học Việt Nam 2026, tính điểm HĐGSNN và nghiệm thu đề tài NCKH trong nước.`);
  }

  lines.push(`\n` + getRandomFooterTip());
  return lines.join("\n").slice(0, 1950);
}

const FOOTER_TIPS = [
  "💡 MẸO HAY: Dán mã DOI (vd: 10.1016/j.jbusres.2021.08.043) để xem tên bài, tác giả & phí đăng bài (APC)!",
  "💡 MẸO HAY: Gõ '5' (hoặc 'vn') để xem 16 Tạp chí Việt Nam trong Scopus/WoS (có VJCS của NTTU, JABES, JED...)!",
  "💡 MẸO HAY: Gõ '2' để xem các tạp chí khối Kinh tế - Quản trị vừa bị Scopus loại bỏ gần đây.",
  "💡 MẸO HAY: Bạn có thể gõ từ viết tắt chuẩn như VJCS, JABES, JED, JSAMD, JBR, JCR... để tra cứu nhanh!",
  "💡 MẸO HAY: Hệ thống hỗ trợ tra cứu toàn bộ 341 tạp chí đạt Tiêu chuẩn Khoa học Việt Nam năm 2026."
];

function getRandomFooterTip() {
  const tip = FOOTER_TIPS[Math.floor(Math.random() * FOOTER_TIPS.length)];
  return `${tip}\n(Gõ '1' để mở bảng hướng dẫn | Nhắn mã ISSN/tên để tra tiếp).`;
}

const SAFE_DOMAIN_ALTERNATIVES = {
  accounting: [
    { name: "Journal of Accounting and Public Policy", issn: "0278-4254", note: "Elsevier, Scopus Q1, ABDC A, HĐGSNN 0-2.0đ" },
    { name: "International Review of Financial Analysis", issn: "1057-5219", note: "Elsevier, Scopus Q1, ABDC A, HĐGSNN 0-2.0đ" },
    { name: "Journal of Asian Business and Economic Studies", issn: "2515-964X", note: "UEH, Scopus Q1, ABDC B, Chuẩn VN 2026 STT 13" },
  ],
  marketing: [
    { name: "Journal of Business Research", issn: "0148-2963", note: "Elsevier, Scopus Q1, ABDC A, HĐGSNN 0-2.0đ" },
    { name: "Journal of Retailing and Consumer Services", issn: "0969-6989", note: "Elsevier, Scopus Q1, ABDC A, HĐGSNN 0-2.0đ" },
    { name: "Journal of Asian Business and Economic Studies", issn: "2515-964X", note: "UEH, Scopus Q1, ABDC B, HĐGSNN 0-2.0đ" },
  ],
  hospitality: [
    { name: "International Journal of Hospitality Management", issn: "0278-4319", note: "Elsevier, Scopus Q1, ABDC A*" },
    { name: "Journal of Hospitality and Tourism Management", issn: "1447-6770", note: "Elsevier, Scopus Q1, ABDC A" },
    { name: "Tourism Recreation Research", issn: "0250-8281", note: "Taylor & Francis, Scopus Q1, ABDC A" },
  ],
  sustainability: [
    { name: "Journal of Cleaner Production", issn: "0959-6526", note: "Elsevier, Scopus Q1, HĐGSNN 0-2.0đ" },
    { name: "Business Strategy and the Environment", issn: "0964-4733", note: "Wiley, Scopus Q1, ABDC A" },
    { name: "Sustainable Development", issn: "0968-0802", note: "Wiley, Scopus Q1, ABDC B" },
  ],
  economics: [
    { name: "Journal of Asian Business and Economic Studies", issn: "2515-964X", note: "UEH, Scopus Q1, ABDC B, HĐGSNN 0-2.0đ" },
    { name: "Journal of Economics and Development", issn: "1859-0020", note: "NEU, Scopus Q1, HĐGSNN 0-2.0đ" },
    { name: "Economic Analysis and Policy", issn: "0313-5926", note: "Elsevier, Scopus Q1, ABDC B" },
  ],
  technology: [
    { name: "International Journal of Information Management", issn: "0268-4012", note: "Elsevier, Scopus Q1, ABDC A*" },
    { name: "Technological Forecasting and Social Change", issn: "0040-1625", note: "Elsevier, Scopus Q1, ABDC A" },
    { name: "Expert Systems with Applications", issn: "0957-4174", note: "Elsevier, Scopus Q1, HĐGSNN 0-2.0đ" },
  ],
  general: [
    { name: "Journal of Business Research", issn: "0148-2963", note: "Elsevier, Scopus Q1, ABDC A, HĐGSNN 0-2.0đ" },
    { name: "Journal of Asian Business and Economic Studies", issn: "2515-964X", note: "UEH, Scopus Q1, ABDC B, Chuẩn VN STT 13" },
    { name: "Journal of Economics and Development", issn: "1859-0020", note: "NEU, Scopus Q1, Chuẩn VN STT 12" },
  ],
};

function getSafeAlternatives(title) {
  const t = (title || "").toLowerCase();
  if (t.includes("account") || t.includes("financ") || t.includes("bank")) return SAFE_DOMAIN_ALTERNATIVES.accounting;
  if (t.includes("market") || t.includes("consumer") || t.includes("retail")) return SAFE_DOMAIN_ALTERNATIVES.marketing;
  if (t.includes("hospital") || t.includes("touris") || t.includes("hotel") || t.includes("leisure")) return SAFE_DOMAIN_ALTERNATIVES.hospitality;
  if (t.includes("sustain") || t.includes("cleaner") || t.includes("ecolog") || t.includes("environ")) return SAFE_DOMAIN_ALTERNATIVES.sustainability;
  if (t.includes("econom") || t.includes("trade") || t.includes("fiscal")) return SAFE_DOMAIN_ALTERNATIVES.economics;
  if (t.includes("technol") || t.includes("comput") || t.includes("system") || t.includes("artifici") || t.includes("data")) return SAFE_DOMAIN_ALTERNATIVES.technology;
  return SAFE_DOMAIN_ALTERNATIVES.general;
}

/**
 * Trích xuất DOI từ văn bản người dùng (URL bài báo, xâu doi: 10.xxxx, hoặc dán link ScienceDirect/Springer...)
 */
function extractDoi(text) {
  if (!text) return null;
  const m = text.match(/\b(10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+)/i);
  return m ? m[1].replace(/[.,;)]+$/, "") : null;
}

/**
 * Tra cứu thông tin bài báo khoa học qua DOI (tích hợp OpenAlex & Crossref)
 */
async function resolveDoiMetadata(doi) {
  if (!doi) return null;

  // 1. Thử qua OpenAlex (có sẵn thông tin Tác giả, Tên bài, Tạp chí, ISSN, Phí APC)
  try {
    const oaUrl = `https://api.openalex.org/works/https://doi.org/${encodeURIComponent(doi)}`;
    const resp = await fetch(oaUrl, {
      headers: { "User-Agent": "ScopusBot/1.0 (mailto:admin@scopus-wos-bot.workers.dev)" },
    });
    if (resp.ok) {
      const data = await resp.json();
      const title = data.title || data.display_name || "";
      const journal = data.primary_location?.source?.display_name || "";
      const issns = data.primary_location?.source?.issn || [];
      const year = data.publication_year || "";
      const authors = (data.authorships || [])
        .slice(0, 3)
        .map((a) => a.author?.display_name)
        .filter(Boolean)
        .join(", ");
      const apc = data.apc_list ? `${data.apc_list.value} ${data.apc_list.currency}` : null;
      const citations = data.cited_by_count !== undefined ? data.cited_by_count : null;
      const oaUrl = data.open_access?.is_oa ? data.open_access?.oa_url : null;
      return {
        doi,
        title,
        journal,
        issns,
        year,
        authors: authors + ((data.authorships || []).length > 3 ? " et al." : ""),
        apc,
        citations,
        oa_url: oaUrl,
      };
    }
  } catch (e) {
    console.error("OpenAlex resolve error:", e);
  }

  // 2. Fallback qua Crossref REST API
  try {
    const crUrl = `https://api.crossref.org/works/${encodeURIComponent(doi)}`;
    const resp = await fetch(crUrl, {
      headers: { "User-Agent": "ScopusBot/1.0 (mailto:admin@scopus-wos-bot.workers.dev)" },
    });
    if (resp.ok) {
      const data = await resp.json();
      const item = data.message || {};
      const title = item.title?.[0] || "";
      const journal = item["container-title"]?.[0] || "";
      const issns = item.ISSN || [];
      const year =
        item.issued?.["date-parts"]?.[0]?.[0] ||
        item["published-print"]?.["date-parts"]?.[0]?.[0] ||
        "";
      const authors = (item.author || [])
        .slice(0, 3)
        .map((a) => `${a.given || ""} ${a.family || ""}`.trim())
        .filter(Boolean)
        .join(", ");
      return {
        doi,
        title,
        journal,
        issns,
        year,
        authors: authors + ((item.author || []).length > 3 ? " et al." : ""),
        apc: null,
      };
    }
  } catch (e) {
    console.error("Crossref resolve error:", e);
  }

  return null;
}

/**
 * Xử lý truy vấn thông minh: Tự động phát hiện DOI bài báo hoặc tra cứu Tạp chí
 */
async function resolveAndSearch(query, lookupDb) {
  const text = (query || "").trim();
  const cmd = text.toLowerCase();

  // 1. Phím tắt danh mục 28 Hội đồng GSNN (QĐ 26/QĐ-HĐGSNN)
  if (
    ["6", "hdgs", "/hdgs", "hoidong", "hội đồng", "hdgsnn"].includes(cmd) ||
    cmd.startsWith("hdgs ") ||
    cmd.startsWith("/hdgs ") ||
    cmd.startsWith("hoidong ")
  ) {
    return handleHdgsCommand(text, lookupDb);
  }

  // 2. Phím tắt danh mục ASEAN Citation Index (ACI)
  if (["aci", "/aci", "asean"].includes(cmd)) {
    return getAciListMessage(lookupDb);
  }

  // 3. Phím tắt tiêu chuẩn Quỹ NAFOSTED (QĐ 14/QĐ-HĐQL-NAFOSTED)
  if (["nafosted", "/nafosted", "nafos"].includes(cmd)) {
    return getNafostedGuideMessage(lookupDb);
  }

  // 4. Phím tắt Top 16 Tạp chí Việt Nam trong Scopus/WoS
  if (["5", "vn", "vietnam", "tcvn", "việt nam"].includes(cmd)) {
    return getVietnamScopusList(lookupDb);
  }

  // 5. Phím tắt Tạp chí Kinh tế bị loại khỏi Scopus
  if (["2", "kinhte", "kinh tế", "ds", "danh sách"].includes(cmd)) {
    return getBusinessDiscontinuedSamples(lookupDb);
  }

  // 6. Phím tắt Hướng dẫn
  if (["1", "help", "/help", "menu", "/menu", "huongdan", "hướng dẫn"].includes(cmd)) {
    return buildUserGuideMessage();
  }

  // 7. Tra cứu theo DOI
  const doi = extractDoi(text);

  if (doi) {
    const meta = await resolveDoiMetadata(doi);
    if (meta && (meta.journal || (meta.issns && meta.issns.length > 0))) {
      const qJournal = (meta.issns && meta.issns[0]) || meta.journal;
      const journalReport = searchJournal(qJournal, lookupDb);

      const lines = [
        `📄 THÔNG TIN BÀI BÁO KHOA HỌC (TRA CỨU THEO DOI):`,
        `• Tiêu đề bài: "${meta.title || "Đang cập nhật"}"`,
        meta.authors ? `• Tác giả: ${meta.authors}` : null,
        meta.year ? `• Năm công bố: ${meta.year}` : null,
        `• Mã DOI: https://doi.org/${meta.doi}`,
        `• Tạp chí đăng: ${meta.journal || "Không xác định"}`,
        meta.citations !== null && meta.citations !== undefined ? `• Trích dẫn học thuật: 📈 ${meta.citations.toLocaleString()} lượt (OpenAlex Index)` : null,
        meta.oa_url ? `• Toàn văn miễn phí (Open Access): 🔓 ${meta.oa_url}` : null,
        meta.apc ? `• Phí đăng bài tham khảo (APC): 💰 ${meta.apc}` : null,
        `───────────────────────────────────────`,
        journalReport,
      ].filter(Boolean);

      return lines.join("\n").slice(0, 1950);
    }
  }

  return searchJournal(text, lookupDb);
}

/**
 * Gửi tin nhắn phản hồi qua Zalo Bot API
 */
async function sendZaloMessage(botToken, chatId, text) {
  if (!botToken || !chatId) return { ok: false, error: "Missing token/chatId" };
  const url = `https://bot-api.zaloplatforms.com/bot${botToken}/sendMessage`;
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: String(chatId),
        text: String(text).slice(0, 1980),
      }),
    });
    const result = await resp.json().catch(() => ({ ok: false }));
    console.log(`[sendZaloMessage to ${chatId}] result:`, JSON.stringify(result));
    return result;
  } catch (e) {
    console.error(`[sendZaloMessage error]:`, e);
    return { ok: false, error: e.message };
  }
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
 * Xử lý 1 bản ghi cập nhật đến từ người dùng Zalo
 */

/**
 * Tra cứu danh mục 28 Hội đồng Giáo sư Nhà nước theo QĐ 26/QĐ-HĐGSNN
 */
function handleHdgsCommand(query, lookupDb) {
  const councils = lookupDb.hdgs_councils || {};
  const cleaned = cleanVnJournalName(query).replace(/^hdgs\s*/, '').replace(/^hoidong\s*/, '').trim();

  if (!cleaned || cleaned === '6' || cleaned === 'menu' || cleaned === 'ds') {
    return (
      `🏛️ DANH MỤC 28 HỘI ĐỒNG GIÁO SƯ NHÀ NƯỚC (QĐ 26/QĐ-HĐGSNN)\n` +
      `Cơ sở dữ liệu: Đầy đủ 28 Hội đồng ngành/liên ngành • Hơn 1.400 tạp chí\n` +
      `───────────────────────────────────────\n` +
      `⚙️ KHỐI KỸ THUẬT & CÔNG NGHỆ:\n` +
      `• CNTT: hdgs cntt (18 TC)\n` +
      `• Cơ học: hdgs co_hoc (54 TC)\n` +
      `• Cơ khí - Động lực: hdgs co_khi (56 TC)\n` +
      `• Điện - Điện tử: hdgs dien_tu (34 TC)\n` +
      `• Giao thông vận tải: hdgs giao_thong (41 TC)\n` +
      `• Xây dựng - Kiến trúc: hdgs xay_dung (62 TC)\n` +
      `• Thủy lợi: hdgs thuy_loi (55 TC)\n` +
      `• Trái đất - Mỏ: hdgs trai_dat (52 TC)\n\n` +
      `🌿 KHỐI KHOA HỌC TỰ NHIÊN & SỰ SỐNG:\n` +
      `• Toán học: hdgs toan (5 TC)\n` +
      `• Vật lý: hdgs vat_ly (25 TC)\n` +
      `• Hóa học - CN Thực phẩm: hdgs hoa_hoc (69 TC)\n` +
      `• Sinh học: hdgs sinh_hoc (74 TC)\n` +
      `• Y học: hdgs y_hoc (76 TC)\n` +
      `• Dược học: hdgs duoc (48 TC)\n` +
      `• Nông - Lâm nghiệp: hdgs nong_lam (56 TC)\n` +
      `• Chăn nuôi - Thủy sản: hdgs chan_nuoi (30 TC)\n\n` +
      `📚 KHỐI KHOA HỌC XÃ HỘI & NHÂN VĂN:\n` +
      `• Kinh tế: hdgs kinh_te (53 TC)\n` +
      `• Luật học: hdgs luat (52 TC)\n` +
      `• Khoa học giáo dục: hdgs giao_duc (74 TC)\n` +
      `• Ngôn ngữ học: hdgs ngon_ngu (67 TC)\n` +
      `• Văn học: hdgs van_hoc (60 TC)\n` +
      `• Văn hóa - NT - TDTT: hdgs van_hoa (94 TC)\n` +
      `• Sử học - Nhân học: hdgs su_hoc (67 TC)\n` +
      `• Triết - Chính trị - Xã hội: hdgs triet (102 TC)\n` +
      `• Tâm lý học: hdgs tam_ly (41 TC)\n` +
      `• An ninh: hdgs an_ninh (34 TC)\n` +
      `• Quân sự: hdgs quan_su (37 TC)\n` +
      `───────────────────────────────────────\n` +
      `💡 Cú pháp: Nhắn 'hdgs <tên ngành>' (ví dụ: hdgs y hoc, hdgs cntt, hdgs toan, hdgs luat, hdgs kinh te...) để xem danh sách tạp chí điểm cao nhất.`
    );
  }

  const aliasMap = {
    'y hoc': 'y_hoc', 'y': 'y_hoc', 'y khoa': 'y_hoc', 'y te': 'y_hoc', 'medicine': 'y_hoc',
    'cntt': 'cntt', 'it': 'cntt', 'cong nghe thong tin': 'cntt', 'thong tin': 'cntt',
    'toan': 'toan_hoc', 'toan hoc': 'toan_hoc', 'math': 'toan_hoc',
    'duoc': 'duoc_hoc', 'duoc hoc': 'duoc_hoc', 'pharmacy': 'duoc_hoc',
    'luat': 'luat_hoc', 'luat hoc': 'luat_hoc', 'law': 'luat_hoc',
    'kinh te': 'kinh_te', 'kinhte': 'kinh_te', 'kt': 'kinh_te', 'economics': 'kinh_te',
    'hoa': 'hoa_hoc', 'hoa hoc': 'hoa_hoc', 'chemistry': 'hoa_hoc',
    'ly': 'vat_ly', 'vat ly': 'vat_ly', 'physics': 'vat_ly',
    'sinh': 'sinh_hoc', 'sinh hoc': 'sinh_hoc', 'biology': 'sinh_hoc',
    'su': 'su_hoc', 'su hoc': 'su_hoc', 'history': 'su_hoc',
    'van': 'van_hoc', 'van hoc': 'van_hoc', 'literature': 'van_hoc',
    'gd': 'giao_duc', 'giao duc': 'giao_duc', 'su pham': 'giao_duc',
    'co hoc': 'co_hoc', 'co khi': 'co_khi', 'dien': 'dien_tu', 'dien tu': 'dien_tu',
    'giao thong': 'giao_thong', 'gtvt': 'giao_thong', 'xay dung': 'xay_dung',
    'thuy loi': 'thuy_loi', 'trai dat': 'trai_dat_mo', 'mo': 'trai_dat_mo',
    'chan nuoi': 'chan_nuoi', 'thu y': 'chan_nuoi', 'thuy san': 'chan_nuoi',
    'nong lam': 'nong_lam', 'nong nghiep': 'nong_lam', 'lam nghiep': 'nong_lam',
    'tam ly': 'tam_ly', 'an ninh': 'an_ninh', 'quan su': 'quan_su',
    'triet': 'triet_hoc', 'triet hoc': 'triet_hoc', 'xa hoi': 'triet_hoc',
    'van hoa': 'van_hoa_nt', 'the thao': 'van_hoa_nt', 'ngon ngu': 'ngon_ngu'
  };

  let targetCouncil = null;
  if (aliasMap[cleaned] && councils[aliasMap[cleaned]]) {
    targetCouncil = councils[aliasMap[cleaned]];
  }

  if (!targetCouncil) {
    for (const [k, c] of Object.entries(councils)) {
      if (cleaned === k || cleaned === cleanVnJournalName(c.name)) {
        targetCouncil = c;
        break;
      }
    }
  }

  if (!targetCouncil) {
    for (const [k, c] of Object.entries(councils)) {
      const normName = cleanVnJournalName(c.name);
      if (normName.startsWith(cleaned) || k.startsWith(cleaned)) {
        targetCouncil = c;
        break;
      }
    }
  }

  if (!targetCouncil && cleaned.length >= 4) {
    for (const [k, c] of Object.entries(councils)) {
      const normName = cleanVnJournalName(c.name);
      if (normName.includes(cleaned) || cleaned.includes(normName)) {
        targetCouncil = c;
        break;
      }
    }
  }

  if (!targetCouncil) {
    return (
      `⚠️ Không tìm thấy Hội đồng ngành phù hợp với từ khóa '${query}'.\n\n` +
      `💡 Bạn có thể gõ '6' để xem danh sách 28 Hội đồng ngành hoặc thử lại với: hdgs cntt, hdgs y hoc, hdgs toan, hdgs kinh te, hdgs luat...`
    );
  }

  let res =
    `🏛️ HỘI ĐỒNG GIÁO SƯ NGÀNH: ${targetCouncil.name.toUpperCase()}\n` +
    `📋 Căn cứ: Quyết định 26/QĐ-HĐGSNN ngày 11/07/2025\n` +
    `📊 Tổng số tạp chí trong nước tính điểm: ${targetCouncil.total} tạp chí\n` +
    `───────────────────────────────────────\n` +
    `⭐ TOP TẠP CHÍ ĐIỂM TRẦN CAO NHẤT:\n\n`;

  const topList = targetCouncil.top_journals || [];
  topList.forEach((j, idx) => {
    res += `${idx + 1}. ${j.title}\n`;
    res += `   • Điểm: 🎯 ${j.points}\n`;
    if (j.issn) res += `   • ISSN: ${j.issn}\n`;
  });

  res +=
    `\n───────────────────────────────────────\n` +
    `💡 Nhắn Tên tạp chí hoặc mã ISSN bất kỳ để tra cứu điểm liên ngành & xếp hạng Scopus/WoS!`;

  return res;
}


/**
 * Danh mục tạp chí Việt Nam trong hệ thống ASEAN Citation Index (ACI)
 */
function getAciListMessage(lookupDb) {
  const aciData = lookupDb.aci_journals || {};
  const rawList = aciData.raw_list || [];

  let res =
    `🌏 DANH MỤC TẠP CHÍ VIỆT NAM TRONG ASEAN CITATION INDEX (ACI)\n` +
    `📋 Tình trạng: ${rawList.length} tạp chí khoa học Việt Nam được chỉ mục\n` +
    `⚖️ Giá trị pháp lý: Tính điểm xét PGS/GS tối đa 1,25 điểm & quy chế Tiến sĩ Bộ GD&ĐT\n` +
    `───────────────────────────────────────\n`;

  rawList.forEach((j, idx) => {
    res += `${idx + 1}. ${j.title}\n`;
    res += `   • Đơn vị: ${j.org}\n`;
    res += `   • ISSN: ${[j.pissn, j.eissn].filter(Boolean).join(' | ')} | Lĩnh vực: ${j.field}\n`;
  });

  res +=
    `\n───────────────────────────────────────\n` +
    `💡 Bạn có thể nhắn mã ISSN hoặc Tên bất kỳ tạp chí nào ở trên để thẩm định chi tiết!`;

  return res;
}

/**
 * Hướng dẫn tra cứu tiêu chuẩn Quỹ NAFOSTED (QĐ 14/QĐ-HĐQL-NAFOSTED)
 */
function getNafostedGuideMessage(lookupDb) {
  const nafData = lookupDb.nafosted_national || {};
  const rawList = nafData.raw_list || [];

  let res =
    `🏛️ TIÊU CHUẨN CÔNG BỐ QUỸ NAFOSTED (QĐ 14/QĐ-HĐQL-NAFOSTED)\n` +
    `───────────────────────────────────────\n` +
    `1️⃣ TẠP CHÍ QUỐC TẾ CÓ UY TÍN NAFOSTED:\n` +
    `• Khối KHXH&NV: Các tạp chí Scopus Q1, Q2, Q3 (theo SCImago) không thuộc Beall's List\n` +
    `• Khối KHTN&KT: Các tạp chí SCIE (Web of Science) Q1, Q2, Q3 không thuộc Beall's List\n` +
    `↳ Hệ thống Bot tự động nhận diện và gắn nhãn 'ĐẠT CHUẨN QUỐC TẾ UY TÍN NAFOSTED' khi bạn tra cứu!\n\n` +
    `2️⃣ DANH MỤC TẠP CHÍ QUỐC GIA CÓ UY TÍN (${rawList.length} TẠP CHÍ TIÊU BIỂU):\n`;

  rawList.slice(0, 15).forEach((j, idx) => {
    res += `• ${j.title} (${j.council}) - ISSN: ${j.pissn || j.eissn}\n`;
  });

  res +=
    `• (+ ${rawList.length - 15} tạp chí chuyên ngành khác)\n\n` +
    `───────────────────────────────────────\n` +
    `💡 Gõ Tên hoặc mã ISSN để kiểm tra xem bài viết của bạn có đủ chuẩn nghiệm thu đề tài NAFOSTED không!`;

  return res;
}

async function processZaloIncomingMessage(env, botToken, update) {
  if (!update) return false;

  const msgObj = update.message || update;
  const senderObj = update.sender || update.from || {};
  const chatObj = update.chat || update.message?.chat || {};

  const chatId =
    senderObj.id ||
    chatObj.id ||
    msgObj.chat?.id ||
    msgObj.from?.id ||
    update.chat_id ||
    update.sender_id;

  const displayName =
    senderObj.display_name ||
    senderObj.name ||
    msgObj.from?.display_name ||
    "bạn";

  const text = (msgObj.text || update.text || "").trim();

  // Ghi log qua console.log (tiết kiệm 100% quota KV Write hàng ngày)
  console.log(`[Zalo Update received] ChatId: ${chatId} (${displayName}): "${text}"`);

  if (!chatId) {
    console.error("Không tìm thấy chatId trong update:", update);
    return false;
  }

  // Xử lý sự kiện tin nhắn dạng link preview / unsupported của Zalo
  if (update.event_name === "message.unsupported.received" || (!text && String(update.event_name || "").includes("unsupported"))) {
    const tipText =
      `💡 MẸO TRA CỨU THEO DOI TRÊN ZALO:\n\n` +
      `Khi dán link có tiền tố "https://", ứng dụng Zalo tự động tạo Thẻ xem trước (Link Preview) và mã hóa nội dung nên Bot không nhận được văn bản.\n\n` +
      `👉 Bạn chỉ cần gửi trực tiếp MÃ DOI (không kèm "https://doi.org/").\n` +
      `Ví dụ gửi:\n` +
      `10.1016/j.jbusres.2021.08.043\n\n` +
      `Hệ thống sẽ lập tức trả về thông tin bài báo, phí APC và thẩm định tạp chí!`;
    await sendZaloMessage(botToken, chatId, tipText);
    return true;
  }

  try {
    const subs = await getSubscribers(env);
    const isNewUser = !subs[String(chatId)];
    if (isNewUser) {
      await addSubscriber(env, chatId, displayName);
    }

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

    const isHelpIntent =
      !text ||
      helpTriggers.includes(cmd) ||
      cmd.includes("hướng dẫn") ||
      cmd.includes("huong dan") ||
      cmd.includes("cách dùng") ||
      cmd.includes("cach dung") ||
      cmd.includes("làm sao") ||
      cmd.includes("lam sao") ||
      cmd.includes("tính năng") ||
      cmd.includes("tinh nang") ||
      cmd.includes("chức năng") ||
      cmd.includes("trợ giúp") ||
      cmd.includes("tro giup") ||
      cmd.includes("bạn là ai") ||
      cmd.includes("bot là gì");

    if (isHelpIntent) {
      replyText = buildUserGuideMessage(displayName, isNewUser);
    } else if (["2", "kinhte", "kinh tế", "ds", "danh sách"].includes(cmd)) {
      const db = await getLookupDatabase();
      replyText = getBusinessDiscontinuedSamples(db);
    } else if (["3", "thongke", "/thongke", "stats", "status"].includes(cmd)) {
      const db = await getLookupDatabase();
      const updatedSubs = await getSubscribers(env);
      replyText =
        `📊 CƠ SỞ DỮ LIỆU ĐA NGUỒN CỦA BOT (ĐÃ ĐỒNG BỘ 100%):\n` +
        `───────────────────────────────────────\n` +
        `1️⃣ NGUỒN TRA CỨU HỌC THUẬT:\n` +
        `• SCImago Scopus SJR: ${Object.keys(db.sjr_rankings || {}).length.toLocaleString()} tạp chí quốc tế (Q1-Q4)\n` +
        `• Danh mục ABDC (Úc): ${Object.keys(db.abdc_rankings || {}).length.toLocaleString()} tạp chí (A*, A, B, C)\n` +
        `• Chuẩn Khoa học Quốc gia VN: ${(db.vn_standards_2026 || []).length} tạp chí (gồm 16 tạp chí Scopus/WoS)\n` +
        `• 28 Hội đồng GSNN: Đầy đủ 28/28 Hội đồng ngành/liên ngành\n\n` +
        `2️⃣ HỆ THỐNG CẢNH BÁO RỦI RO & SĂN MỒI:\n` +
        `• Scopus Discontinued (bị loại): ${(db.discontinued_journals || []).length.toLocaleString()} tạp chí\n` +
        `• WoS Delisted (bị tước chỉ mục): ${(db.wos_delisted_journals || []).length} tạp chí quốc tế\n` +
        `• Tạp chí Giả mạo (Hijacked): ${(db.hijacked_journals || []).length} website lừa đảo (Retraction Watch + Beall)\n` +
        `• Beall's List (Tạp chí săn mồi): ${(db.beall_standalone_journals || []).length.toLocaleString()} tạp chí độc lập\n` +
        `• Beall's List (NXB săn mồi): ${(db.beall_publishers || []).length.toLocaleString()} nhà xuất bản\n` +
        `• Retraction Watch: ${Object.keys(db.retraction_counts_by_journal || {}).length.toLocaleString()} tạp chí có bài bị rút\n\n` +
        `👥 Thành viên nhận thông báo: ${Object.keys(updatedSubs).length} nhà nghiên cứu\n` +
        `💡 Gõ '1' để xem hướng dẫn | Nhắn mã ISSN/tên để tra cứu ngay.`;
    } else if (["4", "dangky", "/dangky", "subscribe"].includes(cmd)) {
      const total = await addSubscriber(env, chatId, displayName);
      replyText =
        `✅ ${displayName} đã bật nhận cảnh báo định kỳ thành công (Tổng số: ${total} thành viên).\n` +
        `Mỗi khi Scopus công bố danh sách tạp chí bị loại tháng mới hoặc Retraction Watch có biến động lớn, Bot sẽ tự động nhắn cho bạn.\n\n` +
        `💡 Gõ '1' để xem hướng dẫn tra cứu | Gõ 'huy' nếu muốn tắt thông báo định kỳ.`;
    } else if (["huy", "/huy", "unsubscribe", "/stop"].includes(cmd)) {
      await removeSubscriber(env, chatId);
      replyText =
        "✅ Đã tắt thông báo định kỳ. Bạn vẫn có thể nhắn Tên tạp chí hoặc mã ISSN bất cứ lúc nào để tra cứu!";
    } else if (["5", "vn", "vietnam", "tcvn", "việt nam"].includes(cmd)) {
      const db = await getLookupDatabase();
      replyText = getVietnamScopusList(db);
    } else if (
      ["6", "hdgs", "/hdgs", "hoidong", "hội đồng", "hdgsnn"].includes(cmd) ||
      cmd.startsWith("hdgs ") ||
      cmd.startsWith("/hdgs ") ||
      cmd.startsWith("hoidong ")
    ) {
      const db = await getLookupDatabase();
      replyText = handleHdgsCommand(text, db);
    } else if (["aci", "/aci", "asean"].includes(cmd)) {
      const db = await getLookupDatabase();
      replyText = getAciListMessage(db);
    } else if (["nafosted", "/nafosted", "nafos"].includes(cmd)) {
      const db = await getLookupDatabase();
      replyText = getNafostedGuideMessage(db);
    } else {
      const db = await getLookupDatabase();
      replyText = await resolveAndSearch(text, db);
      if (isNewUser) {
        replyText =
          `👋 Chào ${displayName}! (Gõ '1' bất cứ lúc nào để xem bảng hướng dẫn sử dụng).\n\n` +
          replyText;
      }
    }

    await sendZaloMessage(botToken, chatId, replyText);
    return true;
  } catch (err) {
    await sendZaloMessage(
      botToken,
      chatId,
      `⚠️ Có lỗi xảy ra khi tra cứu: ${err.message}`
    );
    return false;
  }
}

/**
 * Thực hiện đúng 1 chu kỳ Long-Polling (getUpdates) an toàn (khoảng 10-15s) dưới ngưỡng 30s của Cloudflare
 */
async function pollZaloUpdatesLoop(env) {
  const botToken =
    env.ZALO_BOT_TOKEN || (await env.SCOPUS_BOT_KV.get("ZALO_BOT_TOKEN"));
  if (!botToken) return { ok: false, reason: "No ZALO_BOT_TOKEN" };

  const startTime = Date.now();
  let processedCount = 0;
  let lastDebug = null;

  // Nếu có tin nhắn đến ngay (trả về trong < 1s), tiếp tục lắng nghe thêm trong phạm vi 12 giây
  while (Date.now() - startTime < 12000) {
    try {
      const resp = await fetch(
        `https://bot-api.zaloplatforms.com/bot${botToken}/getUpdates`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128.0.0.0",
          },
          body: JSON.stringify({ timeout: 10 }),
        }
      );
      const rawText = await resp.text();
      let data = {};
      try {
        data = JSON.parse(rawText);
      } catch {
        data = { raw: rawText.slice(0, 300) };
      }
      lastDebug = { status: resp.status, data };

      if (data && data.ok && data.result) {
        const items = Array.isArray(data.result) ? data.result : [data.result];
        for (const item of items) {
          if (item) {
            await processZaloIncomingMessage(env, botToken, item);
            processedCount++;
          }
        }
      } else {
        // Nếu timeout 408 (đã chờ đủ ~10-15s trên Zalo server), thoát vòng lặp ngay để không vượt 30s
        break;
      }
    } catch (err) {
      lastDebug = { error: err.message };
      break;
    }
  }

  // Ghi log qua console.log (tiết kiệm 100% quota KV Write hàng ngày)
  console.log(`[Zalo Poll finished] Duration: ${Date.now() - startTime}ms, Processed: ${processedCount}`);
  return { ok: true, processedCount, durationMs: Date.now() - startTime, lastDebug };
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
          <button onclick="setupZalo()">Cập nhật Token</button>
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
      box.textContent = 'Đang lưu cấu hình Zalo Bot...';
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
        const result = await resolveAndSearch(q, db);
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

        // Xóa webhook để bật chế độ Long-Polling (getUpdates) không bị chặn bởi Cloudflare WAF
        const delResp = await fetch(
          `https://bot-api.zaloplatforms.com/bot${botToken}/deleteWebhook`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
          }
        );
        const delData = await delResp.json().catch(() => ({}));

        await env.SCOPUS_BOT_KV.put("ZALO_BOT_TOKEN", botToken);

        // Kích hoạt quét ngay lập tức
        ctx.waitUntil(pollZaloUpdatesLoop(env, 25000));

        return Response.json({
          ok: true,
          mode: "Cloudflare Continuous Long-Polling (24/7)",
          zalo_response: delData,
          message:
            "✅ Đã kết nối Zalo Bot thành công! Bây giờ bạn và mọi người có thể nhắn tên tạp chí hoặc ISSN vào Zalo Bot để tra cứu ngay.",
        });
      } catch (err) {
        return Response.json({ ok: false, error: err.message }, { status: 500 });
      }
    }

    // 4. Webhook nhận tin nhắn thời gian thực từ Zalo Bot (qua Google Apps Script Proxy)
    if (path === "/webhook/zalo") {
      if (request.method === "GET") {
        return Response.json({ ok: true, status: "Zalo webhook ready" });
      }

      if (request.method === "POST") {
        let payload = {};
        try {
          payload = await request.json();
        } catch {
          return Response.json({ ok: true, note: "Empty body" });
        }

        const botToken =
          env.ZALO_BOT_TOKEN || (await env.SCOPUS_BOT_KV.get("ZALO_BOT_TOKEN"));

        // Xử lý sự kiện tin nhắn bất đồng bộ để trả về 200 OK ngay cho Zalo
        ctx.waitUntil(
          (async () => {
            try {
              await processZaloIncomingMessage(env, botToken, payload);
            } catch (err) {
              console.error("[Webhook Error]:", err);
            }
          })()
        );

        return Response.json({ ok: true, status: "Event received" });
      }
    }

    // 5. Endpoint kích hoạt quét tin nhắn tức thì & Ping-Pong giữa 2 Worker phủ kín 60/60 giây (/api/poll)
    if (path === "/api/poll") {
      const step = parseInt(url.searchParams.get("step") || "0", 10);
      const result = await pollZaloUpdatesLoop(env);

      if (step >= 1 && step < 4) {
        const nextHost = url.hostname.includes("scopus-wos-poller")
          ? "https://scopus-wos-zalo-bot.nttu-kts-johntroger.workers.dev"
          : "https://scopus-wos-poller.nttu-kts-johntroger.workers.dev";
        ctx.waitUntil(
          fetch(`${nextHost}/api/poll?step=${step + 1}`, {
            headers: { "User-Agent": "Mozilla/5.0 Cloudflare-Relay" },
          }).catch(() => {})
        );
      }
      return Response.json({ ...result, step });
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

  // 6. Cloudflare Cron Trigger chạy tự động mỗi 60 giây (* * * * *) để nhận tin nhắn Zalo
  async scheduled(event, env, ctx) {
    // Tự động giữ RAM ấm (Pre-warm In-Memory Cache) để người dùng nhắn tin không bị độ trễ Cold-Start
    if (!memoryCache.data) {
      ctx.waitUntil(getLookupDatabase().catch(() => {}));
    }
    ctx.waitUntil(pollZaloUpdatesLoop(env));
  },
};
