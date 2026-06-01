# JLC NGspice launcher

Run once on Windows to let the plugin start the local JLC NGspice service on demand:

```powershell
powershell -ExecutionPolicy Bypass -File .\install-launch-protocol.ps1 -EnginePath "D:\lceda-pro-sim\lceda-pro-sim-server.exe"
```

After registration, the plugin can call `jlc-ngspice-launch://start` when port `51115` is not available.
