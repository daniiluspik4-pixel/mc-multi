@echo off
cd /d %~dp0
if not exist node_modules call npm install
node --max-old-space-size=160 agent.js
pause
