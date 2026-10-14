@echo off
chcp 65001 >nul
title FB Page Manager
cd /d "%~dp0"

echo ================================================
echo    FB Page Manager - dang khoi dong...
echo ================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [LOI] May tinh chua cai Node.js.
  echo Trinh duyet se mo trang tai Node.js: chon ban LTS, cai dat xong
  echo thi KHOI DONG LAI MAY va bam dup lai file MO-WEB.bat nay.
  start "" https://nodejs.org/
  pause
  exit /b 1
)

if not exist node_modules (
  echo Lan dau chay: dang cai dat thu vien, vui long doi 1-2 phut...
  call npm install
  if errorlevel 1 (
    echo [LOI] Cai dat that bai. Kiem tra ket noi mang roi chay lai.
    pause
    exit /b 1
  )
)

if not exist .env (
  copy .env.example .env >nul
  echo Da tao file .env - mo bang Notepad de dien FB_APP_ID, FB_APP_SECRET, ANTHROPIC_API_KEY.
)

echo.
echo Web dang chay tai: http://localhost:3000
echo GIU CUA SO NAY MO trong luc dung web. Dong cua so = tat web.
echo.
start "" cmd /c "timeout /t 3 >nul & start http://localhost:3000"
node server.js
echo.
echo Web da dung. Neu co loi o tren, chup man hinh gui lai de duoc ho tro.
pause
