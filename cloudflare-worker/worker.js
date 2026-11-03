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
    ? `👋 Chào mừng ${displayName} đến với Bot Thẩm định Tạp chí Khoa học Quốc tế & Quốc gia!\n(Hệ thống đã tự động bật thông báo định kỳ cho bạn).\n\n`
    : `📖 CẨM NANG TRA CỨU TẠP CHÍ KHOA HỌC (SCOPUS, WOS, ABDC & CHUẨN VIỆT NAM)\n\n`;

  return (
    header +
    `🔎 CÁCH 1: TRA CỨU TRỰC TIẾP (TẠP CHÍ HOẶC BÀI BÁO)\n` +
    `Bạn chỉ cần nhắn trực tiếp bất kỳ thông tin nào sau đây:\n` +
    `• Link bài báo / Mã DOI: Dán link https://doi.org/... để bot tự tra tên bài, tác giả, phí APC và thẩm định tạp chí mẹ\n` +
    `• Mã ISSN quốc tế: 0148-2963 hoặc 2515-964X\n` +
    `• Tên viết tắt chuẩn: JABES, JED, JBR, JCR, JBE, MISQ, AMJ...\n` +
    `• Tạp chí Việt Nam: Kinh tế và Quản lý, Tạp chí Cộng sản, Kinh tế và Phát triển...\n\n` +
    `📋 CƠ SỞ DỮ LIỆU TÍCH HỢP:\n` +
    `1. Scopus Discontinued (Tạp chí bị loại trừ mới nhất)\n` +
    `2. Retraction Watch (Dữ liệu bài báo bị rút / đính chính toàn cầu)\n` +
    `3. SCImago Journal Rank (SJR Q1 - Q4 Scopus)\n` +
    `4. Bảng xếp hạng Kinh tế Úc ABDC (Hạng A*, A, B, C)\n` +
    `5. Danh mục 341 Tạp chí đạt Tiêu chuẩn Khoa học Việt Nam năm 2026\n` +
    `6. Khung điểm công trình HĐGSNN ngành Kinh tế (Quyết định 26/QĐ-HĐGSNN)\n` +
    `7. Crossref & OpenAlex (Tra cứu tự động qua DOI & kiểm tra phí APC)\n\n` +
    `⌨️ PHÍM TẮT NHANH:\n` +
    `• Gõ 1 : Xem hướng dẫn tra cứu\n` +
    `• Gõ 2 : Xem các tạp chí Kinh tế bị loại khỏi Scopus\n` +
    `• Gõ 3 : Xem phiên bản dữ liệu & trạng thái kết nối\n` +
    `• Gõ 4 : Đăng ký nhận thông báo định kỳ (Gõ 'huy' để tắt)\n\n` +
    `👉 Hãy thử nhắn ngay: JABES hoặc https://doi.org/10.1016/j.jbusres.2021.08.043`
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
  ktpt: "journal of economics and development"
};

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

  // 1. So khớp Tạp chí Giả mạo / Cướp tên miền (Hijacked)
  let matchedHijacked = null;
  for (const h of hijackedList) {
    const hIssn = normalizeIssn(h.issn || "");
    if (
      (normQIssn && normQIssn.length === 8 && normQIssn === hIssn) ||
      h.title.toLowerCase().includes(resolvedQuery)
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
    } else if (title.toLowerCase().includes(resolvedQuery)) {
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
        if (title.includes(resolvedQuery)) {
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
      } else if (title.includes(resolvedQuery)) {
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
      if (tClean.includes(cleanQVn) || (cleanQVn.length >= 8 && cleanQVn.includes(tClean))) {
        matchedVn = item;
        break;
      }
      if (item.aliases && item.aliases.some((a) => {
        const aClean = cleanVnJournalName(a);
        return aClean.includes(cleanQVn) || (cleanQVn.length >= 8 && cleanQVn.includes(aClean));
      })) {
        matchedVn = item;
        break;
      }
    }
  }

  // 6. Tra cứu Khung điểm Hội đồng Giáo sư Nhà nước ngành Kinh tế (QĐ 26/QĐ-HĐGSNN)
  let matchedHdgs = null;
  for (const [title, info] of Object.entries(hdgsJournals)) {
    const tNorm = normalizeVnText(title);
    const tClean = cleanVnJournalName(title);
    const infoIssns = String(info.issn || "").split(",").map(normalizeIssn).filter(Boolean);

    if (normQIssn && normQIssn.length === 8 && infoIssns.includes(normQIssn)) {
      matchedHdgs = { title, ...info };
      break;
    }
    if (tNorm === normQVn || tClean === cleanQVn) {
      matchedHdgs = { title, ...info };
      break;
    }
  }

  if (!matchedHdgs && cleanQVn.length >= 4) {
    for (const [title, info] of Object.entries(hdgsJournals)) {
      const tClean = cleanVnJournalName(title);
      if (tClean.includes(cleanQVn) || (cleanQVn.length >= 8 && cleanQVn.includes(tClean))) {
        matchedHdgs = { title, ...info };
        break;
      }
    }
  }

  if (!matchedHdgs && matchedVn) {
    const vnNorm = normalizeVnText(matchedVn.title);
    const vnClean = cleanVnJournalName(matchedVn.title);
    for (const [title, info] of Object.entries(hdgsJournals)) {
      const tNorm = normalizeVnText(title);
      const tClean = cleanVnJournalName(title);
      if (tNorm === vnNorm || tClean === vnClean || tClean.includes(vnClean) || vnClean.includes(tClean)) {
        matchedHdgs = { title, ...info };
        break;
      }
    }
  }

  // 7. Tra cứu Retraction Watch
  const targetJournalName = matchedDisc?.title || sjrTitle || abdcTitle || matchedVn?.title || matchedHdgs?.title || matchedHijacked?.title || resolvedQuery;
  let retractionCount = 0;
  for (const [jName, cnt] of Object.entries(retractionMap)) {
    if (
      jName.toLowerCase().includes(targetJournalName.toLowerCase()) ||
      targetJournalName.toLowerCase().includes(jName.toLowerCase())
    ) {
      retractionCount = Math.max(retractionCount, cnt);
    }
  }

  // TRƯỜNG HỢP: KHÔNG TÌM THẤY TẠP CHÍ NÀO TRONG MỌI NGUỒN DỮ LIỆU
  if (!matchedDisc && !matchedHijacked && !matchedSjr && !matchedAbdc && !matchedVn && !matchedHdgs) {
    const suggestions = [];
    const queryTokens = qLower.split(/[\s\-:,/]+/).filter((t) => t.length >= 3 && !STOPWORDS.has(t));
    if (queryTokens.length > 0) {
      for (const [t, info] of Object.entries(sjrMap)) {
        if (queryTokens.some((tok) => t.includes(tok))) {
          suggestions.push(`• ${toTitleCase(t)} (ISSN: ${formatIssn(info.issn)})`);
          if (suggestions.length >= 3) break;
        }
      }
      if (suggestions.length < 3) {
        for (const item of vnList) {
          const tClean = cleanVnJournalName(item.title);
          if (queryTokens.some((tok) => tClean.includes(tok))) {
            suggestions.push(`• ${toTitleCase(item.title)} (Chuẩn VN 2026 STT: ${item.stt})`);
            if (suggestions.length >= 3) break;
          }
        }
      }
    }

    const lines = [
      `🔍 KẾT QUẢ TRA CỨU: "${q}"`,
      `\n❓ KHÔNG TÌM THẤY TRONG CSDL KHOA HỌC (SCOPUS / ABDC / CHUẨN VN 2026 / HĐGSNN)`,
      `Hệ thống không tìm thấy tạp chí nào khớp với từ khóa bạn vừa nhập.`,
      `\n💡 GỢI Ý CHO BẠN:`,
      `1. Nhắn mã ISSN chính xác (ví dụ: 0148-2963 hoặc 2515-964X).`,
      `2. Nhập tên tạp chí tiếng Việt (ví dụ: "Kinh tế và Phát triển", "Tạp chí Cộng sản", "Kinh tế và Quản lý").`,
      `3. Nhập từ viết tắt chuẩn (ví dụ: JABES, JED, JBR, JCR, JBE...).`
    ];

    if (suggestions.length > 0) {
      lines.push(`\n👉 CÓ THỂ BẠN ĐANG TÌM:`);
      lines.push(...suggestions);
    }

    return lines.join("\n").slice(0, 1950);
  }

  // TRƯỜNG HỢP: TÌM THẤY TẠP CHÍ -> XUẤT BÁO CÁO THẨM ĐỊNH HỌC THUẬT TOÀN DIỆN
  const finalTitle = toTitleCase(
    matchedVn?.title ||
    matchedHdgs?.title ||
    matchedDisc?.title ||
    sjrTitle ||
    abdcTitle ||
    matchedHijacked?.title ||
    q
  );

  const finalIssn = formatIssn(
    matchedHdgs?.issn ||
    matchedDisc?.issn ||
    matchedDisc?.eissn ||
    matchedSjr?.issn ||
    matchedAbdc?.issn ||
    matchedHijacked?.issn ||
    "Đang cập nhật"
  );

  const orgPublisher = matchedVn?.org || matchedHdgs?.org || matchedDisc?.publisher || "";

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

  // PHẦN 3: TIÊU CHUẨN KHOA HỌC VIỆT NAM (2026) & ĐIỂM HĐGSNN
  if (matchedVn || matchedHdgs || matchedSjr) {
    lines.push(`\n🇻🇳 2. TIÊU CHUẨN VIỆT NAM & ĐIỂM HĐGSNN:`);
    if (matchedVn) {
      lines.push(`• Chuẩn khoa học VN 2026: ✅ ĐẠT TIÊU CHUẨN QUỐC GIA (STT: ${matchedVn.stt} / 341)`);
      lines.push(`• Phân nhóm: ${matchedVn.cat}`);
    } else if (matchedSjr || matchedAbdc) {
      lines.push(`• Chuẩn khoa học VN 2026: Tạp chí quốc tế (công nhận tính điểm theo quy chế đào tạo & HĐGSNN)`);
    }

    // Điểm HĐGSNN Kinh tế theo Quyết định 26/QĐ-HĐGSNN
    let hdgsPointStr = "";
    if (matchedHdgs?.points) {
      hdgsPointStr = `🎯 ${matchedHdgs.points} (HĐGS ngành Kinh tế - QĐ 26/QĐ-HĐGSNN)`;
    } else if (matchedSjr?.quartile === "Q1") {
      hdgsPointStr = `🎯 0 - 2,0 điểm (Scopus Q1 / Quyết định 26/QĐ-HĐGSNN)`;
    } else if (matchedSjr?.quartile) {
      hdgsPointStr = `🎯 0 - 1,5 điểm (Scopus ${matchedSjr.quartile} / Quyết định 26/QĐ-HĐGSNN)`;
    }

    if (hdgsPointStr) {
      lines.push(`• Điểm công trình HĐGSNN: ${hdgsPointStr}`);
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
  if (!matchedHijacked) {
    lines.push(`• Tạp chí giả mạo: ✅ AN TOÀN (Chưa ghi nhận website cướp tên miền)`);
  }
  if (retractionCount > 0) {
    lines.push(`• Lịch sử rút bài (Retraction Watch): ⚠️ Có ${retractionCount} bài từng bị rút/đính chính`);
  } else {
    lines.push(`• Lịch sử rút bài (Retraction Watch): ✅ 0 bài bị rút (Chỉ số liêm chính cao)`);
  }

  // PHẦN 6: KHUYẾN NGHỊ NỘP BÀI (VERDICT)
  lines.push(`\n🎯 5. KHUYẾN NGHỊ NỘP BÀI (VERDICT):`);
  if (matchedDisc || matchedHijacked) {
    lines.push(`⛔ TUYỆT ĐỐI KHÔNG NỘP BÀI: Tạp chí có rủi ro pháp lý học thuật rất lớn, bài báo sẽ không được công nhận.`);
  } else if (matchedSjr?.quartile === "Q1" || matchedAbdc?.abdc === "A*" || matchedAbdc?.abdc === "A") {
    lines.push(`✅ RẤT NÊN NỘP: Tạp chí quốc tế hàng đầu, đủ điều kiện bảo vệ Luận án Tiến sĩ, xét PGS/GS và nghiệm thu đề tài NCKH trọng điểm.`);
  } else if (matchedSjr || matchedAbdc) {
    lines.push(`✅ ĐỦ CHUẨN: Tạp chí quốc tế uy tín, phù hợp công bố kết quả nghiên cứu khoa học.`);
  } else if (matchedVn || matchedHdgs) {
    lines.push(`✅ ĐỦ CHUẨN QUỐC GIA: Đạt chuẩn khoa học Việt Nam 2026, tính điểm HĐGSNN và nghiệm thu đề tài NCKH trong nước.`);
  }

  lines.push(`\n💡 Nhắn mã ISSN hoặc tên tạp chí khác để tiếp tục tra cứu.`);
  return lines.join("\n").slice(0, 1950);
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
      return {
        doi,
        title,
        journal,
        issns,
        year,
        authors: authors + ((data.authorships || []).length > 3 ? " et al." : ""),
        apc,
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

  // Lưu log sự kiện gần nhất nhận được để debug
  await env.SCOPUS_BOT_KV.put(
    "LAST_PROCESSED_MESSAGE",
    JSON.stringify({
      time: new Date().toISOString(),
      chatId,
      displayName,
      text,
      rawUpdate: update,
    })
  );

  if (!chatId) {
    console.error("Không tìm thấy chatId trong update:", update);
    return false;
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
        `💡 Gõ '1' để xem hướng dẫn tra cứu | Gõ 'huy' nếu muốn tắt thông báo định kỳ.`;
    } else if (["huy", "/huy", "unsubscribe", "/stop"].includes(cmd)) {
      await removeSubscriber(env, chatId);
      replyText =
        "✅ Đã tắt thông báo định kỳ. Bạn vẫn có thể nhắn Tên tạp chí hoặc mã ISSN bất cứ lúc nào để tra cứu!";
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

  await env.SCOPUS_BOT_KV.put(
    "LAST_POLL_STATUS",
    JSON.stringify({
      time: new Date().toISOString(),
      durationMs: Date.now() - startTime,
      processedCount,
      lastDebug,
    })
  );
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

  // 6. Cloudflare Cron Trigger chạy tự động mỗi 60 giây (* * * * *), khởi động chuỗi Ping-Pong 4 nhịp (4 x 14s = 56s)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        await pollZaloUpdatesLoop(env);
        await fetch(
          "https://scopus-wos-poller.nttu-kts-johntroger.workers.dev/api/poll?step=1",
          { headers: { "User-Agent": "Mozilla/5.0 Cloudflare-Relay" } }
        ).catch(() => {});
      })()
    );
  },
};
