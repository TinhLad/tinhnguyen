# FB Page Manager — Quét nội dung, viết bài AI, tạo video & đăng 1 click lên nhiều Facebook Page

Web app chạy trên máy của bạn (hoặc VPS), dùng **Facebook Graph API chính thức** để:

| Bước | Chức năng | Chi tiết |
|---|---|---|
| 1. Kết nối | Đăng nhập Facebook / dán Access Token | Lấy toàn bộ Page bạn quản lý (kể cả Page trong Business Manager) |
| 2. Tổng quan | Quét nội dung tất cả Page | Followers, số bài 30 ngày, tương tác TB/bài, giờ đăng hiệu quả nhất, Page "ngủ đông" >14 ngày, xem từng bài |
| 3. Phân tích AI | Claude đọc nội dung các Page | Chủ đề, giọng văn, cái gì đang hiệu quả / cần cải thiện, gợi ý ý tưởng nội dung gán cho từng Page |
| 4. Soạn & Đăng | Viết bài + tạo video + đăng 1 click | AI viết **phiên bản riêng cho từng Page** (tránh trùng lặp), tạo video slideshow từ ảnh + chữ + nhạc, đăng chữ/link/ảnh/video, hẹn giờ |
| 5. Lịch sử | Nhật ký đăng | Thành công / lỗi theo từng Page |

## 1. Cài đặt

Yêu cầu: **Node.js ≥ 20** và **ffmpeg** (để tạo video).

```bash
cd fb-page-manager
npm install
cp .env.example .env      # rồi điền thông tin
npm start                 # mở http://localhost:3000
```

Cài ffmpeg: macOS `brew install ffmpeg` · Ubuntu `sudo apt install ffmpeg` · Windows: tải tại ffmpeg.org và thêm vào PATH.

## 2. Tạo Facebook App (một lần)

1. Vào https://developers.facebook.com/apps → **Create App** → chọn loại **Business** (hoặc use case *"Manage everything on your Page"*).
2. **Settings → Basic**: copy **App ID** và **App Secret** vào `.env` (`FB_APP_ID`, `FB_APP_SECRET`).
3. Trong sản phẩm **Facebook Login** (hoặc **Facebook Login for Business**) → *Settings* → **Valid OAuth Redirect URIs**: thêm `http://localhost:3000/auth/callback` (đúng địa chỉ in ra ở cửa sổ lệnh khi chạy `npm start`).
4. Nếu App dùng **Facebook Login for Business**: vào *Configurations* → **Create configuration** → loại *User access token* → chọn các quyền bên dưới → copy **Configuration ID** vào `FB_LOGIN_CONFIG_ID`.
5. Các quyền cần: `pages_show_list`, `pages_read_engagement`, `pages_read_user_content`, `pages_manage_posts`, `business_management`.
6. **Tắt (Ctrl+C) và chạy lại `npm start`** mỗi khi sửa `.env`.

> **Dùng cho chính bạn:** chỉ cần tài khoản của bạn là *Admin/Developer* của App — **không cần App Review**, app ở chế độ Development vẫn đăng được lên Page bạn quản lý.
> **Cho người khác dùng:** phải qua App Review + Business Verification cho các quyền trên.

**Không đăng nhập được?**

| Thông báo / hiện tượng | Cách xử lý |
|---|---|
| Trang không hiện danh sách quyền, nút không phản hồi | Bạn đang mở file `index.html` trực tiếp → phải chạy `npm start` rồi vào `http://localhost:3000` |
| "Chưa điền FB_APP_ID và FB_APP_SECRET" | Điền vào `.env` (không phải `.env.example`), lưu file, chạy lại `npm start` |
| Facebook báo *"URL blocked"* / *redirect_uri* không hợp lệ | Thêm đúng Redirect URI ở bước 3 |
| Facebook báo *"Invalid Scopes"* / *"Feature unavailable"* | App loại Business → làm bước 4 (`FB_LOGIN_CONFIG_ID`), hoặc dùng Cách 2 bên dưới |
| Đăng nhập xong nhưng 0 Page | Khi Facebook hỏi, chọn **tất cả** Page và cấp đủ quyền |

**Cách nhanh (không cần OAuth):** mở [Graph API Explorer](https://developers.facebook.com/tools/explorer) → chọn App → *Get User Access Token* với các quyền trên → dán vào tab **Kết nối**. Nếu `.env` có App ID/Secret, token sẽ tự đổi sang loại dài hạn (~60 ngày), và Page token sinh ra từ đó không hết hạn.

## 3. Claude API (phân tích & viết bài)

Lấy key tại https://console.anthropic.com → điền `ANTHROPIC_API_KEY` vào `.env`.
Mặc định dùng `claude-opus-5-5`, effort `medium` (đổi qua `CLAUDE_MODEL`, `CLAUDE_EFFORT`).
Không có key thì app vẫn chạy — bạn tự viết nội dung, các phần khác hoạt động bình thường.

## 4. Quy trình sử dụng gợi ý

```
Quét nội dung (tab 2) → Phân tích AI (tab 3) → "Dùng ý tưởng này" →
Viết bài cho từng Page → Chỉnh sửa → Tạo/tải video hoặc ảnh → Hẹn giờ (tuỳ chọn) → 🚀 Đăng lên N Page
```

## 5. Lưu ý vận hành & rủi ro

| Rủi ro | Mức độ | Cách app xử lý / khuyến nghị |
|---|---|---|
| Facebook giảm reach nội dung **trùng lặp** giữa các Page | Cao | AI viết phiên bản khác nhau cho từng Page; hạn chế dùng nút "1 nội dung cho tất cả" |
| Bị đánh dấu **spam** khi đăng hàng loạt (lỗi 368) | Trung bình | Giãn cách `PUBLISH_DELAY_MS` (mặc định 3s/Page); tăng lên 10–30s nếu đăng >20 Page |
| Token hết hạn (lỗi 190) | Thấp | Đăng nhập lại; dùng App ID/Secret để có token dài hạn |
| Bản quyền nhạc trong video | Trung bình | Chỉ dùng nhạc có quyền sử dụng; video có thể bị tắt tiếng/gỡ |
| Lộ token | Cao nếu deploy public | Token chỉ lưu ở server (`data/store.json`, đã gitignore), không gửi ra trình duyệt; đặt `APP_PASSWORD` khi chạy trên VPS |

**Giới hạn hiện tại**
- Chỉ đọc/đăng trên Page **bạn quản lý**. Đọc Page của đối thủ cần quyền *Page Public Content Access* (App Review riêng) — không nên scrape vì vi phạm điều khoản Facebook.
- Video đăng dạng video thường trên Page (tự hiển thị ở tab Video/Reels tuỳ tỷ lệ khung hình); chưa dùng API Reels 3 bước.
- Hẹn giờ: 10 phút – 30 ngày (giới hạn của Facebook).

## Cấu trúc

```
server.js          API Express: kết nối, quét Page, AI, upload, tạo video, đăng bài, lịch sử
lib/facebook.js    Graph API (OAuth, đọc Page/bài, đăng text/link/ảnh/video, hẹn giờ, diễn giải lỗi)
lib/ai.js          Claude: phân tích Page & viết bài theo từng Page (structured JSON)
lib/video.js       ffmpeg: slideshow ảnh + chữ tiếng Việt + nhạc nền, 9:16 / 1:1 / 16:9
public/            Giao diện (HTML/CSS/JS thuần)
data/, media/      Dữ liệu & file local (không commit)
```
