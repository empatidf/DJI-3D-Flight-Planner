@echo off
echo ====================================
echo  3D Flight Planner - Backend Server
echo ====================================
echo.
echo Starting FastAPI server on http://localhost:8000
echo Press Ctrl+C to stop the server
echo.

cd /d "%~dp0"
py -m uvicorn main:app --host 127.0.0.1 --port 8000 --reload

pause
