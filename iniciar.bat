@echo off
setlocal
set "ROOT=%~dp0"
cd /d "%ROOT%"

echo === Backend (API Maletas) ===
cd /d "%ROOT%backend"
if not exist "node_modules" (
    echo Instalando dependencias del backend...
    call npm install
    if errorlevel 1 (
        echo Error al instalar dependencias del backend.
        pause
        exit /b 1
    )
    echo Backend: dependencias instaladas.
)
echo Inicializando base de datos (migraciones)...
call npm run init-db
if errorlevel 1 (
    echo Error al inicializar la base de datos.
    pause
    exit /b 1
)
echo Iniciando servidor backend en ventana nueva (puerto 3000)...
start "Backend Maletas - http://localhost:3000" cmd /k "cd /d ""%ROOT%backend"" && node server.js"
cd /d "%ROOT%"
echo Backend iniciado. Ventana del backend abierta por separado.
timeout /t 2 /nobreak >nul
echo.
echo === Frontend (Angular) ===
cd /d "%ROOT%epione-app"
if not exist "node_modules" (
    echo Instalando dependencias del frontend...
    call npm install
    if errorlevel 1 (
        echo Error al instalar dependencias del frontend.
        pause
        exit /b 1
    )
    echo Frontend: dependencias instaladas.
)
echo Iniciando aplicacion Angular...
call npm start
