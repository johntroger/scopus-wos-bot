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
HIJACKED_JOURNALS_CSV_URL = "https://docs.google.com/spreadsheets/d/1ak985WGOgGbJRJbZFanoktAN_UFeExpE/export?format=csv&gid=5255084"
ABDC_RANKINGS_JSON_URL = "https://raw.githubusercontent.com/ben-AI-cybersec/zotero-publication-rankings/main/update-scripts/abdc_rankings.json"
SJR_RANKINGS_JSON_URL = "https://raw.githubusercontent.com/ben-AI-cybersec/zotero-publication-rankings/main/update-scripts/sjr_rankings.json"

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


CLOUDFLARE_WORKER_URL = os.environ.get(
    "CLOUDFLARE_WORKER_URL",
    "https://scopus-wos-zalo-bot.nttu-kts-johntroger.workers.dev",
).strip()


def send_cloudflare_broadcast(text: str) -> bool:
    """Gửi thông báo đồng loạt tới tất cả người dùng đã đăng ký trên Cloudflare Worker (Zalo Multi-user Broadcast)."""
    if not CLOUDFLARE_WORKER_URL:
        return False

    url = f"{CLOUDFLARE_WORKER_URL.rstrip('/')}/api/broadcast"
    chunks = split_text_chunks(text, max_length=1850)
    success = True

    for idx, chunk in enumerate(chunks, 1):
        try:
            resp = requests.post(url, json={"message": chunk}, timeout=30)
            if resp.status_code == 200:
                data = resp.json()
                print(
                    f"[Cloudflare Broadcast] Đã gửi phần {idx}/{len(chunks)} tới "
                    f"{data.get('sent_count', 0)}/{data.get('subscribers_total', 0)} thành viên Zalo."
                )
            else:
                print(f"[Cloudflare Broadcast] Lỗi HTTP {resp.status_code}: {resp.text}")
                success = False
        except Exception as exc:
            print(f"[Cloudflare Broadcast] Lỗi kết nối tới Cloudflare Worker: {exc}")
            success = False

    return success


def broadcast_notification(message: str) -> None:
    """Gửi thông báo tới tất cả các kênh đã được cấu hình (Cloudflare Multi-user Zalo, Direct Zalo, Telegram)."""
    print("\n--- NỘI DUNG THÔNG BÁO ---")
    print(message)
    print("--------------------------\n")
    send_cloudflare_broadcast(message)
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
# 5. ĐỒNG BỘ HIJACKED JOURNALS, PHÂN HẠNG ABDC & SCIMAGO SJR (Q1-Q4)
# ==============================================================================

def sync_hijacked_journals(lookup_db: dict) -> int:
    """Đồng bộ danh sách tạp chí bị mạo danh / cướp tên miền từ Retraction Watch Hijacked Journal Checker."""
    print("[Hijacked Journals] Đang tải danh sách tạp chí bị mạo danh mới nhất...")
    try:
        resp = requests.get(HIJACKED_JOURNALS_CSV_URL, headers=HEADERS, timeout=45)
        resp.raise_for_status()
        df = pd.read_csv(io.BytesIO(resp.content), dtype=str, skiprows=1, low_memory=False)
        df.columns = [str(c).strip() for c in df.columns]

        t_col = next((c for c in df.columns if "title" in c.lower()), df.columns[1])
        h_url_col = next((c for c in df.columns if "url (hijacked)" in c.lower() or "hijacked url" in c.lower()), None)
        a_url_col = next((c for c in df.columns if "authentic" in c.lower() or "legitimate" in c.lower() or "url (authentic)" in c.lower()), None)
        issn_col = next((c for c in df.columns if "issn" in c.lower()), None)

        hijacked_list = []
        for _, row in df.iterrows():
            title = clean_str(row.get(t_col, ""))
            if not title or title.lower() in ["nan", "title"]:
                continue
            h_url = clean_str(row.get(h_url_col, "")) if h_url_col else ""
            a_url = clean_str(row.get(a_url_col, "")) if a_url_col else ""
            issn_val = clean_str(row.get(issn_col, "")) if issn_col else ""

            hijacked_list.append({
                "title": title,
                "issn": issn_val,
                "hijacked_url": h_url,
                "authentic_url": a_url,
            })

        lookup_db["hijacked_journals"] = hijacked_list
        print(f"[Hijacked Journals] Đã nạp thành công {len(hijacked_list)} tạp chí bị mạo danh.")
        return len(hijacked_list)
    except Exception as exc:
        print(f"[Hijacked Journals] Lỗi khi nạp dữ liệu: {exc}")
        return len(lookup_db.get("hijacked_journals", []))


def sync_academic_rankings(lookup_db: dict) -> None:
    """Đồng bộ phân hạng ABDC (A*, A, B, C) và SCImago Journal Rank SJR (Q1, Q2, Q3, Q4)."""
    # 1. Đồng bộ ABDC
    try:
        if not lookup_db.get("abdc_rankings"):
            print("[ABDC Ranking] Đang nạp danh mục ABDC Journal Quality List...")
            resp = requests.get(ABDC_RANKINGS_JSON_URL, headers=HEADERS, timeout=30)
            if resp.status_code == 200:
                lookup_db["abdc_rankings"] = resp.json()
                print(f"[ABDC Ranking] Đã nạp {len(lookup_db['abdc_rankings'])} tạp chí phân hạng ABDC.")
    except Exception as exc:
        print(f"[ABDC Ranking] Lỗi: {exc}")

    # 2. Đồng bộ SJR (Q1-Q4)
    try:
        if not lookup_db.get("sjr_rankings"):
            print("[SCImago SJR] Đang nạp danh mục xếp hạng SJR Q1-Q4...")
            resp = requests.get(SJR_RANKINGS_JSON_URL, headers=HEADERS, timeout=45)
            if resp.status_code == 200:
                lookup_db["sjr_rankings"] = resp.json()
                print(f"[SCImago SJR] Đã nạp {len(lookup_db['sjr_rankings'])} tạp chí phân hạng SJR.")
    except Exception as exc:
        print(f"[SCImago SJR] Lỗi: {exc}")


# ==============================================================================
# 6. MODULE TRA CỨU TẠP CHÍ 2 CHIỀU (NHẮN TÊN TẠP CHÍ / ISSN VÀO ZALO BOT)
# ==============================================================================

KNOWN_ACRONYMS = {
    "jabeg": "journal of asian business and economic studies",
    "jabes": "journal of asian business and economic studies",
    "jbr": "journal of business research",
    "jcr": "journal of consumer research",
    "jbe": "journal of business ethics",
    "jams": "journal of the academy of marketing science",
    "jm": "journal of marketing",
    "jfe": "journal of financial economics",
    "aer": "american economic review",
    "amj": "academy of management journal",
    "amr": "academy of management review",
    "jom": "journal of management",
    "misq": "mis quarterly",
    "ijhm": "international journal of hospitality management",
    "ijchm": "international journal of contemporary hospitality management",
    "jhtm": "journal of hospitality and tourism management",
    "trr": "tourism recreation research",
    "jed": "journal of economics and development",
    "ejor": "european journal of operational research",
    "ijpe": "international journal of production economics",
    "ijpr": "international journal of production research",
    "jf": "journal of finance",
    "rfs": "review of financial studies",
    "res": "review of economic studies",
    "qje": "quarterly journal of economics",
    "jpe": "journal of political economy",
    "jebo": "journal of economic behavior & organization",
    "smj": "strategic management journal",
    "jwb": "journal of world business",
    "jibs": "journal of international business studies",
    "apjm": "asia pacific journal of management",
    "ijim": "international journal of information management",
    "eswa": "expert systems with applications",
    "ktpt": "journal of economics and development",
}

def to_title_case(s: str) -> str:
    if not s:
        return ""
    return " ".join(w.capitalize() for w in s.split())

def format_issn(issn: str) -> str:
    if not issn:
        return "N/A"
    clean = normalize_issn(issn)
    if len(clean) == 8:
        return f"{clean[:4]}-{clean[4:]}"
    return issn

import unicodedata

def normalize_vn_text(s: str) -> str:
    if not s:
        return ""
    norm = unicodedata.normalize("NFD", s)
    norm = "".join(ch for ch in norm if unicodedata.category(ch) != "Mn")
    norm = norm.replace("đ", "d").replace("Đ", "D").lower()
    norm = re.sub(r"[^a-z0-9\s]", " ", norm)
    return " ".join(norm.split())

def clean_vn_journal_name(s: str) -> str:
    norm = normalize_vn_text(s)
    return re.sub(r"^(tap chi|tap chi dien tu|the journal of|journal of)\s+", "", norm)

def search_journal_in_lookup(query: str, lookup_db: dict) -> str:
    """
    Tìm kiếm tạp chí đa chiều & xuất Báo cáo Thẩm định Học thuật Toàn diện:
    1. Trạng thái Scopus Discontinued (bị loại) / Active.
    2. Cảnh báo Tạp chí Giả mạo / Cướp tên miền (Hijacked Journals).
    3. Phân hạng Quốc tế: SCImago Scopus Quartile (Q1 - Q4) & ABDC (A*, A, B, C).
    4. Tiêu chuẩn Khoa học Việt Nam năm 2026 (341 tạp chí chuẩn Quốc gia).
    5. Khung điểm công trình Hội đồng Giáo sư Nhà nước ngành Kinh tế (QĐ 26/QĐ-HĐGSNN).
    6. Thống kê bài báo bị rút / đính chính trên Retraction Watch.
    7. Khuyến nghị nộp bài cho NCS Tiến sĩ & Nhà khoa học.
    """
    q = query.strip()
    if len(q) < 2:
        return (
            "📖 CẨM NANG TRA CỨU TẠP CHÍ KHOA HỌC (SCOPUS, WOS, ABDC & CHUẨN VIỆT NAM)\n\n"
            "Hãy nhắn tên tạp chí (ví dụ: 'JABES', 'Kinh tế và Quản lý', 'Journal of Business Research') "
            "hoặc mã ISSN (ví dụ: '0148-2963') để kiểm tra toàn diện: Scopus Discontinued, Cảnh báo Web lừa đảo, "
            "Chuẩn Quốc gia 2026, Điểm HĐGSNN Kinh tế, Phân hạng Q1-Q4 / ABDC và lịch sử rút bài."
        )

    norm_q_issn = normalize_issn(q)
    q_lower = q.lower()
    resolved_query = KNOWN_ACRONYMS.get(q_lower, q_lower)
    norm_q_vn = normalize_vn_text(resolved_query)
    clean_q_vn = clean_vn_journal_name(resolved_query)

    disc_list = lookup_db.get("discontinued_journals", [])
    hijacked_list = lookup_db.get("hijacked_journals", [])
    abdc_map = lookup_db.get("abdc_rankings", {})
    sjr_map = lookup_db.get("sjr_rankings", {})
    retraction_map = lookup_db.get("retraction_counts_by_journal", {})
    vn_list = lookup_db.get("vn_standards_2026", [])
    hdgs_data = lookup_db.get("hdgsnn_kinhte", {})
    hdgs_journals = hdgs_data.get("journals", {})
    scopus_ver = lookup_db.get("scopus_version", "Scopus Discontinued List")
    wos_delisted_list = lookup_db.get("wos_delisted_journals", [])
    beall_journals_list = lookup_db.get("beall_standalone_journals", [])
    beall_publishers_list = lookup_db.get("beall_publishers", [])

    # So khớp WoS Delisted
    matched_wos_delisted = None
    for item in wos_delisted_list:
        issn = normalize_issn(item.get("issn", ""))
        eissn = normalize_issn(item.get("e_issn", ""))
        title = item.get("name", "").lower()
        if (norm_q_issn and len(norm_q_issn) == 8 and (norm_q_issn == issn or norm_q_issn == eissn)) or (title and (title == resolved_query or (len(resolved_query) >= 8 and (resolved_query in title or title in resolved_query)))):
            matched_wos_delisted = item
            break

    # So khớp Beall Standalone Journal
    matched_beall_journal = None
    for item in beall_journals_list:
        name = item.get("name", "").lower()
        abbr = item.get("abbr", "").lower()
        if (abbr and abbr == resolved_query) or (name and (name == resolved_query or (len(resolved_query) >= 8 and (resolved_query in name or name in resolved_query)))):
            matched_beall_journal = item
            break

    # So khớp Beall Predatory Publisher
    matched_beall_publisher = None
    for item in beall_publishers_list:
        name = item.get("name", "").lower()
        abbr = item.get("abbr", "").lower()
        if (abbr and abbr == resolved_query) or (name and (name == resolved_query or (len(resolved_query) >= 8 and resolved_query in name))):
            matched_beall_publisher = item
            break

    # 1. So khớp Tạp chí giả mạo (Hijacked)
    matched_hijacked = None
    for h in hijacked_list:
        h_issn = normalize_issn(h.get("issn", ""))
        if (norm_q_issn and len(norm_q_issn) == 8 and norm_q_issn == h_issn) or (resolved_query in h.get("title", "").lower()):
            matched_hijacked = h
            break

    # 2. So khớp Scopus Discontinued
    matched_disc = None
    for item in disc_list:
        issn = normalize_issn(item.get("issn", ""))
        eissn = normalize_issn(item.get("eissn", ""))
        title = item.get("title", "").lower()
        if (norm_q_issn and len(norm_q_issn) == 8 and (norm_q_issn == issn or norm_q_issn == eissn)) or (resolved_query in title):
            matched_disc = item
            break

    # 3. Tra cứu SJR Scopus Active
    matched_sjr = None
    sjr_title = ""
    if resolved_query in sjr_map:
        matched_sjr = sjr_map[resolved_query]
        sjr_title = resolved_query
    else:
        for t, info in sjr_map.items():
            issns = [normalize_issn(x) for x in str(info.get("issn", "")).split(",") if normalize_issn(x)]
            if norm_q_issn and len(norm_q_issn) == 8 and norm_q_issn in issns:
                matched_sjr = info
                sjr_title = t
                break
        if not matched_sjr:
            for t, info in sjr_map.items():
                if resolved_query in t:
                    matched_sjr = info
                    sjr_title = t
                    break

    # 4. Tra cứu ABDC
    matched_abdc = None
    abdc_title = ""
    if resolved_query in abdc_map:
        matched_abdc = abdc_map[resolved_query]
        abdc_title = resolved_query
    elif sjr_title and sjr_title in abdc_map:
        matched_abdc = abdc_map[sjr_title]
        abdc_title = sjr_title
    else:
        for t, info in abdc_map.items():
            issns = [normalize_issn(x) for x in str(info.get("issn", "")).split(",") if normalize_issn(x)]
            if norm_q_issn and len(norm_q_issn) == 8 and norm_q_issn in issns:
                matched_abdc = info
                abdc_title = t
                break
            elif resolved_query in t:
                matched_abdc = info
                abdc_title = t
                break

    # 5. Tra cứu Danh mục Tiêu chuẩn Khoa học Việt Nam năm 2026 (341 tạp chí)
    matched_vn = None
    for item in vn_list:
        t_norm = normalize_vn_text(item.get("title", ""))
        t_clean = clean_vn_journal_name(item.get("title", ""))
        if t_norm == norm_q_vn or t_clean == clean_q_vn:
            matched_vn = item
            break
        aliases = item.get("aliases", [])
        if any(normalize_vn_text(a) == norm_q_vn or clean_vn_journal_name(a) == clean_q_vn for a in aliases):
            matched_vn = item
            break

    if not matched_vn and len(clean_q_vn) >= 4:
        for item in vn_list:
            t_clean = clean_vn_journal_name(item.get("title", ""))
            if t_clean in clean_q_vn or (len(clean_q_vn) >= 8 and clean_q_vn in t_clean):
                matched_vn = item
                break
            aliases = item.get("aliases", [])
            if any(clean_vn_journal_name(a) in clean_q_vn or (len(clean_q_vn) >= 8 and clean_q_vn in clean_vn_journal_name(a)) for a in aliases):
                matched_vn = item
                break

    # 6. Tra cứu Khung điểm HĐGSNN ngành Kinh tế (QĐ 26/QĐ-HĐGSNN)
    matched_hdgs = None
    for title, info in hdgs_journals.items():
        t_norm = normalize_vn_text(title)
        t_clean = clean_vn_journal_name(title)
        info_issns = [normalize_issn(x) for x in str(info.get("issn", "")).split(",") if normalize_issn(x)]
        if norm_q_issn and len(norm_q_issn) == 8 and norm_q_issn in info_issns:
            matched_hdgs = {"title": title, **info}
            break
        if t_norm == norm_q_vn or t_clean == clean_q_vn:
            matched_hdgs = {"title": title, **info}
            break

    if not matched_hdgs and len(clean_q_vn) >= 4:
        for title, info in hdgs_journals.items():
            t_clean = clean_vn_journal_name(title)
            if t_clean in clean_q_vn or (len(clean_q_vn) >= 8 and clean_q_vn in t_clean):
                matched_hdgs = {"title": title, **info}
                break

    if not matched_hdgs and matched_vn:
        vn_norm = normalize_vn_text(matched_vn.get("title", ""))
        vn_clean = clean_vn_journal_name(matched_vn.get("title", ""))
        for title, info in hdgs_journals.items():
            t_norm = normalize_vn_text(title)
            t_clean = clean_vn_journal_name(title)
            if t_norm == vn_norm or t_clean == vn_clean or t_clean in vn_clean or vn_clean in t_clean:
                matched_hdgs = {"title": title, **info}
                break

    # 7. Tra cứu Retraction Watch
    target_name = (
        (matched_vn.get("title") if matched_vn else None)
        or (matched_hdgs.get("title") if matched_hdgs else None)
        or (matched_disc.get("title") if matched_disc else None)
        or sjr_title
        or abdc_title
        or (matched_hijacked.get("title") if matched_hijacked else None)
        or resolved_query
    )
    retraction_count = 0
    for j_name, cnt in retraction_map.items():
        if j_name.lower() in target_name.lower() or target_name.lower() in j_name.lower():
            retraction_count = max(retraction_count, cnt)

    # Nếu không tìm thấy tạp chí nào trong mọi nguồn
    if not matched_disc and not matched_hijacked and not matched_sjr and not matched_abdc and not matched_vn and not matched_hdgs and not matched_wos_delisted and not matched_beall_journal and not matched_beall_publisher:
        return (
            f"🔍 KẾT QUẢ TRA CỨU: \"{q}\"\n\n"
            f"❓ KHÔNG TÌM THẤY TRONG CSDL KHOA HỌC (SCOPUS / ABDC / CHUẨN VN 2026 / HĐGSNN)\n"
            f"Hệ thống không tìm thấy tạp chí nào khớp với từ khóa bạn vừa nhập.\n\n"
            f"💡 GỢI Ý CHO BẠN:\n"
            f"1. Nhắn mã ISSN chính xác của tạp chí (ví dụ: 0148-2963 hoặc 2515-964X).\n"
            f"2. Nhập tên tạp chí tiếng Việt (ví dụ: 'Kinh tế và Quản lý', 'Tạp chí Cộng sản', 'Kinh tế và Phát triển').\n"
            f"3. Nhập từ viết tắt chuẩn (ví dụ: JABES, JED, JBR, JCR, JBE...)."
        )

    # Xuất Báo cáo Thẩm định Toàn diện
    final_title = to_title_case(
        (matched_vn.get("title") if matched_vn else None)
        or (matched_hdgs.get("title") if matched_hdgs else None)
        or (matched_disc.get("title") if matched_disc else None)
        or sjr_title
        or abdc_title
        or (matched_hijacked.get("title") if matched_hijacked else None)
        or q
    )

    raw_issn = (
        (matched_hdgs.get("issn") if matched_hdgs else None)
        or (matched_disc.get("issn") if matched_disc else None)
        or (matched_disc.get("eissn") if matched_disc else None)
        or (matched_sjr.get("issn") if matched_sjr else None)
        or (matched_abdc.get("issn") if matched_abdc else None)
        or ""
    )
    final_issn = format_issn(raw_issn)
    org_publisher = (
        (matched_vn.get("org") if matched_vn else None)
        or (matched_hdgs.get("org") if matched_hdgs else None)
        or (matched_disc.get("publisher") if matched_disc else None)
        or ""
    )

    lines = [
        "🔬 BÁO CÁO THẨM ĐỊNH TẠP CHÍ KHOA HỌC",
        f"📖 Tạp chí: \"{final_title}\""
    ]
    if q_lower in KNOWN_ACRONYMS:
        lines.append(f"(Được giải mã từ tên viết tắt: {q.upper()})")

    # PHẦN 1: ĐỊNH DANH
    lines.append("\n📋 1. ĐỊNH DANH & CƠ QUAN CHỦ QUẢN:")
    lines.append(f"• Tên chính thức: {final_title}")
    lines.append(f"• Mã ISSN / eISSN: {final_issn}")
    if org_publisher:
        lines.append(f"• Cơ quan chủ quản / NXB: {org_publisher}")

    # PHẦN 2: CẢNH BÁO NGUY HIỂM
    if matched_hijacked:
        lines.append("\n⛔ CẢNH BÁO: TẠP CHÍ BỊ GIẢ MẠO / CƯỚP TÊN MIỀN (HIJACKED)!")
        if matched_hijacked.get("hijacked_url"):
            lines.append(f"  ❌ Website giả mạo: {matched_hijacked.get('hijacked_url')}")
        if matched_hijacked.get("authentic_url"):
            lines.append(f"  ✅ Website chính thức: {matched_hijacked.get('authentic_url')}")

    if matched_disc:
        lines.append("\n🚨 CẢNH BÁO NGUY HIỂM: ĐÃ BỊ LOẠI KHỎI SCOPUS (DISCONTINUED)!")
        lines.append(f"• Danh mục đối chiếu: {scopus_ver}")
        lines.append(f"• Thời điểm ngừng chỉ mục: {matched_disc.get('discontinued_info', 'Đã ngừng')}")
        lines.append(f"• Lý do loại bỏ: {matched_disc.get('reason', 'Publication Concerns (Nghi vấn biên tập)')}")
        lines.append("• Đánh giá rủi ro: CỰC KỲ NGUY HIỂM. Bài đăng sau ngày bị loại sẽ bị 0 điểm HĐGSNN và không được tính chuẩn đầu ra Tiến sĩ.")

    # PHẦN 3: TIÊU CHUẨN VIỆT NAM & ĐIỂM HĐGSNN
    if matched_vn or matched_hdgs or matched_sjr:
        lines.append("\n🇻🇳 2. TIÊU CHUẨN VIỆT NAM & ĐIỂM HĐGSNN:")
        if matched_vn:
            lines.append(f"• Chuẩn khoa học VN 2026: ✅ ĐẠT TIÊU CHUẨN QUỐC GIA (STT: {matched_vn.get('stt')} / 341)")
            lines.append(f"• Phân nhóm: {matched_vn.get('cat')}")
        elif matched_sjr or matched_abdc:
            lines.append("• Chuẩn khoa học VN 2026: Tạp chí quốc tế (công nhận tính điểm theo quy chế đào tạo & HĐGSNN)")

        hdgs_point_str = ""
        if matched_hdgs and matched_hdgs.get("points"):
            hdgs_point_str = f"🎯 {matched_hdgs.get('points')} (HĐGS ngành Kinh tế - QĐ 26/QĐ-HĐGSNN)"
        elif matched_sjr and matched_sjr.get("quartile") == "Q1":
            hdgs_point_str = "🎯 0 - 2,0 điểm (Scopus Q1 / Quyết định 26/QĐ-HĐGSNN)"
        elif matched_sjr and matched_sjr.get("quartile"):
            hdgs_point_str = f"🎯 0 - 1,5 điểm (Scopus {matched_sjr.get('quartile')} / Quyết định 26/QĐ-HĐGSNN)"

        if hdgs_point_str:
            lines.append(f"• Điểm công trình HĐGSNN: {hdgs_point_str}")

    # PHẦN 4: PHÂN HẠNG QUỐC TẾ
    if not matched_disc and (matched_sjr or matched_abdc):
        lines.append("\n🏆 3. XẾP HẠNG QUỐC TẾ (SCOPUS / ABDC):")
        if matched_sjr:
            q_tier = matched_sjr.get("quartile", "N/A")
            sjr_val = matched_sjr.get("sjr", "N/A")
            tier_desc = ""
            if q_tier == "Q1":
                tier_desc = "Top 25% tạp chí hàng đầu thế giới"
            elif q_tier == "Q2":
                tier_desc = "Nhóm 25% - 50% thế giới"
            elif q_tier == "Q3":
                tier_desc = "Nhóm 50% - 75% danh mục"
            elif q_tier == "Q4":
                tier_desc = "Nhóm 75% - 100% danh mục"
            lines.append(f"• SCImago Scopus: 🌟 {q_tier} (SJR: {sjr_val} - {tier_desc})")

        if matched_abdc:
            rank = matched_abdc.get("abdc", "Listed")
            abdc_desc = ""
            if rank == "A*":
                abdc_desc = "Tạp chí tinh hoa quốc tế (Top 7% Kinh tế/Quản trị)"
            elif rank == "A":
                abdc_desc = "Tạp chí xuất sắc, uy tín quốc tế rất cao"
            elif rank == "B":
                abdc_desc = "Tạp chí chất lượng tốt, quốc tế công nhận"
            elif rank == "C":
                abdc_desc = "Tạp chí đạt chuẩn bình duyệt quốc tế"
            lines.append(f"• Phân hạng ABDC (Úc): 🎖️ Hạng {rank} ({abdc_desc})")
    elif not matched_disc and matched_vn and not matched_sjr and not matched_abdc:
        lines.append("\n🌐 3. CHỈ MỤC QUỐC TẾ:")
        lines.append("• Tình trạng: Tạp chí khoa học uy tín trong nước (Chưa nằm trong CSDL Scopus/WoS quốc tế).")

    # PHẦN 5: LIÊM CHÍNH & RỦI RO
    lines.append("\n🛡️ 4. KIỂM ĐỊNH LIÊM CHÍNH & RỦI RO:")
    if not matched_disc:
        if matched_sjr:
            lines.append("• Tình trạng Scopus: ✅ ĐANG HOẠT ĐỘNG (Active - An toàn)")
        else:
            lines.append("• Scopus Discontinued: ✅ Không nằm trong danh mục bị loại")
    if not matched_hijacked:
        lines.append("• Tạp chí giả mạo: ✅ AN TOÀN (Chưa ghi nhận website cướp tên miền)")
    if retraction_count > 0:
        lines.append(f"• Lịch sử rút bài (Retraction Watch): ⚠️ Có {retraction_count} bài từng bị rút/đính chính")
    else:
        lines.append("• Lịch sử rút bài (Retraction Watch): ✅ 0 bài bị rút (Chỉ số liêm chính cao)")

    # PHẦN 6: KHUYẾN NGHỊ NỘP BÀI
    lines.append("\n🎯 5. KHUYẾN NGHỊ NỘP BÀI (VERDICT):")
    if matched_disc or matched_hijacked:
        lines.append("⛔ TUYỆT ĐỐI KHÔNG NỘP BÀI: Tạp chí có rủi ro pháp lý học thuật rất lớn, bài báo sẽ không được công nhận.")
    elif (matched_sjr and matched_sjr.get("quartile") == "Q1") or (matched_abdc and matched_abdc.get("abdc") in ("A*", "A")):
        lines.append("✅ RẤT NÊN NỘP: Tạp chí quốc tế hàng đầu, đủ điều kiện bảo vệ Luận án Tiến sĩ, xét PGS/GS và nghiệm thu đề tài NCKH trọng điểm.")
    elif matched_sjr or matched_abdc:
        lines.append("✅ ĐỦ CHUẨN: Tạp chí quốc tế uy tín, phù hợp công bố kết quả nghiên cứu khoa học.")
    elif matched_vn or matched_hdgs:
        lines.append("✅ ĐỦ CHUẨN QUỐC GIA: Đạt chuẩn khoa học Việt Nam 2026, tính điểm HĐGSNN và nghiệm thu đề tài NCKH trong nước.")

    lines.append("\n💡 Nhắn mã ISSN hoặc tên tạp chí khác để tiếp tục tra cứu.")
    return "\n".join(lines)[:1950]

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

    # 3. Đồng bộ danh sách tạp chí bị mạo danh (Hijacked Journals) & Phân hạng (ABDC, SJR Q1-Q4)
    sync_hijacked_journals(lookup_db)
    sync_academic_rankings(lookup_db)

    # 4. Nếu người dùng truyền từ khóa tra cứu trực tiếp từ giao diện GitHub Actions (workflow_dispatch input)
    manual_query = os.environ.get("LOOKUP_QUERY", "").strip()
    if manual_query:
        query_result = search_journal_in_lookup(manual_query, lookup_db)
        all_notifications.append(query_result)

    # 4. Nếu KHÔNG dùng Cloudflare Worker Webhook thì mới quét getUpdates
    if not CLOUDFLARE_WORKER_URL:
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
