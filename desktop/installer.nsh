; Passos extra do instalador da GALCAD (electron-builder, NSIS).
!macro customInstall
  DetailPrint "A configurar os solvers (code_aster)..."
  nsExec::ExecToLog '"$INSTDIR\GALCAD.exe" --galcad-setup'
!macroend
