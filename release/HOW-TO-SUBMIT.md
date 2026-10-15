# 上架操作清单

这个目录里已经准备好了上架需要的东西，但**最后几步必须用你自己的账号**（本机没有任何 GitHub / npm 凭据），所以下面是要你亲手执行的部分。

已经做完的：

- `package.json` 已声明 `dsh.bundle` 并指向 `./cordis.patch.yml`——这是能被 `dsh plugin add` 安装的前提，也是投稿最常见的被拒原因（只声明 `dsh.client` 不行）
- `package.json` 的 `repository` / `homepage` / `bugs` 已指向 `https://github.com/ztl0001/dsh-notify`
- 收录条目已生成：`release/awesome-dsh-plugin/ztl0001__dsh-notify.yml`
- `screenshots.json` + `assets/screenshot-1.png`：市场详情页会展示的真实通知截图
- `npm run release:check` 全部通过（等价于市场 CI 的机械检查）

---

## 一、建仓库并推送

```sh
cd dsh-notify
git remote add origin https://github.com/ztl0001/dsh-notify.git
git push -u origin main
```

仓库要**先在 GitHub 上建好**（空的就行，不要勾 README/gitignore）。

然后给仓库加上 `dsh-plugin` topic（仓库页右上 About → 齿轮 → Topics）。这是收录的硬性要求之一。

## 二、投稿到插件市场

市场（Settings → 插件市场）的列表来自 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 这个仓库。**收录 = 往它提一个 PR，只加一个文件**：

1. fork `awesome-dsh-plugin/awesome-dsh-plugin`
2. 新建文件 `data/plugins/ztl0001__dsh-notify.yml`，内容就是本目录 `ztl0001__dsh-notify.yml` 的内容
3. 提交 PR

要点：

- **不要手改它的 README**，那两个 README 是从 `data/plugins/*.yml` 生成的
- 一个 PR 最多加 3 条
- 仓库必须**建满 1 天**，CI 会自动检查。今天建的会被打回，明天再提即可
- CI 会重新拉取你仓库的 `package.json` 检查 `dsh.bundle`，并重新生成 README

## 三、发布到 npm（可选，但推荐）

发了 npm 之后市场会显示下载量、并且安装时跳过源码构建授权。**收录本身不依赖它**。

发布有几个前提，请留意：

- 需要一个 npm 账号，并且 `@` 作用域不需要——这个包名 `dsh-notify` 是无作用域的，直接 `npm publish` 即可
- 本机**没有安装 npm CLI**（只有 Node 和 pnpm）。装一个再发布：

  ```sh
  # 用 Node 自带的 corepack 启用 npm，或到 nodejs.org 下载安装
  corepack enable npm
  npm login
  cd dsh-notify
  npm publish --access public
  ```

- 发布**必须在仓库已存在之后**做：npm 包的 `repository` 字段要能指回真实仓库，否则市场不会把这个包和你的仓库关联起来
- `prepack` 会自动跑 `release:check`，不通过就发不出去

## 四、做完之后确认

```sh
cd dsh-notify
npm run release:check     # 机械检查
npm test                  # 33 项
```

然后等一天再提 PR（仓库年龄门槛）。

---

## 想知道能不能用，先本地装

在投稿之前不用等市场，本地就能装：

```sh
dsh plugin --profile desktop add <仓库地址或本地路径>
```

或者用本仓库自带的手装脚本（会先备份 profile 配置）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install-local.ps1
```

**装完要重启 DSH**：profile 的 bundle/patch 层在启动时合成，不会自动重载。重启后随便跑一个任务，任务真正结束时会弹通知。

> ⚠️ 别用「往 profile 的 `cordis.patch.yml` 里加一行 `- id: dsh-notify`」这种写法。
> patch 层只能*按 id 覆盖已有条目*，插件还没加载时那一行没有目标，DSH 启动会直接
> 失败（all-or-nothing，整个宿主起不来）。新插件必须先作为 bundle 出现在 profile
> 的 `dsh.profile.bundles` 里，由加载器读它自己的 `dsh.bundle.patch`（`insert:` 行）
> 插入条目——`install-local.ps1` 做的就是这件事。这个坑我第一次装的时候就踩了。

撤销：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/uninstall-local.ps1
```
