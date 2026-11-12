@echo off
cd /d "%~dp0"
echo Allowing UFTI through Windows Firewall (private networks only)...
netsh advfirewall firewall show rule name="UFTI" >nul 2>&1 || netsh advfirewall firewall add rule name="UFTI" dir=in action=allow protocol=TCP localport=8787 profile=private >nul 2>&1 || echo (Run once as Administrator if the phone cannot connect)
node server.js
pause
