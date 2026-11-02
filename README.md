# Hệ thống Tự động Cảnh báo Tạp chí bị loại khỏi Scopus & Retraction Watch qua Zalo / Telegram (GitHub Actions)

Bộ công cụ này chạy tự động mỗi ngày **hoàn toàn miễn phí trên GitHub Actions** (không cần bật máy tính), giúp bạn:
1. **Theo dõi danh sách tạp chí bị loại khỏi Scopus (`Discontinued Titles`)** trực tiếp từ trang chủ chính thức của Elsevier ngay khi có bản cập nhật tháng mới.
2. **Ưu tiên lọc riêng khối ngành Kinh tế - Quản trị kinh doanh - Marketing** (mã ASJC `14xx`, `20xx` và từ khóa chuyên ngành) kèm thống kê tổng quan các ngành khác.
3. **Theo dõi danh sách tạp chí mục tiêu của riêng bạn (`watchlist.json`)** theo mã ISSN hoặc tên tạp chí.
4. **Cảnh báo sớm nguy cơ tạp chí bị Web of Science (WoS) đưa vào diện `"On Hold"` hoặc bị Scopus loại** thông qua việc quét dữ liệu cập nhật hàng ngày từ kho [Crossref Retraction Watch Data](https://gitlab.com/crossref/retraction-watch-data) (phát hiện các tạp chí trong ngành hoặc trong Watchlist có bài bị rút hoặc có số lượng bài bị rút tăng đột biến $\ge 5$ bài/ngày).
5. **Hỗ trợ gửi thông báo qua cả Zalo Bot và Telegram Bot** (điền Token bên nào thì gửi bên đó, điền cả hai thì gửi đồng thời cả hai).

---

## Hướng dẫn Cài đặt lên GitHub Actions trong 3 bước

### Bước 1: Tạo Bot Zalo (hoặc Telegram) để lấy `TOKEN` và `CHAT_ID`

#### A. Nếu dùng Zalo Bot (Khuyên dùng)
1. Truy cập trang quản lý chính thức của Zalo: **https://bot.zaloplatforms.com** (hoặc tìm công cụ **Zalo Bot Creator** trên Zalo).
2. Đăng nhập bằng tài khoản Zalo của bạn $\rightarrow$ Bấm **Tạo Bot** $\rightarrow$ Lưu lại mã **`ZALO_BOT_TOKEN`**.
3. Mở ứng dụng Zalo trên điện thoại, tìm tên con Bot bạn vừa tạo và nhắn cho nó một tin bất kỳ (ví dụ: `Xin chào`).
4. Mở trình duyệt hoặc Terminal/PowerShell trên máy tính, chạy lệnh sau (thay `<ZALO_BOT_TOKEN>` bằng token vừa lấy):
   ```powershell
   Invoke-RestMethod -Method Post -Uri "https://bot-api.zaloplatforms.com/bot<ZALO_BOT_TOKEN>/getUpdates" -ContentType "application/json" -Body '{"timeout": 10}' | ConvertTo-Json -Depth 10
   ```
5. Nhìn vào kết quả trả về, tìm trường `chat.id` $\rightarrow$ Lưu lại chuỗi đó làm **`ZALO_CHAT_ID`**.

#### B. Nếu dùng Telegram Bot (Tùy chọn)
1. Mở Telegram, nhắn `/newbot` cho **`@BotFather`** để nhận **`TELEGRAM_BOT_TOKEN`**.
2. Nhắn tin bất kỳ cho Bot của bạn, sau đó nhắn cho **`@userinfobot`** để lấy **`TELEGRAM_CHAT_ID`**.

---

### Bước 2: Đẩy thư mục `scopus-wos-bot` này lên một Repository trên GitHub

1. Truy cập https://github.com/new và tạo một repository mới (có thể chọn **Public** hoặc **Private** đều được; lưu ý **Public** sẽ được miễn phí không giới hạn số phút chạy GitHub Actions).
2. Đẩy toàn bộ các file trong thư mục `scopus-wos-bot` lên repository đó:
   * `.github/workflows/monitor.yml` (Cấu hình lịch chạy tự động lúc 07:30 sáng mỗi ngày giờ Việt Nam)
   * `monitor.py` (Mã nguồn chính)
   * `watchlist.json` (Danh sách tạp chí và mã ngành theo dõi)
   * `state.json` (Tệp lưu trạng thái tự động cập nhật sau mỗi lần quét)
   * `requirements.txt` (Danh sách thư viện Python)

---

### Bước 3: Khai báo Secrets trên GitHub và Bấm chạy thử

1. Trong trang Repository trên GitHub của bạn, vào **Settings** $\rightarrow$ **Secrets and variables** $\rightarrow$ **Actions** $\rightarrow$ Bấm nút **New repository secret**.
2. Thêm các biến sau (dùng kênh nào thì thêm kênh đó):
   * `ZALO_BOT_TOKEN`: Mã Token của Zalo Bot.
   * `ZALO_CHAT_ID`: Mã Chat ID Zalo của bạn.
   * *(Tùy chọn)* `TELEGRAM_BOT_TOKEN`: Mã Token của Telegram Bot.
   * *(Tùy chọn)* `TELEGRAM_CHAT_ID`: Mã Chat ID Telegram của bạn.
3. Chuyển sang tab **Actions** trên thanh menu của Repository $\rightarrow$ Chọn workflow **Scopus & Retraction Watch Alert Bot** ở cột bên trái $\rightarrow$ Bấm nút **Run workflow** để kiểm tra ngay lập tức!
   * **Ở lần chạy đầu tiên:** Bot sẽ tự động tải danh sách *Discontinued Titles* hiện tại của Scopus và mốc *Record ID* mới nhất của Retraction Watch, lưu vào `state.json` và gửi tin nhắn xác nhận **Khởi tạo thành công** về Zalo/Telegram của bạn.
   * **Từ các ngày tiếp theo:** Mỗi 07:30 sáng, GitHub Actions tự động chạy ngầm và chỉ gửi tin nhắn khi phát hiện tạp chí mới bị loại hoặc có bài bị rút mới.

---

## Tùy chỉnh Danh sách Tạp chí Theo dõi Riêng (`watchlist.json`)

Bạn có thể mở file [`watchlist.json`](watchlist.json) trực tiếp trên giao diện web của GitHub để thêm các tạp chí bạn đang dự định nộp bài vào mục `issns` hoặc `titles`:

```json
{
  "issns": [
    "0148-2963",
    "0309-0566",
    "0969-6989",
    "0265-1335"
  ],
  "titles": [
    "Journal of Business Research",
    "European Journal of Marketing",
    "Journal of Retailing and Consumer Services",
    "International Marketing Review"
  ],
  "asjc_prefixes": [
    "14",
    "20"
  ]
}
```
* Mã `14`: Khối ngành *Business, Management and Accounting* trên Scopus.
* Mã `20`: Khối ngành *Economics, Econometrics and Finance* trên Scopus.
