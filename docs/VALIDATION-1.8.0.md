# AI Buddy 1.8.0 validation

This release adds the self-contained Windows installer and optional character packages. The accepted 1.7.10 media is copied byte-for-byte: 198 action videos, 3,225 gaze images and 80 expression portraits per edition. No animation was encoded again.

- Installer protocol tests cover pinned manifests, package/file integrity, unsafe ZIP paths, HTTP 200/206/416, validator changes, throttling, timeouts, partial files, bounded retries, offline operation, transaction recovery, cancellation, disk-space calculations, locks, rollback and preservation of new save data.
- Native Windows checks include a Claude-only 30fps installation, adding Qwen while switching to 60fps, startup, and rollback to the previous program while retaining progress written after the update.
- Application regression uses isolated saves and synthetic events. The 11-role gallery, 18 actions per role, immediate character switching, 125% default scale, four window widths, feedback and dragging are checked in Electron.
- Both complete candidate trees are indexed and compared against the package reconstruction. Every independent resource ZIP is below 1 GiB.
- GitHub anonymous-download and final publication results are delivered in `VERIFICATION-1.8.0.json` on the Release. A local test is not a substitute for that final gate.

No paid model requests are made. Tests run on the development Windows machine with isolated data; PATH and .NET-discovery settings are removed for a self-contained smoke test. This is not a clean virtual-machine or physical-device compatibility matrix. The installer is not Authenticode-signed, so Windows may show an unknown-publisher prompt.

卸载默认保留个人存档、未知用户文件、安装管理器和恢复记录；不会静默清理历史备份。下载缓存也保留以支持断点继续和修复。确认不再需要后，可自行删除对应备份或缓存。

The uninstaller keeps personal data, unknown user files, the maintenance tool and recovery records by default. Download caches are retained for resuming and repair. Historical backups are not silently removed.
