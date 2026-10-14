@echo off
title Illegal Soccer 3v3
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js is not installed yet. It's free and needed to run the game.
  echo  Your browser will now open the download page. Install the "LTS" version,
  echo  then double-click this file again.
  echo.
  start "" https://nodejs.org/
  pause
  exit /b
)
if not exist node_modules (
  echo Getting the game ready for the first time, this takes a minute...
  call npm install --omit=dev
)
start "" http://localhost:3000
call npm start
pause
