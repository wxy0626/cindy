; NSIS runs before Electron/i18next. Keep the supported client languages here, with
; English fallback for other installer languages. Windows styles the dialogs.
!macro cindyDirectoryMessage KEY
  ${Switch} $LANGUAGE
    ${Case} 2052 ; zh-CN
      StrCpy $cindyDirectoryMessage "${${KEY}_zh_CN}"
      ${Break}
    ${Default}
      StrCpy $cindyDirectoryMessage "${${KEY}_en}"
      ${Break}
  ${EndSwitch}
!macroend

!define cindyDirectoryNotWritable_en "Cindy cannot write to this installation directory. Choose another directory, or close apps using its files and check your security software before trying again."
!define cindyDirectoryNotWritable_zh_CN "Cindy 无法写入这个安装目录。请选择其他目录，或关闭占用文件的程序并检查安全软件后重试。"

!define cindyDirectoryDifferentUser_en "Windows authorization used a different account. To keep Cindy installed for your account, choose a directory you can write to. To install for all users, go back and select that option."
!define cindyDirectoryDifferentUser_zh_CN "Windows 授权使用了另一个账号。如需仅为当前账号安装 Cindy，请选择可写入的目录；如需为所有用户安装，请返回并选择该选项。"
