# GitHub 构建流程（CI，自动打包 Windows + macOS）

> 把代码推到 GitHub，云端自动打 **Windows(.msi/.exe)** 与 **macOS(.dmg，已签名)** 安装包。
> Mac 上无法本地打 Windows 包，这是出 Windows 包的主要方式。
> 本地命令见 [`本地运行与打包.md`](./本地运行与打包.md)。

- **仓库**：https://github.com/sjz128751/shijinze-copy （**公开**仓库）
- **额度**：公开仓库 Actions **免费、无每月分钟上限**，随便推随便打。
  （私有仓库才计费：2000 分钟/月，且 macOS runner ×10、Windows ×2，很贵。）

---

## 1. 工作流概览

配置文件：`.github/workflows/build.yml`

- **触发方式**：
  - 推送到 `main`/`master` 分支 → 自动构建
  - 或 Actions 页面手动点 **Run workflow**（`workflow_dispatch`）
- **两个并行 job**：
  - `windows`（`windows-latest`）→ 出 `.msi` + `.exe`
  - `macos`（`macos-latest`，Apple Silicon）→ 出**已签名** `.dmg`
- 每个 job 结束把安装包作为 **Artifact** 上传（默认保留 90 天）。

### 每步做什么
1. checkout 代码 → 装 Node / Rust（带缓存）
2. （仅 macOS）导入签名证书到临时钥匙串
3. `npm install` → `npm run tauri build`
4. 上传产物 artifact

---

## 2. Mac 包在 CI 里怎么签名的

CI 的 Mac runner 上没有你本机的证书，所以用两个**仓库 Secret** 把证书带上去：

| Secret 名 | 内容 |
|---|---|
| `MAC_CERT_P12_BASE64` | 自签名证书 `Clipboard Manager Dev` 导出的 `.p12` 的 base64 |
| `MAC_CERT_PASSWORD` | 该 p12 的密码（本项目为 `cmcm`）|

workflow 的 `Import signing certificate` 步骤会：解码 p12 → 建临时钥匙串 → 导入 → 设置分区列表 → 供 codesign 使用。之后 `npm run tauri build` 读 `tauri.conf.json → bundle.macOS.signingIdentity = "Clipboard Manager Dev"` 完成签名。

> 产物签名与本地一致（`Authority=Clipboard Manager Dev`），辅助功能授权能长期绑住。

### 如何（重新）设置这两个 Secret
证书源文件是当初创建的 `cm.p12`（密码 `cmcm`），若需重建证书见 `CLAUDE.md`。设置 Secret 两种方式：

**方式一：网页手动**（最简单）
1. 生成 base64：`base64 < cm.p12 | tr -d '\n' > cert.txt`
2. GitHub 仓库 → Settings → Secrets and variables → Actions → New repository secret
3. 加 `MAC_CERT_P12_BASE64`（粘 cert.txt 内容）与 `MAC_CERT_PASSWORD`（值 `cmcm`）

**方式二：用 API 脚本**（需要一个有 `repo` 权限的 PAT + PyNaCl）
```bash
pip3 install --user pynacl
TOKEN="<你的PAT>"; REPO="sjz128751/shijinze-copy"
PK=$(curl -s -H "Authorization: Bearer $TOKEN" "https://api.github.com/repos/$REPO/actions/secrets/public-key")
KEY=$(echo "$PK" | python3 -c "import sys,json;print(json.load(sys.stdin)['key'])")
KEYID=$(echo "$PK" | python3 -c "import sys,json;print(json.load(sys.stdin)['key_id'])")
enc(){ python3 -c "import sys,base64;from nacl import public,encoding;print(base64.b64encode(public.SealedBox(public.PublicKey('$KEY'.encode(),encoding.Base64Encoder())).encrypt(sys.argv[1].encode())).decode())" "$1"; }
curl -s -X PUT -H "Authorization: Bearer $TOKEN" "https://api.github.com/repos/$REPO/actions/secrets/MAC_CERT_P12_BASE64" -d "{\"encrypted_value\":\"$(enc "$(cat cert.txt)")\",\"key_id\":\"$KEYID\"}"
curl -s -X PUT -H "Authorization: Bearer $TOKEN" "https://api.github.com/repos/$REPO/actions/secrets/MAC_CERT_PASSWORD" -d "{\"encrypted_value\":\"$(enc cmcm)\",\"key_id\":\"$KEYID\"}"
```

---

## 3. 怎么触发一次构建

**A. 推代码（会自动构建）**
```bash
git add -A
git commit -m "xxx"
git push                        # 推到 main → 自动触发
```

**B. 手动**：GitHub 仓库 → Actions → 左侧「Build」→ Run workflow。

> ⚠️ 本机网络对 GitHub **SSH（22/443）被墙**，但 **HTTPS 通**。推送用 HTTPS + PAT：
> ```bash
> git remote set-url origin https://github.com/sjz128751/shijinze-copy.git
> git push -u origin main       # 提示 Username 填账号，Password 填 PAT（不是登录密码）
> ```
> PAT 生成：GitHub → Settings → Developer settings → Personal access tokens (classic) → 勾 `repo`。

---

## 4. 怎么下载打好的安装包

**A. 网页**：仓库 → Actions → 点最近一次成功的运行 → 拉到底部 **Artifacts**：
- `shijinze-copy-windows`（含 `.msi` 与 `.exe`）
- `shijinze-copy-macos`（含 `.dmg`）

**B. 命令行**（需 PAT）：
```bash
TOKEN="<你的PAT>"; REPO="sjz128751/shijinze-copy"
# 取最近一次运行 id
RUN=$(curl -s -H "Authorization: Bearer $TOKEN" "https://api.github.com/repos/$REPO/actions/runs?per_page=1" | python3 -c "import sys,json;print(json.loads(sys.stdin.read(),strict=False)['workflow_runs'][0]['id'])")
# 列 artifacts 并逐个下载解压到 ~/Downloads
curl -s -H "Authorization: Bearer $TOKEN" "https://api.github.com/repos/$REPO/actions/runs/$RUN/artifacts" | \
 python3 -c "import sys,json;[print(a['id'],a['name']) for a in json.loads(sys.stdin.read(),strict=False)['artifacts']]" | \
 while read ID NAME; do
   curl -sL -H "Authorization: Bearer $TOKEN" "https://api.github.com/repos/$REPO/actions/artifacts/$ID/zip" -o "$HOME/Downloads/$NAME.zip"
   unzip -oq "$HOME/Downloads/$NAME.zip" -d "$HOME/Downloads/$NAME"
 done
```

---

## 5. 安全 & 注意
- **PAT 只用于「推送代码 / 建 Secret / 下载 artifact」**，CI 构建本身不需要它。用完可删/重置。
- 证书（Secret）是加密存储，即使公开仓库也不会泄露；删 PAT 不影响 CI。
- 公开仓库代码对所有人可见；若不想公开，改私有仓库后要注意 Actions 额度（见开头）。
- 想更省额度/更可控，可改触发方式：只保留 `workflow_dispatch`（纯手动），或只在打 tag 时构建。
