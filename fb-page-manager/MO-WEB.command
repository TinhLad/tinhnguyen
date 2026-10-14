#!/bin/bash
# Mac: bấm đúp để chạy (lần đầu: chuột phải → Open)
cd "$(dirname "$0")"
if ! command -v node >/dev/null; then
  echo "Chưa cài Node.js — đang mở trang tải. Cài xong hãy chạy lại file này."
  open https://nodejs.org/
  read -p "Nhấn Enter để đóng..."
  exit 1
fi
[ -d node_modules ] || npm install || { read -p "Cài đặt thất bại. Nhấn Enter..."; exit 1; }
[ -f .env ] || cp .env.example .env
(sleep 3 && open http://localhost:3000) &
echo "Web đang chạy tại http://localhost:3000 — giữ cửa sổ này mở trong lúc dùng."
node server.js
