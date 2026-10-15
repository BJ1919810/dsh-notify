# dsh-notify

<https://github.com/ztl0001/dsh-notify>

DSH 任务完成时，在 Windows 通知栏弹一条原生通知。

你可以把 DSH 窗口最小化去干别的，不用一直盯着它——任务真的做完了，通知会告诉你。通知里带上**会话标题**、**结果状态**和**最后一条回复的摘要**：

> ✅ 给 DSH 加一个任务完成通知插件
> 已实现 Windows 原生通知：监听 turn/end 与 agent/status，在 agent 真正空闲时弹出通知……

## 它和其他「回合结束就响」的做法有什么不同

DSH 里「一个回合结束」不等于「任务做完了」。开着 **goal 目标模式**时，一个目标会跑几十个回合；中间每个回合结束都弹一条通知，只会让人把通知关掉。

这个插件把两个信号合起来判断：

| 信号 | 说明 | 单独用的问题 |
| --- | --- | --- |
| `session/event` 的 `turn/end` | 带结束原因（完成／出错／被取消……） | 目标是多回合的，每回合都通知太吵 |
| `agent/status` 的 `idle` | 真正没有任何驱动在跑 | 不知道是怎么结束的 |

**做法**：回合结束时只*记录*结果，等 agent 进入 `idle`（再等一小段时间确认没有立刻继续）才发通知。于是**一条通知 = 一件真正做完的事**。

挂了 goal 目标时更严格：中间回合一律安静，只在**目标完成或阻塞**时通知一次。唯一的例外是 agent 停下来在等人（提问／阻塞／报错）——这时候它已经不自己往下跑了，值得打断你。

## 安装

```sh
dsh plugin --profile <你的 profile> add dsh-notify
```

在插件市场（Settings → 插件市场）里搜 `dsh-notify` 也能一键安装。

安装后在 **Settings → 插件** 里可以改配置，也可以直接写进 profile 的 `cordis.patch.yml`：

```yaml
- id: dsh-notify
  name: dsh-notify
  config:
    notifyOn: every-turn
    onlyMainSessions: true
    settleDelayMs: 400
    includeSummary: true
    includeCwd: false
    summaryLimit: 220
    sound: kind
```

## 配置项

| 项 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关。关掉后插件照常加载，但一条通知都不发。 |
| `notifyOn` | `every-turn` | `every-turn`：每个回合结束通知一次，但挂了目标的会话只在整个目标结束时通知；`attention`：只在 agent 停下来等人时通知；`never`：从不通知。 |
| `onlyMainSessions` | `true` | 不通知子代理（subagent）会话。 |
| `settleDelayMs` | `400` | agent 进入空闲后再等这么久（毫秒）才发，用来把紧接着继续的几个回合合并成一条。 |
| `includeSummary` | `true` | 带上会话标题和最后一条回复的摘要。 |
| `includeCwd` | `false` | 附带工作目录，便于区分同时跑的多个会话。 |
| `summaryLimit` | `220` | 正文最大字符数。 |
| `sound` | `kind` | `kind`：按结果自动选（完成用 `Default`，出错用 `Reminder`）；`silent`：静音；也可以填具体的 WinRT 提示音名（`Reminder`／`IM`／`Mail`／`SMS`／`Alarm`…）。 |
| `appId` | 空 | 可选的 AppUserModelID（例如某个应用快捷方式的 AUMID）。留空时按 `DSH_APP_USER_MODEL_ID` 环境变量 → Windows PowerShell 的顺序回退。 |

## 环境要求

- **Windows**。用的是 WinRT 的 toast API，别的平台没有这个东西；不是 Windows 时插件会记一条 warning 并安静地不工作，不会让宿主启动失败。
- Node `^22.19.0 || >=24.0.0`。
- 通知由 `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`（系统自带的 Windows PowerShell 5.1）弹出，**不需要**安装 BurntToast 之类的模块，也没有任何第三方依赖。

通知不出现时，常见原因是 **专注助手（Focus Assist）／勿扰模式**被打开，或者系统通知被整体关掉了。日志里会有一条 `dsh-notify:` 开头的记录说明结果。

## 它是怎么做的（给想看代码的人）

代码分三层，每层只做一件事：

| 文件 | 职责 |
| --- | --- |
| `lib/format.js` | 纯函数：结束原因映射成通知类型、Markdown 压成一行、截断、拼出最终文案。**不碰任何 I/O**，所以规则本身可以被测试读清楚。 |
| `lib/powershell-toast.js` | 只负责把一段标题/正文变成一条真正弹出来的 Windows 通知。 |
| `lib/index.js` | 只有一个职责：接事件。也就是上面那套「回合结束只记录、agent 空闲才通知」的接线。 |
| `lib/config.js` | 把配置收敛成可依赖的值——手写进 profile 的非法值也要能兜住。 |

几点实现上的取舍：

- **会话文本永远不进命令行。** 标题里可能有引号、换行、`$`、反引号、分号，任何一种都能改变一条命令的含义。所以文本走 stdin，脚本模板本身是一个不含插值点的常量。没有 shell 字符串可拼，也就没有转义代码。
- **传输层是纯 ASCII。** Windows PowerShell 通过控制台代码页读 stdin，直接写 UTF-8 字节在中文机器上会变成乱码（这正是开发时踩到的坑）。所以非 ASCII 字符统一编码成 `\uXXXX` 转义再传，与机器代码页无关。
- **XML 值都过 `SecurityElement::Escape`**，AppUserModelID 用单引号字面量并双写 `'`——脚本里仅有的两个插值点都封住了。
- **一条通知只弹一次。** 通知失败、会话被关掉、摘要读不出来，都只记日志，不会去打扰 agent 回合本身，也不会变成宿主里的 unhandled rejection。

## 开发

```sh
npm run link:peers   # 把宿主正在用的 schemastery 链到 node_modules（插件不 import cordis）
npm test             # 33 项：决策规则 + 事件接线（用注入的假传输，不会真弹通知）
npm run smoke        # 需要真实桌面：校验 Config schema，然后真弹一条通知
node scripts/preview-toast.mjs   # 只弹一条，用来看真实排版
```

`test/` 里没有任何一项会真的弹通知：`apply()` 的第三个参数是注入的传输层，测试传一个记录用的假实现。

### 装进真实宿主

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install-local.ps1
# 重启 DSH，然后随便跑一个任务
powershell -ExecutionPolicy Bypass -File scripts/uninstall-local.ps1   # 还原
```

**关键是「新插件必须先成为 bundle」**，这一条很容易踩错：profile 的 `cordis.patch.yml` 是*按 id 覆盖已有条目*的层，往里面写 `- id: 一个还没加载的插件` 只会留下一个指向不存在目标的 patch 行，DSH 启动时直接报错（而且是 all-or-nothing，整个宿主起不来）。让新插件进入加载器树的正确做法是把它加进 profile 的 `dsh.profile.bundles`，由加载器读它自己的 `dsh.bundle.patch`（`insert:` 行）来插入条目。`scripts/install-local.ps1` 做的就是这两件事。

## License

MIT
