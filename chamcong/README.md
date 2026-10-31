# ⏱️ App chấm công theo vị trí (GPS)

Web app chạy trên điện thoại (không cần cài đặt), dữ liệu lưu vào Google Sheets.

## Quy tắc

| Hành động | Điều kiện | Kết quả |
|---|---|---|
| Check-in | ≤ 08:00 (+ phút ân hạn nếu có) | **Đúng giờ** |
| Check-in | > 08:00 | **Trễ X phút** (tính từ 08:00) |
| Check-out | < 17:00 | **Về sớm X phút** |
| Check-out | ≥ 17:00 | **Đúng giờ** |
| Mọi lượt chấm | Cách địa điểm đã chọn > bán kính (mặc định 100 m) | **Từ chối**, gợi ý địa điểm đúng nếu đang đứng ở chi nhánh khác |
| Mọi lượt chấm | Sai số GPS > 100 m | **Từ chối** (vị trí không đủ tin cậy) |
| Check-in lần 2 trong ngày | — | Từ chối |
| Check-out khi chưa check-in | — | Từ chối |
| Check-out lần 2 | — | Cho phép, lấy giờ ra mới nhất |

Giờ so sánh theo phút: 08:00:59 vẫn là đúng giờ, 08:01 là trễ 1 phút.

## Chống gian lận (chế độ Google Sheets)

- **Giờ lấy theo máy chủ Google**, không theo điện thoại → chỉnh giờ điện thoại không có tác dụng.
- **Máy chủ tự tính khoảng cách** theo tọa độ trong Sheet, không tin kết quả từ điện thoại.
- **Gắn 1 nhân viên = 1 điện thoại** (`bindDevice`) → không chấm hộ bằng máy người khác. Đổi máy: xóa ô `Thiết bị` ở trang NhanVien.
- **Lưu nhật ký mọi lượt bị từ chối** (trang `NhatKy`) để quản lý rà soát.

## Hai chế độ

1. **Demo**: dữ liệu lưu trong trình duyệt của máy đang dùng. Mở app là thử được ngay (NV01 / 1234, mật khẩu quản lý `admin123`).
2. **Google Sheets**: dùng thật cho nhiều nhân viên. Cài đặt khoảng 5 phút, xem tab **Cài đặt** trong app hoặc phần đầu file `apps-script/Code.gs`.

## Cấu trúc Google Sheet

| Trang | Nội dung |
|---|---|
| `CauHinh` | Hạn check-in, giờ hết làm, phút ân hạn, sai số GPS tối đa, múi giờ, gắn thiết bị, mật khẩu quản lý |
| `DiaDiem` | ID, tên, vĩ độ, kinh độ, bán kính (m), hoạt động |
| `NhanVien` | Mã NV, họ tên, PIN, hoạt động, thiết bị |
| `ChamCong` | Mỗi nhân viên 1 dòng/ngày: giờ vào/ra, trạng thái, số phút trễ/sớm, khoảng cách, GPS |
| `NhatKy` | Mọi lượt chấm (chấp nhận + từ chối) kèm lý do |

## Giới hạn cần biết

- Trình duyệt không phát hiện được 100% app **giả lập GPS** (fake GPS) trên Android đã root hoặc có bật tùy chọn nhà phát triển. Muốn chặn triệt để cần app native hoặc thêm bước xác minh như chụp ảnh selfie hoặc yêu cầu kết nối Wi-Fi văn phòng.
- GPS trong nhà thường sai số 10–50 m. Bán kính nên để **≥ 100 m**; tòa nhà cao tầng nên để 150–200 m.
- Cần HTTPS để trình duyệt cho phép lấy vị trí (GitHub Pages đã có sẵn).
