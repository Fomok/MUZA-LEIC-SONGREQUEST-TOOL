@echo off
title Song Bot (debug console)
cd /d "%~dp0"
if not exist node_modules (
  echo First run - installing dependencies...
  call npm install
)
npm start
pause
