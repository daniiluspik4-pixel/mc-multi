@echo off
cd /d %~dp0
if not exist node_modules call npm install
:loop
node --max-old-space-size=160 agent.js
timeout /t 5
goto loop
