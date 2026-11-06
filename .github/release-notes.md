**Pre-release.** The apps are not code-signed yet, so your system warns you the first time you open them.

| You have | Download |
| --- | --- |
| Windows | `Transcripables-Setup-*.exe`. When SmartScreen warns, choose **More info**, then **Run anyway**. |
| Mac with Apple Silicon | `Transcripables-*-arm64.dmg` |
| Intel Mac | `Transcripables-*-x64.dmg` |
| Chrome or Edge | `transcripables-v*.zip`. Extract it, then use **Load unpacked** on the extensions page. |

**On a Mac:** the first time macOS blocks the app, open **System Settings > Privacy & Security** and choose **Open Anyway**. If macOS says the app is damaged, run `xattr -cr /Applications/Transcripables.app`.

**macOS is less tested than Windows.** Automated tests build and open it and run its speech engine, but nobody has yet recorded a real meeting on a Mac.

Get permission from everyone in a meeting before you record it.
