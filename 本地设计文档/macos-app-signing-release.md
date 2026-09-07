# macOS `.app` / `.dmg` 签名、公证与发布

本文记录从 PyInstaller 产出 `.app` 到最终可分发 `.dmg` 的流程。这里的“认证”指 Apple Developer ID 代码签名和 Apple Notarization（公证），不是 App Store 人工审核。

## 流程总览

只发布一个包含 `.app` 的 DMG 时，推荐的最短流程是：

```text
PyInstaller 生成 .app
        ↓
由内到外签名 .app（Developer ID Application）
        ↓
用已签名的 .app 制作 .dmg
        ↓
签名 .dmg
        ↓
只公证最外层 .dmg，装订 ticket
        ↓
校验 .app 和 .dmg → 计算 SHA256 → 上传发布
```

本文只覆盖最终发布 DMG 的推荐流程；不单独发布 `.app` 或 ZIP。

## 前置条件

- macOS、Xcode Command Line Tools（提供 `codesign`、`hdiutil`、`xcrun`）。
- PyInstaller 已安装，并有项目自己的 `.spec` 文件或入口 Python 文件。
- Apple Developer 账号，以及 `Developer ID Application` 证书。
- App 专用密码（Apple ID 方式）或 App Store Connect API Key。

先查看本机可用的签名身份：

```bash
security find-identity -v -p codesigning
```

输出中应包含类似：

```text
Developer ID Application: <姓名或公司> (<TEAM_ID>)
```

## 一次性配置 Notary 凭据

下面命令会把凭据保存在 macOS Keychain，后续用 `--keychain-profile` 引用，不要把密码写入脚本或 Git：

```bash
xcrun notarytool store-credentials "AC_NOTARY" \
  --apple-id "your-apple-id@example.com" \
  --team-id "YOUR_TEAM_ID" \
  --password "xxxx-xxxx-xxxx-xxxx"
```

## 每次发布的命令

以下变量按实际项目修改。`APP` 必须指向 PyInstaller 生成的 `.app`。

```bash
export APP_NAME="ScienceDiscovery"
export APP="dist/${APP_NAME}.app"
export DMG="dist/${APP_NAME}-macos.dmg"
export SIGN_IDENTITY="Developer ID Application: <姓名或公司> (<TEAM_ID>)"
export NOTARY_PROFILE="AC_NOTARY"
```

### 1. PyInstaller 生成 `.app`

优先使用项目已有的 `.spec` 文件：

```bash
python3 -m PyInstaller --clean --noconfirm path/to/ScienceDiscovery.spec
```

没有 `.spec` 时可以使用入口文件：

```bash
python3 -m PyInstaller --clean --noconfirm \
  --windowed --name "$APP_NAME" path/to/main.py
```

### 2. 签名 `.app`

这是一个适合普通 PyInstaller 包的简化命令；如果 App 有复杂的 Framework、Helper 或特殊 entitlement，应按嵌套代码由内到外分别签名。

```bash
codesign --deep --force --verbose \
  --options runtime --timestamp \
  --sign "$SIGN_IDENTITY" "$APP"

codesign --verify --deep --strict --verbose=4 "$APP"
codesign -dvvv "$APP" 2>&1 | \
  egrep 'Authority|TeamIdentifier|Timestamp|Notarization'
```

如果项目有 hardened runtime 所需的权限文件，在 `--sign` 前加：

```bash
--entitlements path/to/entitlements.plist
```

### 3. 用已签名的 `.app` 制作 `.dmg`

使用临时目录添加 Applications 快捷入口。制作 DMG 时复制已经完成签名的 `.app`：

```bash
stage_dir="$(mktemp -d)"
trap 'rm -rf "$stage_dir"' EXIT

ditto "$APP" "$stage_dir/$APP_NAME.app"
ln -s /Applications "$stage_dir/Applications"

rm -f "$DMG"
hdiutil create \
  -volname "$APP_NAME" \
  -srcfolder "$stage_dir" \
  -ov -format UDZO "$DMG"

rm -rf "$stage_dir"
trap - EXIT
```

### 4. 签名并公证最外层 `.dmg`

```bash
codesign --force --verbose --timestamp \
  --sign "$SIGN_IDENTITY" "$DMG"

codesign --verify --verbose=4 "$DMG"

xcrun notarytool submit "$DMG" \
  --keychain-profile "$NOTARY_PROFILE" \
  --wait

xcrun stapler staple "$DMG"
xcrun stapler validate "$DMG"
```

### 5. 发布前最终校验

```bash
hdiutil verify "$DMG"
spctl --assess --type open \
  --context context:primary-signature \
  --verbose=4 "$DMG"

shasum -a 256 "$DMG" > "${DMG}.sha256"
```

最终只上传公证完成后的 `.dmg` 和校验文件：

```text
ScienceDiscovery-macos.dmg
ScienceDiscovery-macos.dmg.sha256
```

## 常见错误

1. **先制作 DMG 再签名 App**：DMG 内的 App 与最终签名版本不一致。应先签名 App，再制作 DMG。
2. **签名后修改 App 或 DMG**：修改任何已签名内容都会使签名失效；改完必须重新签名、公证。
3. **只签名/公证 App，不处理 DMG**：最终上传的 DMG 可能没有有效签名或 ticket，用户仍会遇到 Gatekeeper 提示。
4. **`Authority=(unavailable)` 或 `invalid signature`**：先运行 `codesign --verify`；确认使用的是 Developer ID 证书，而不是 ad-hoc 签名（`-`）。
5. **凭据错误**：用 `xcrun notarytool history --keychain-profile "$NOTARY_PROFILE"` 查看提交记录，用 `xcrun notarytool log <submission-id> --keychain-profile "$NOTARY_PROFILE"` 查看失败原因。

## 与当前仓库的关系

当前仓库已有 Linux 单文件二进制打包脚本，但没有统一的 PyInstaller/macOS `.app` 打包脚本。因此本文把 PyInstaller 的 `.spec`/入口文件留为项目实际值；后续可以把上述步骤收敛为 `scripts/package-macos-release.sh`。

官方参考：

- [Signing Mac software with Developer ID](https://developer.apple.com/developer-id/)
- [Notarizing macOS software before distribution](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)
- [Packaging Mac software for distribution](https://developer.apple.com/documentation/xcode/packaging-mac-software-for-distribution)
- [Distributing software on macOS](https://developer.apple.com/macos/distribution/)
