@echo off
title QuizBlast Server
echo.
echo  ==========================================
echo   QuizBlast is starting...
echo   Open http://localhost:3000 in your browser
echo   Players join at http://10.100.21.123:3000
echo  ==========================================
echo.
set PATH=%PATH%;C:\Program Files\nodejs
cd /d "%~dp0"
node server.js
pause
