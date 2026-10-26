@echo off
title HLTV Demo Viewer
cd /d "%~dp0"
rem Opens the demo viewer in your browser. Drag a .dem onto this file to open it directly.
set PY=python
where py >nul 2>nul && set PY=py -3
%PY% -I demo_viewer.py %*
if errorlevel 1 pause
