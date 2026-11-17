@echo off
rem ReelsMaker virtual microphone: tray app. Real mic (C-1U) -> voice cleaning -> VB-Cable; apps use "CABLE Output" as microphone.
rem First time: pip install -r apps\mic-clean\requirements.txt, install VB-Cable, then tray menu -> "learn noise".
start "" pythonw "%~dp0apps\mic-clean\micclean.py"
exit /b 0
