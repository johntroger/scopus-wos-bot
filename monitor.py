#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Hệ thống Tự động Theo dõi & Cảnh báo Tạp chí bị loại khỏi Scopus + Cảnh báo sớm Retraction Watch / WoS
Hỗ trợ gửi thông báo tự động qua Zalo Bot (bot.zaloplatforms.com) và Telegram Bot.
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

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/128.0.0.0 Safari/537.36"
    )
}


# ==============================================================================
# 1. MODULE GỬI THÔNG BÁO QUA ZALO BOT & TELEGRAM BOT
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


def send_zalo_message(text: str) -> bool:
    """Gửi tin nhắn qua Zalo Bot Platform (https://bot.zaloplatforms.com)."""
    bot_token = os.environ.get("ZALO_BOT_TOKEN", "").strip()
    chat_id = os.environ.get("ZALO_CHAT_ID", "").strip()

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
                print(f"[Zalo] Đã gửi thành công phần {idx}/{len(chunks)}.")
            else:
                print(f"[Zalo] Lỗi từ Zalo API: {resp.status_code} - {data}")
                success = False
        except Exception as exc:
            print(f"[Zalo] Lỗi kết nối khi gửi tin nhắn: {exc}")
            success = False

    return success


def send_telegram_message(text: str) -> bool:
    """Gửi tin nhắn qua Telegram Bot API."""
    bot_token = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
    chat_id = os.environ.get("TELEGRAM_CHAT_ID", "").strip()

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
                print(f"[Telegram] Đã gửi thành công phần {idx}/{len(chunks)}.")
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


# ==============================================================================
# 3. KIỂM TRA SCOPUS DISCONTINUED & INACTIVE SOURCES
# ==============================================================================

def get_latest_scopus_excel_url() -> Tuple[str, str]:
    """Quét trang Elsevier Scopus Content để lấy URL file ext_list_*.xlsx mới nhất."""
    resp = requests.get(SCOPUS_CONTENT_PAGE, headers=HEADERS, timeout=30)
    resp.raise_for_status()
    html = resp.text

    # Tìm link chứa ext_list_*.xlsx trên Contentful CDN của Elsevier
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


def check_scopus_updates(state: dict, watchlist: dict) -> List[str]:
    """
    Tải và phân tích bảng tính Scopus Source List mới nhất:
    1. Kiểm tra sheet 'Discontinued Titles ...' để phát hiện tạp chí mới bị loại vì lý do chất lượng.
    2. Kiểm tra sheet 'Scopus Sources ...' để tra cứu mã ngành ASJC (14xx Quản trị/Kinh doanh, 20xx Kinh tế)
       và kiểm tra xem có tạp chí nào trong Watchlist bị chuyển sang 'Inactive' hay không.
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

    # Nếu tên file chưa đổi và đã có dữ liệu khởi tạo thì không cần tải lại 26MB mỗi ngày
    if filename == last_file and not is_first_run:
        print(f"[Scopus] File {filename} đã được kiểm tra trước đó. Không có bản cập nhật tháng mới.")
        return messages

    print(f"[Scopus] Đang tải file {filename} để phân tích...")
    resp = requests.get(excel_url, headers=HEADERS, timeout=120)
    resp.raise_for_status()
    excel_bytes = io.BytesIO(resp.content)

    wb = openpyxl.load_workbook(excel_bytes, read_only=True, data_only=True)
    sheet_names = wb.sheetnames
    print(f"[Scopus] Các sheet trong file: {sheet_names}")

    disc_sheet_name = next((s for s in sheet_names if "discontinued" in s.lower()), None)
    main_sheet_name = next((s for s in sheet_names if "scopus sources" in s.lower()), sheet_names[0])

    # Đọc sheet chính để lấy thông tin ASJC cho các Source ID và kiểm tra Watchlist
    excel_bytes.seek(0)
    df_main = pd.read_excel(excel_bytes, sheet_name=main_sheet_name, dtype=str)
    df_main.columns = [str(c).strip() for c in df_main.columns]

    # Map Source ID -> ASJC codes & Subject Area từ sheet chính
    source_id_col = next((c for c in df_main.columns if "sourcerecord id" in c.lower() or "source id" in c.lower()), df_main.columns[0])
    title_col = next((c for c in df_main.columns if "source title" in c.lower()), df_main.columns[1])
    status_col = next((c for c in df_main.columns if "active or inactive" in c.lower()), None)
    asjc_col = next((c for c in df_main.columns if "asjc" in c.lower()), None)

    asjc_prefixes = tuple(watchlist.get("asjc_prefixes", ["14", "20"]))
    watch_issns = {normalize_issn(x) for x in watchlist.get("issns", []) if normalize_issn(x)}
    watch_titles = {t.strip().lower() for t in watchlist.get("titles", []) if t.strip()}

    econ_bus_source_ids: Set[str] = set()
    for _, row in df_main.iterrows():
        sid = str(row.get(source_id_col, "")).strip()
        asjc_val = str(row.get(asjc_col, "")) if asjc_col else ""
        codes = [c.strip() for c in re.split(r"[;,\s]+", asjc_val) if c.strip()]
        if any(c.startswith(asjc_prefixes) for c in codes):
            econ_bus_source_ids.add(sid)

    # Đọc sheet Discontinued Titles
    if disc_sheet_name:
        excel_bytes.seek(0)
        df_disc = pd.read_excel(excel_bytes, sheet_name=disc_sheet_name, dtype=str)
        df_disc.columns = [str(c).strip() for c in df_disc.columns]

        d_id_col = next((c for c in df_disc.columns if "source id" in c.lower() or "sourcerecord" in c.lower()), df_disc.columns[0])
        d_title_col = next((c for c in df_disc.columns if "source title" in c.lower() or "title" in c.lower()), df_disc.columns[1])
        d_issn_col = next((c for c in df_disc.columns if "issn" in c.lower()), None)
        d_eissn_col = next((c for c in df_disc.columns if "e-issn" in c.lower() or "eissn" in c.lower()), None)
        d_reason_col = next((c for c in df_disc.columns if "reason" in c.lower()), None)
        d_pub_col = next((c for c in df_disc.columns if "publisher" in c.lower()), None)

        known_ids = set(state.get("known_discontinued_ids", []))
        current_ids = set()

        new_watchlist_disc = []
        new_econ_disc = []
        new_other_disc = []

        for _, row in df_disc.iterrows():
            sid = str(row.get(d_id_col, "")).strip()
            if not sid or sid.lower() == "nan":
                continue
            current_ids.add(sid)

            if sid not in known_ids:
                title = str(row.get(d_title_col, "N/A")).strip()
                issn = str(row.get(d_issn_col, "")).strip() if d_issn_col else ""
                eissn = str(row.get(d_eissn_col, "")).strip() if d_eissn_col else ""
                reason = str(row.get(d_reason_col, "Discontinued")).strip() if d_reason_col else "Discontinued"
                publisher = str(row.get(d_pub_col, "N/A")).strip() if d_pub_col else "N/A"

                norm_issn = normalize_issn(issn)
                norm_eissn = normalize_issn(eissn)
                issn_display = issn if issn and issn != "nan" else (eissn if eissn and eissn != "nan" else "N/A")

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

        state["known_discontinued_ids"] = sorted(list(current_ids))
        state["last_scopus_file"] = filename

        if is_first_run:
            msg = [
                f"✅ KHỞI TẠO HỆ THỐNG THEO DÕI SCOPUS THÀNH CÔNG",
                f"• Bản dữ liệu hiện tại: {filename} ({disc_sheet_name})",
                f"• Tổng số tạp chí trong danh sách Discontinued đã ghi nhận làm mốc: {len(current_ids)} tạp chí.",
                f"• Từ lần cập nhật tiếp theo của Elsevier, Bot sẽ gửi cảnh báo chi tiết các tạp chí mới bị loại."
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
# 4. KIỂM TRA RETRACTION WATCH (CẢNH BÁO SỚM TRƯỚC KHI WOS/SCOPUS LOẠI)
# ==============================================================================

def check_retraction_watch(state: dict, watchlist: dict) -> List[str]:
    """
    Đọc dữ liệu CSV mới nhất từ GitLab Crossref / Retraction Watch:
    - Phát hiện các bài báo mới bị rút (Retracted) hoặc bày tỏ quan ngại (Expression of Concern)
      thuộc các tạp chí trong Watchlist hoặc thuộc lĩnh vực Kinh tế - Quản trị - Marketing.
    - Cảnh báo sớm các tạp chí có nhiều bài bị rút cùng lúc (dấu hiệu sắp bị WoS đưa vào 'On Hold').
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

    df["Record_ID_Int"] = pd.to_numeric(df["Record ID"], errors="coerce").fillna(0).astype(int)
    max_record_id = int(df["Record_ID_Int"].max())
    last_record_id = int(state.get("last_retraction_record_id", 0))

    # Lần chạy đầu tiên: lưu mốc Record ID lớn nhất hiện tại
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
        journal = str(row.get("Journal", "N/A")).strip()
        title = str(row.get("Title", "N/A")).strip()
        subject = str(row.get("Subject", "")).strip()
        reason = str(row.get("Reason", "N/A")).strip()
        nature = str(row.get("RetractionNature", "Retraction")).strip()
        r_date = str(row.get("RetractionDate", "")).strip()

        item_text = (
            f"• [{nature}] Tạp chí: {journal}\n"
            f"  Bài báo: \"{title[:120]}{'...' if len(title) > 120 else ''}\"\n"
            f"  Ngày: {r_date} | Lý do: {reason[:120]}"
        )

        if journal.lower() in watch_titles:
            watchlist_hits.append(item_text)
        elif any(kw in subject.lower() or kw in journal.lower() for kw in bus_keywords):
            econ_hits.append(item_text)

    # Thống kê tạp chí có số bài bị rút tăng đột biến trong đợt cập nhật mới (dấu hiệu WoS On Hold)
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
# 5. HÀM CHÍNH (MAIN)
# ==============================================================================

def main():
    print(f"=== BẮT ĐẦU QUÉT DỮ LIỆU ({datetime.now(timezone.utc).isoformat()}) ===")
    state = load_json_file(
        STATE_FILE,
        {
            "last_scopus_file": "",
            "known_discontinued_ids": [],
            "last_retraction_record_id": 0,
            "last_updated": "",
        },
    )
    watchlist = load_json_file(WATCHLIST_FILE, {})

    all_notifications: List[str] = []

    # 1. Kiểm tra danh sách tạp chí bị loại khỏi Scopus (Elsevier)
    scopus_msgs = check_scopus_updates(state, watchlist)
    all_notifications.extend(scopus_msgs)

    # 2. Kiểm tra dữ liệu rút bài hàng ngày từ Retraction Watch (GitLab Crossref)
    rw_msgs = check_retraction_watch(state, watchlist)
    all_notifications.extend(rw_msgs)

    # Lưu trạng thái mới
    state["last_updated"] = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    save_json_file(STATE_FILE, state)

    # Gửi thông báo nếu có cập nhật mới
    if all_notifications:
        final_message = "\n\n" + ("=" * 28) + "\n\n"
        broadcast_notification(final_message.join(all_notifications))
    else:
        print("Không có biến động mới cần gửi thông báo trong lần quét này.")

    print("=== HOÀN TẤT ===")


if __name__ == "__main__":
    main()
