@echo off
title HLTV Recorder
cd /d "%~dp0"
rem Records the servers listed in hltv_recorder.ini. Close this window or press Ctrl+C to stop.
set PY=python
where py >nul 2>nul && set PY=py -3
%PY% -I hltv_recorder.py %*
pause
