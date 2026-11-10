# Điểm OT Design — TrueWave

Web app tính điểm OT cho team design: quét thẳng board Trello theo ngày, tính điểm theo bảng phân loại sản phẩm (0.5đ đơn giản / 1đ phức tạp), có báo cáo tháng.

- **Hằng ngày** = các card trong list **`Done DD/MM`**
- **OT** = các card trong list **`OT DD/MM`**
- **Người làm** = member gắn trên card (tự nhận, không cần nhập tay)
- **Điểm** = label sản phẩm của card → tra bảng phân loại
- **Cột Template** = catalog sản phẩm; app quét cột này, đánh dấu **SKU mới** vừa thêm và báo sản phẩm chưa có nhãn (tab "Sản phẩm (Template)"). Cron hằng ngày cũng ghi log SKU mới.

## Chạy thử ở máy

```bash
npm install
cp .env.example .env     # điền TRELLO_KEY / TRELLO_TOKEN / TRELLO_BOARD
npm start                # mở http://localhost:3000
```

## Lấy Trello API key + token

1. Vào https://trello.com/power-ups/admin → tạo một Power-Up bất kỳ → tab **API key** → copy **Key**.
2. Bấm link **Token** cạnh đó → **Allow** → copy **Token**.
3. `TRELLO_BOARD` là id ngắn trong URL board (vd `trello.com/b/F9GPoy23/...` → `F9GPoy23`).

Token này chỉ đọc board của bạn. Giữ bí mật, không commit lên Git (đã có `.gitignore`).

## Deploy lên Railway

1. Đẩy thư mục này lên một repo GitHub (hoặc dùng Railway CLI).
2. Railway → **New Project → Deploy from GitHub repo** (hoặc *Empty Project* rồi *Deploy*).
3. Vào **Variables**, thêm:
   - `TRELLO_KEY`, `TRELLO_TOKEN`, `TRELLO_BOARD`
   - (tuỳ chọn) `TZ=Asia/Bangkok`, `CRON_DAILY=30 22 * * *`
   - (tuỳ chọn, để lưu phân loại bền vững) thêm một **Volume** mount vào `/data`, rồi đặt `CONFIG_PATH=/data/config.json`
4. Railway tự chạy `npm install` và `npm start`, tự cấp domain. Mở domain là dùng.

> Không thêm Volume thì app vẫn chạy, nhưng chỉnh phân loại 0.5/1 sẽ reset mỗi lần deploy lại (vì vẫn dùng mặc định theo từ khoá).

## Nền tảng khác

Chạy được trên bất kỳ host Node nào (Render, Fly.io, VPS…): chỉ cần Node ≥ 18, set biến môi trường như trên, lệnh chạy `npm start`.

## API (nếu muốn tích hợp)

- `GET /api/report?date=YYYY-MM-DD` → điểm theo người của 1 ngày
- `GET /api/month?month=YYYY-MM` → tổng + ma trận theo ngày của 1 tháng
- `GET /api/labels` → danh sách label + điểm hiện tại
- `POST /api/classify` `{ "name": "<label>", "points": 0.5 | 1 | null }` → chỉnh/xoá phân loại
