#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Hệ thống Tự động Theo dõi, Cảnh báo & Tra cứu 2 chiều Tạp chí bị loại khỏi Scopus + Retraction Watch
Hỗ trợ gửi thông báo và trả lời tra cứu tự động qua Zalo Bot (bot.zaloplatforms.com) và Telegram Bot.
"""

import io
import json
import os
import re
from datetime import datetime, timezone
from typing import Dict, List, Set, Tuple

import openpyxl
import pandas as pd
import requests

SCOPUS_CONTENT_PAGE = "https://www.elsevier.com/products/scopus/content"
RETRACTION_WATCH_CSV_URL = "https://gitlab.com/crossref/retraction-watch-data/-/raw/main/retraction_watch.csv"

STATE_FILE = "state.json"
WATCHLIST_FILE = "watchlist.json"
LOOKUP_INDEX_FILE = "discontinued_lookup.json"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/128.0.0.0 Safari/537.36"
    )
}


# ==============================================================================
# 1. MODULE GỬI & NHẬN TIN NHẮN QUA ZALO BOT & TELEGRAM BOT
# ==============================================================================

def split_text_chunks(text: str, max_length: int = 1850) -> List[str]:
    """Chia nhỏ tin nhắn nếu vượt quá giới hạn ký tự của Zalo (2000 ký tự) hoặc Telegram (4096 ký tự)."""
    lines = text.split("\n")
    chunks = []
    current_chunk = []
    current_len = 0

    for line in lines:
        line_len = len(line) + 1
        if current_len + line_len > max_length and current_chunk:
            chunks.append("\n".join(current_chunk))
            current_chunk = [line]
            current_len = line_len
        else:
            current_chunk.append(line)
            current_len += line_len

    if current_chunk:
        chunks.append("\n".join(current_chunk))
    return chunks


def send_zalo_message(text: str, target_chat_id: str = "") -> bool:
    """Gửi tin nhắn qua Zalo Bot Platform (https://bot.zaloplatforms.com)."""
    bot_token = os.environ.get("ZALO_BOT_TOKEN", "").strip()
    chat_id = (target_chat_id or os.environ.get("ZALO_CHAT_ID", "")).strip()

    if not bot_token or not chat_id:
        print("[Zalo] Chưa cấu hình ZALO_BOT_TOKEN hoặc ZALO_CHAT_ID. Bỏ qua gửi Zalo.")
        return False

    url = f"https://bot-api.zaloplatforms.com/bot{bot_token}/sendMessage"
    chunks = split_text_chunks(text, max_length=1850)
    success = True

    for idx, chunk in enumerate(chunks, 1):
        payload = {
            "chat_id": chat_id,
            "text": chunk,
        }
        try:
            resp = requests.post(url, json=payload, timeout=20)
            data = resp.json()
            if resp.status_code == 200 and data.get("ok", True):
                print(f"[Zalo] Đã gửi thành công phần {idx}/{len(chunks)} tới {chat_id}.")
            else:
                print(f"[Zalo] Lỗi từ Zalo API: {resp.status_code} - {data}")
                success = False
        except Exception as exc:
            print(f"[Zalo] Lỗi kết nối khi gửi tin nhắn: {exc}")
            success = False

    return success


def send_telegram_message(text: str, target_chat_id: str = "") -> bool:
    """Gửi tin nhắn qua Telegram Bot API."""
    bot_token = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
    chat_id = (target_chat_id or os.environ.get("TELEGRAM_CHAT_ID", "")).strip()

    if not bot_token or not chat_id:
        print("[Telegram] Chưa cấu hình TELEGRAM_BOT_TOKEN hoặc TELEGRAM_CHAT_ID. Bỏ qua gửi Telegram.")
        return False

    url = f"https://api.telegram.org/bot{bot_token}/sendMessage"
    chunks = split_text_chunks(text, max_length=3800)
    success = True

    for idx, chunk in enumerate(chunks, 1):
        payload = {
            "chat_id": chat_id,
            "text": chunk,
            "disable_web_page_preview": True,
        }
        try:
            resp = requests.post(url, json=payload, timeout=20)
            if resp.status_code == 200:
                print(f"[Telegram] Đã gửi thành công phần {idx}/{len(chunks)} tới {chat_id}.")
            else:
                print(f"[Telegram] Lỗi từ Telegram API: {resp.status_code} - {resp.text}")
                success = False
        except Exception as exc:
            print(f"[Telegram] Lỗi kết nối khi gửi tin nhắn: {exc}")
            success = False

    return success


def broadcast_notification(message: str) -> None:
    """Gửi thông báo tới tất cả các kênh đã được cấu hình."""
    print("\n--- NỘI DUNG THÔNG BÁO ---")
    print(message)
    print("--------------------------\n")
    send_zalo_message(message)
    send_telegram_message(message)


# ==============================================================================
# 2. ĐỌC TRẠNG THÁI & DANH SÁCH THEO DÕI (WATCHLIST)
# ==============================================================================

def load_json_file(path: str, default: dict) -> dict:
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as exc:
            print(f"Cảnh báo: Không thể đọc {path} ({exc}), sử dụng giá trị mặc định.")
    return default


def save_json_file(path: str, data: dict) -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def normalize_issn(val: str) -> str:
    """Chuẩn hóa mã ISSN về dạng 8 ký tự liền nhau (bỏ dấu gạch ngang) để so khớp chính xác."""
    if not val or pd.isna(val):
        return ""
    cleaned = re.sub(r"[^0-9Xx]", "", str(val)).upper()
    return cleaned


def clean_str(val) -> str:
    if val is None or pd.isna(val):
        return ""
    s = str(val).strip()
    return "" if s.lower() == "nan" else s


# ==============================================================================
# 3. KIỂM TRA SCOPUS & TẠO CHỈ MỤC TRA CỨU (LOOKUP INDEX)
# ==============================================================================

def get_latest_scopus_excel_url() -> Tuple[str, str]:
    """Quét trang Elsevier Scopus Content để lấy URL file ext_list_*.xlsx mới nhất."""
    resp = requests.get(SCOPUS_CONTENT_PAGE, headers=HEADERS, timeout=30)
    resp.raise_for_status()
    html = resp.text

    matches = re.findall(
        r'(?:https?:)?//downloads\.ctfassets\.net/[^"\'\s<>]+/ext_list_[^"\'\s<>]+\.xlsx',
        html,
        flags=re.IGNORECASE,
    )
    if not matches:
        raise RuntimeError("Không tìm thấy đường dẫn file ext_list_*.xlsx trên trang Elsevier Scopus.")

    raw_url = matches[0]
    full_url = "https:" + raw_url if raw_url.startswith("//") else raw_url
    filename = full_url.split("/")[-1]
    return full_url, filename


def read_scopus_sheet_auto_header(excel_bytes: io.BytesIO, sheet_name: str) -> pd.DataFrame:
    """Đọc sheet Excel của Scopus và tự động phát hiện dòng tiêu đề (tránh các dòng ghi chú ở đầu sheet)."""
    excel_bytes.seek(0)
    df_preview = pd.read_excel(excel_bytes, sheet_name=sheet_name, header=None, nrows=15, dtype=str)
    header_row_idx = 0
    for idx, row in df_preview.iterrows():
        row_vals = " | ".join([str(v).strip().lower() for v in row.values if pd.notna(v)])
        if ("source title" in row_vals) or ("sourcerecord id" in row_vals) or ("reason for discontinuation" in row_vals):
            header_row_idx = int(idx)
            break

    excel_bytes.seek(0)
    df = pd.read_excel(excel_bytes, sheet_name=sheet_name, header=header_row_idx, dtype=str)
    df.columns = [str(c).strip() for c in df.columns]
    return df


def check_scopus_updates(state: dict, watchlist: dict, lookup_db: dict) -> List[str]:
    """
    Tải và phân tích bảng tính Scopus Source List mới nhất:
    1. Kiểm tra sheet 'Discontinued Titles ...' để phát hiện tạp chí mới bị loại vì lý do chất lượng.
    2. Xuất toàn bộ danh sách Discontinued ra `discontinued_lookup.json` để phục vụ Bot tra cứu 2 chiều.
    """
    messages = []
    try:
        excel_url, filename = get_latest_scopus_excel_url()
        print(f"[Scopus] Phát hiện file trên trang chủ Elsevier: {filename} ({excel_url})")
    except Exception as exc:
        print(f"[Scopus] Lỗi khi tìm link Scopus: {exc}")
        return messages

    is_first_run = not state.get("known_discontinued_ids")
    last_file = state.get("last_scopus_file", "")
    disc_list_existing = lookup_db.get("discontinued_journals", [])
    has_valid_lookup = bool(
        disc_list_existing
        and disc_list_existing[0].get("title") != disc_list_existing[0].get("source_id")
    )

    # Nếu tên file chưa đổi, đã có dữ liệu khởi tạo và đã có file tra cứu hợp lệ thì không cần tải lại 26MB
    if filename == last_file and not is_first_run and has_valid_lookup:
        print(f"[Scopus] File {filename} đã được kiểm tra và tạo chỉ mục tra cứu trước đó.")
        return messages

    print(f"[Scopus] Đang tải file {filename} để phân tích & cập nhật cơ sở dữ liệu tra cứu...")
    resp = requests.get(excel_url, headers=HEADERS, timeout=120)
    resp.raise_for_status()
    excel_bytes = io.BytesIO(resp.content)

    wb = openpyxl.load_workbook(excel_bytes, read_only=True, data_only=True)
    sheet_names = wb.sheetnames
    print(f"[Scopus] Các sheet trong file: {sheet_names}")

    disc_sheet_name = next((s for s in sheet_names if "discontinued" in s.lower()), None)
    main_sheet_name = next((s for s in sheet_names if "scopus sources" in s.lower()), sheet_names[0])

    df_main = read_scopus_sheet_auto_header(excel_bytes, main_sheet_name)
    print(f"[Scopus] Cột của sheet '{main_sheet_name}': {list(df_main.columns[:8])}")

    source_id_col = next((c for c in df_main.columns if "sourcerecord id" in c.lower() or "source id" in c.lower()), df_main.columns[0])
    asjc_col = next((c for c in df_main.columns if "asjc" in c.lower()), None)
    main_pub_col = next((c for c in df_main.columns if "publisher" in c.lower()), None)

    asjc_prefixes = tuple(watchlist.get("asjc_prefixes", ["14", "20"]))
    watch_issns = {normalize_issn(x) for x in watchlist.get("issns", []) if normalize_issn(x)}
    watch_titles = {t.strip().lower() for t in watchlist.get("titles", []) if t.strip()}

    econ_bus_source_ids: Set[str] = set()
    publisher_by_sid: Dict[str, str] = {}
    for _, row in df_main.iterrows():
        sid = clean_str(row.get(source_id_col, ""))
        if main_pub_col and sid:
            pub_val = clean_str(row.get(main_pub_col, ""))
            if pub_val:
                publisher_by_sid[sid] = pub_val
        asjc_val = clean_str(row.get(asjc_col, "")) if asjc_col else ""
        codes = [c.strip() for c in re.split(r"[;,\s]+", asjc_val) if c.strip()]
        if any(c.startswith(asjc_prefixes) for c in codes):
            econ_bus_source_ids.add(sid)

    if disc_sheet_name:
        df_disc = read_scopus_sheet_auto_header(excel_bytes, disc_sheet_name)
        print(f"[Scopus] Cột của sheet '{disc_sheet_name}': {list(df_disc.columns)}")

        d_id_col = next((c for c in df_disc.columns if "source id" in c.lower() or "sourcerecord" in c.lower()), df_disc.columns[0])
        d_title_col = next((c for c in df_disc.columns if "source title" in c.lower() or "title" in c.lower()), df_disc.columns[1])
        d_issn_col = next((c for c in df_disc.columns if "issn" in c.lower() and "e-issn" not in c.lower() and "eissn" not in c.lower()), None)
        d_eissn_col = next((c for c in df_disc.columns if "e-issn" in c.lower() or "eissn" in c.lower()), None)
        d_reason_col = next((c for c in df_disc.columns if "reason" in c.lower()), None)
        d_pub_col = next((c for c in df_disc.columns if "publisher" in c.lower()), None)
        d_year_col = next(
            (
                c for c in df_disc.columns
                if c not in (d_id_col, d_title_col, d_issn_col, d_eissn_col, d_reason_col, d_pub_col)
                and any(k in c.lower() for k in ["year", "discontinued", "coverage", "last", "issue", "completion"])
            ),
            None,
        )

        known_ids = set(state.get("known_discontinued_ids", []))
        current_ids = set()
        discontinued_records = []

        new_watchlist_disc = []
        new_econ_disc = []
        new_other_disc = []

        for _, row in df_disc.iterrows():
            sid = clean_str(row.get(d_id_col, ""))
            if not sid or not sid.isdigit():
                continue
            current_ids.add(sid)

            title = clean_str(row.get(d_title_col, "")) or "N/A"
            issn = clean_str(row.get(d_issn_col, "")) if d_issn_col else ""
            eissn = clean_str(row.get(d_eissn_col, "")) if d_eissn_col else ""
            reason = clean_str(row.get(d_reason_col, "")) if d_reason_col else "Discontinued"
            publisher = (clean_str(row.get(d_pub_col, "")) if d_pub_col else "") or publisher_by_sid.get(sid, "N/A")
            disc_year = clean_str(row.get(d_year_col, "")) if d_year_col else ""

            discontinued_records.append({
                "source_id": sid,
                "title": title,
                "issn": issn,
                "eissn": eissn,
                "publisher": publisher,
                "reason": reason,
                "discontinued_info": disc_year,
            })

            if sid not in known_ids:
                norm_issn = normalize_issn(issn)
                norm_eissn = normalize_issn(eissn)
                issn_display = issn or eissn or "N/A"
                entry_str = f"• {title} (ISSN: {issn_display}) | NXB: {publisher} | Lý do: {reason}"

                if (norm_issn in watch_issns) or (norm_eissn in watch_issns) or (title.lower() in watch_titles):
                    new_watchlist_disc.append(entry_str)
                elif sid in econ_bus_source_ids or any(
                    kw in title.lower()
                    for kw in ["business", "econom", "marketing", "management", "finance", "accounting", "commerce", "consumer"]
                ):
                    new_econ_disc.append(entry_str)
                else:
                    new_other_disc.append(entry_str)

        # Lưu danh sách chi tiết vào lookup_db để phục vụ tra cứu
        lookup_db["scopus_version"] = disc_sheet_name
        lookup_db["updated_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
        lookup_db["discontinued_journals"] = discontinued_records

        state["known_discontinued_ids"] = sorted(list(current_ids))
        state["last_scopus_file"] = filename

        if is_first_run:
            msg = [
                f"✅ KHỞI TẠO HỆ THỐNG THEO DÕI SCOPUS THÀNH CÔNG",
                f"• Bản dữ liệu hiện tại: {filename} ({disc_sheet_name})",
                f"• Tổng số tạp chí trong danh sách Discontinued đã lưu vào bộ nhớ tra cứu: {len(current_ids)} tạp chí.",
                f"• Bạn có thể nhắn tên tạp chí hoặc mã ISSN trực tiếp cho Bot để kiểm tra xem tạp chí đó có bị Discontinued hay không!"
            ]
            messages.append("\n".join(msg))
        else:
            total_new = len(new_watchlist_disc) + len(new_econ_disc) + len(new_other_disc)
            if total_new > 0:
                msg = [
                    f"🚨 CẢNH BÁO SCOPUS CẬP NHẬT DANH SÁCH TẠP CHÍ BỊ LOẠI ({disc_sheet_name})",
                    f"Tổng số tạp chí mới bị loại đợt này: {total_new} tạp chí.\n"
                ]
                if new_watchlist_disc:
                    msg.append("⚠️ CẢNH BÁO ĐẶC BIỆT (TRONG WATCHLIST CỦA BẠN):")
                    msg.extend(new_watchlist_disc)
                    msg.append("")
                if new_econ_disc:
                    msg.append(f"📊 NGÀNH KINH TẾ - QUẢN TRỊ - MARKETING ({len(new_econ_disc)} tạp chí):")
                    msg.extend(new_econ_disc[:30])
                    if len(new_econ_disc) > 30:
                        msg.append(f"... và {len(new_econ_disc) - 30} tạp chí khác cùng khối ngành.")
                    msg.append("")
                if new_other_disc:
                    msg.append(f"📌 CÁC LĨNH VỰC KHÁC ({len(new_other_disc)} tạp chí):")
                    msg.extend(new_other_disc[:10])
                    if len(new_other_disc) > 10:
                        msg.append(f"... và {len(new_other_disc) - 10} tạp chí thuộc các ngành khác.")

                messages.append("\n".join(msg))

    return messages


# ==============================================================================
# 4. KIỂM TRA RETRACTION WATCH & CẬP NHẬT THỐNG KÊ RÚT BÀI THEO TẠP CHÍ
# ==============================================================================

def check_retraction_watch(state: dict, watchlist: dict, lookup_db: dict) -> List[str]:
    """
    Đọc dữ liệu CSV mới nhất từ GitLab Crossref / Retraction Watch:
    - Phát hiện các bài báo mới bị rút.
    - Cập nhật thống kê số bài bị rút của các tạp chí vào `lookup_db` để tra cứu.
    """
    messages = []
    print("[Retraction Watch] Đang kiểm tra dữ liệu mới nhất từ GitLab Crossref...")
    try:
        resp = requests.get(RETRACTION_WATCH_CSV_URL, headers=HEADERS, timeout=90)
        resp.raise_for_status()
    except Exception as exc:
        print(f"[Retraction Watch] Không thể tải CSV: {exc}")
        return messages

    df = pd.read_csv(io.BytesIO(resp.content), dtype=str, low_memory=False)
    if "Record ID" not in df.columns:
        print("[Retraction Watch] Không tìm thấy cột 'Record ID'.")
        return messages

    # Lưu thống kê số lượng bài bị rút theo từng tạp chí (cho các tạp chí có >= 2 bài bị rút)
    journal_counts_all = df["Journal"].dropna().str.strip().value_counts()
    retraction_stats = {
        str(j_name): int(cnt)
        for j_name, cnt in journal_counts_all.items()
        if int(cnt) >= 2 and str(j_name).lower() != "nan"
    }
    lookup_db["retraction_counts_by_journal"] = retraction_stats

    df["Record_ID_Int"] = pd.to_numeric(df["Record ID"], errors="coerce").fillna(0).astype(int)
    max_record_id = int(df["Record_ID_Int"].max())
    last_record_id = int(state.get("last_retraction_record_id", 0))

    if last_record_id == 0:
        state["last_retraction_record_id"] = max_record_id
        print(f"[Retraction Watch] Khởi tạo mốc Record ID = {max_record_id}.")
        messages.append(
            f"✅ KHỞI TẠO RETRACTION WATCH (GITLAB CROSSREF)\n"
            f"• Đã đồng bộ mốc Record ID mới nhất: #{max_record_id} ({len(df):,} bản ghi).\n"
            f"• Các thông báo rút bài mới thuộc ngành Kinh tế - Quản trị - Marketing hoặc nằm trong Watchlist sẽ được báo tự động mỗi ngày."
        )
        return messages

    new_rows = df[df["Record_ID_Int"] > last_record_id].copy()
    if new_rows.empty:
        print("[Retraction Watch] Không có bản ghi rút bài mới kể từ lần quét trước.")
        return messages

    state["last_retraction_record_id"] = max_record_id

    watch_titles = {t.strip().lower() for t in watchlist.get("titles", []) if t.strip()}
    bus_keywords = ["(bus)", "business", "econom", "marketing", "management", "finance", "accounting", "consumer", "retailing"]

    watchlist_hits = []
    econ_hits = []

    for _, row in new_rows.iterrows():
        journal = clean_str(row.get("Journal", "")) or "N/A"
        title = clean_str(row.get("Title", "")) or "N/A"
        subject = clean_str(row.get("Subject", ""))
        reason = clean_str(row.get("Reason", "")) or "N/A"
        nature = clean_str(row.get("RetractionNature", "")) or "Retraction"
        r_date = clean_str(row.get("RetractionDate", ""))

        item_text = (
            f"• [{nature}] Tạp chí: {journal}\n"
            f"  Bài báo: \"{title[:120]}{'...' if len(title) > 120 else ''}\"\n"
            f"  Ngày: {r_date} | Lý do: {reason[:120]}"
        )

        if journal.lower() in watch_titles:
            watchlist_hits.append(item_text)
        elif any(kw in subject.lower() or kw in journal.lower() for kw in bus_keywords):
            econ_hits.append(item_text)

    journal_counts = new_rows["Journal"].value_counts()
    spike_journals = [
        f"• {j_name}: {count} bài bị rút cùng lúc"
        for j_name, count in journal_counts.items()
        if count >= 5 and str(j_name).strip().lower() != "nan"
    ]

    if watchlist_hits or econ_hits or spike_journals:
        msg = [
            f"📢 CẬP NHẬT RETRACTION WATCH MỚI ({len(new_rows)} bản ghi mới trên toàn cầu)\n"
        ]
        if watchlist_hits:
            msg.append(f"⚠️ PHÁT HIỆN TRONG WATCHLIST CỦA BẠN ({len(watchlist_hits)} bài):")
            msg.extend(watchlist_hits[:10])
            msg.append("")
        if econ_hits:
            msg.append(f"📊 NGÀNH KINH TẾ - QUẢN TRỊ - MARKETING ({len(econ_hits)} bài):")
            msg.extend(econ_hits[:15])
            if len(econ_hits) > 15:
                msg.append(f"... và {len(econ_hits) - 15} bài khác cùng khối ngành.")
            msg.append("")
        if spike_journals:
            msg.append("🔥 CẢNH BÁO SỚM NGUY CƠ BỊ WOS 'ON HOLD' / SCOPUS LOẠI (Tạp chí có >= 5 bài bị rút đột biến):")
            msg.extend(spike_journals[:10])

        messages.append("\n".join(msg))

    return messages


# ==============================================================================
# 5. MODULE TRA CỨU TẠP CHÍ 2 CHIỀU (NHẮN TÊN TẠP CHÍ / ISSN VÀO ZALO BOT)
# ==============================================================================

def search_journal_in_lookup(query: str, lookup_db: dict) -> str:
    """
    Tìm kiếm tạp chí theo Tên hoặc mã ISSN trong cơ sở dữ liệu Discontinued của Scopus
    và thống kê Retraction Watch.
    """
    q = query.strip()
    if len(q) < 3:
        return (
            "ℹ️ HƯỚNG DẪN TRA CỨU TẠP CHÍ:\n"
            "Hãy nhắn tên tạp chí (ví dụ: 'Journal of Business Research') hoặc mã ISSN (ví dụ: '0148-2963') "
            "để kiểm tra xem tạp chí có nằm trong danh sách bị loại (Discontinued) của Scopus và lịch sử rút bài trên Retraction Watch hay không."
        )

    norm_q_issn = normalize_issn(q)
    q_lower = q.lower()

    disc_list = lookup_db.get("discontinued_journals", [])
    retraction_map: Dict[str, int] = lookup_db.get("retraction_counts_by_journal", {})
    scopus_ver = lookup_db.get("scopus_version", "Scopus Discontinued List")

    matched_disc = []
    for item in disc_list:
        title = item.get("title", "")
        issn = normalize_issn(item.get("issn", ""))
        eissn = normalize_issn(item.get("eissn", ""))

        if norm_q_issn and len(norm_q_issn) == 8 and (norm_q_issn == issn or norm_q_issn == eissn):
            matched_disc.append(item)
        elif q_lower in title.lower():
            matched_disc.append(item)

    # Tìm thống kê bài bị rút trên Retraction Watch
    matched_retractions = []
    for j_name, count in retraction_map.items():
        if q_lower in j_name.lower():
            matched_retractions.append((j_name, count))
    matched_retractions.sort(key=lambda x: x[1], reverse=True)

    lines = [f"🔍 KẾT QUẢ KIỂM TRA TẠP CHÍ: \"{q}\""]
    lines.append(f"(Dữ liệu đối chiếu: {scopus_ver})\n")

    if matched_disc:
        lines.append(f"🚨 CẢNH BÁO: Tìm thấy {len(matched_disc)} kết quả trong danh sách BỊ LOẠI (DISCONTINUED) khỏi Scopus:")
        for item in matched_disc[:10]:
            issn_str = item.get("issn") or item.get("eissn") or "N/A"
            eissn_str = f" / e-ISSN: {item.get('eissn')}" if item.get("eissn") and item.get("issn") else ""
            lines.append(
                f"• Tên tạp chí: {item.get('title')}\n"
                f"  - ISSN: {issn_str}{eissn_str}\n"
                f"  - NXB: {item.get('publisher')}\n"
                f"  - Lý do bị loại: {item.get('reason')}\n"
                f"  - Thông tin ngừng lập chỉ mục: {item.get('discontinued_info') or 'Đã ngừng coverage'}"
            )
        if len(matched_disc) > 10:
            lines.append(f"... và {len(matched_disc) - 10} kết quả trùng khớp khác.")
    else:
        lines.append(
            "✅ TRẠNG THÁI SCOPUS DISCONTINUED:\n"
            "Không tìm thấy tạp chí này trong danh sách bị loại (Discontinued Titles) của Scopus!"
        )

    lines.append("")
    if matched_retractions:
        lines.append("📊 LỊCH SỬ BÀI BÁO BỊ RÚT TRÊN RETRACTION WATCH:")
        for j_name, cnt in matched_retractions[:5]:
            risk_tag = "⚠️ (Số lượng cao - Cần thận trọng)" if cnt >= 20 else ""
            lines.append(f"• {j_name}: {cnt} bài từng bị rút/đính chính {risk_tag}")
    else:
        lines.append("📊 RETRACTION WATCH: Tạp chí này không có (hoặc có < 2) bài bị rút trong cơ sở dữ liệu Retraction Watch.")

    return "\n".join(lines)


def process_incoming_zalo_queries(state: dict, lookup_db: dict) -> None:
    """Đọc các tin nhắn người dùng gửi tới Zalo Bot qua getUpdates và tự động trả lời kết quả tra cứu."""
    bot_token = os.environ.get("ZALO_BOT_TOKEN", "").strip()
    if not bot_token:
        return

    url = f"https://bot-api.zaloplatforms.com/bot{bot_token}/getUpdates"
    try:
        resp = requests.post(url, json={"timeout": 5}, timeout=15)
        if resp.status_code != 200:
            return
        data = resp.json()
    except Exception as exc:
        print(f"[Zalo Query] Không thể gọi getUpdates: {exc}")
        return

    results = data.get("result") or []
    if isinstance(results, dict):
        results = [results]

    processed_ids: List[str] = state.get("processed_zalo_msg_ids", [])

    for item in results:
        msg = item.get("message") or item
        msg_id = str(msg.get("message_id") or item.get("event_id") or "")
        if msg_id and msg_id in processed_ids:
            continue

        chat_info = msg.get("chat") or msg.get("from") or {}
        chat_id = str(chat_info.get("id") or "")
        text = str(msg.get("text") or "").strip()

        if chat_id and text:
            print(f"[Zalo Query] Nhận yêu cầu tra cứu từ {chat_id}: '{text}'")
            reply = search_journal_in_lookup(text, lookup_db)
            send_zalo_message(reply, target_chat_id=chat_id)
            if msg_id:
                processed_ids.append(msg_id)

    state["processed_zalo_msg_ids"] = processed_ids[-200:]


# ==============================================================================
# 6. HÀM CHÍNH (MAIN)
# ==============================================================================

def main():
    print(f"=== BẮT ĐẦU QUÉT DỮ LIỆU ({datetime.now(timezone.utc).isoformat()}) ===")
    state = load_json_file(
        STATE_FILE,
        {
            "last_scopus_file": "",
            "known_discontinued_ids": [],
            "last_retraction_record_id": 0,
            "processed_zalo_msg_ids": [],
            "last_updated": "",
        },
    )
    watchlist = load_json_file(WATCHLIST_FILE, {})
    lookup_db = load_json_file(LOOKUP_INDEX_FILE, {})

    all_notifications: List[str] = []

    # 1. Kiểm tra danh sách tạp chí bị loại khỏi Scopus (Elsevier) & Cập nhật cơ sở dữ liệu tra cứu
    scopus_msgs = check_scopus_updates(state, watchlist, lookup_db)
    all_notifications.extend(scopus_msgs)

    # 2. Kiểm tra dữ liệu rút bài hàng ngày từ Retraction Watch (GitLab Crossref)
    rw_msgs = check_retraction_watch(state, watchlist, lookup_db)
    all_notifications.extend(rw_msgs)

    # 3. Nếu người dùng truyền từ khóa tra cứu trực tiếp từ giao diện GitHub Actions (workflow_dispatch input)
    manual_query = os.environ.get("LOOKUP_QUERY", "").strip()
    if manual_query:
        query_result = search_journal_in_lookup(manual_query, lookup_db)
        all_notifications.append(query_result)

    # 4. Kiểm tra và trả lời các tin nhắn tra cứu gửi vào Zalo Bot
    process_incoming_zalo_queries(state, lookup_db)

    # Lưu trạng thái mới & chỉ mục tra cứu
    state["last_updated"] = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    save_json_file(STATE_FILE, state)
    save_json_file(LOOKUP_INDEX_FILE, lookup_db)

    # Gửi thông báo nếu có cập nhật mới
    if all_notifications:
        final_message = "\n\n" + ("=" * 28) + "\n\n"
        broadcast_notification(final_message.join(all_notifications))
    else:
        print("Không có biến động mới cần gửi thông báo trong lần quét này.")

    print("=== HOÀN TẤT ===")


if __name__ == "__main__":
    main()
