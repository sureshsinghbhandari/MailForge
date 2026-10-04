@echo off
setlocal
rem ---------------------------------------------------------------------------
rem  MailForge - start the whole development stack WITHOUT Docker.
rem
rem    window 1  SMTP capture stand-in   SMTP 127.0.0.1:11025   (send test mail here)
rem    window 2  backend                 http://localhost:3100
rem    window 3  frontend (Vite)         http://localhost:5173
rem
rem  Uses an embedded PostgreSQL (data in .\data\pg), so nothing else needs installing.
rem  First run: installs npm packages and creates .env from a dev template.
rem  Login: admin@mailtest.local / dev-admin-password-123
rem  Close the three windows (or press Ctrl+C in each) to stop.
rem ---------------------------------------------------------------------------

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22+ is required but was not found on PATH.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing npm packages...
  call npm install
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
)

if not exist data mkdir data

if not exist .env (
  echo Creating .env for Docker-free development...
  (
    echo NODE_ENV=development
    echo APP_PORT=3100
    echo DATABASE_URL=pglite://../data/pg
    echo ATTACHMENT_DIR=../data/attachments
    echo MAIL_DOMAIN=mailtest.local
    echo MAILPIT_API_URL=http://127.0.0.1:18025
    echo INGEST_POLL_INTERVAL_MS=500
    echo SMTP_HOST=127.0.0.1
    echo SMTP_PORT=11025
    echo ADMIN_EMAIL=admin@mailtest.local
    echo ADMIN_PASSWORD=dev-admin-password-123
    echo COOKIE_SECURE=false
    echo TRUST_PROXY=false
  ) > .env
)

echo Starting SMTP capture stand-in, backend and frontend...
start "MailForge - SMTP stand-in (11025)" /d "%~dp0tests" cmd /k "set FAKE_SMTP_PORT=11025&& set FAKE_MAILPIT_HTTP_PORT=18025&& npx tsx support/fake-mailpit.ts"
start "MailForge - backend (3100)" /d "%~dp0backend" cmd /k "npm run dev"
start "MailForge - frontend (5173)" /d "%~dp0frontend" cmd /k "set BACKEND_URL=http://127.0.0.1:3100&& npm run dev"

echo.
echo   UI:    http://localhost:5173
echo   API:   http://localhost:3100/api/health
echo   SMTP:  127.0.0.1:11025  (recipients must be @mailtest.local)
echo.
rem Open the UI once the dev servers have had a moment to start.
timeout /t 6 /nobreak >nul
start "" http://localhost:5173
endlocal
