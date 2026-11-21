# 遇到问题？请到 Steam 讨论帖留言

> 本文是 Steam 创意工坊讨论帖 [Having a problem? Post it here](https://steamcommunity.com/workshop/filedetails/discussion/3799476240/563668239243120957/) 的翻译。如需提问或报告问题，请在该讨论帖中留言——不必使用英文，直接用中文写即可。

如果出了问题，请到 [Steam 讨论帖](https://steamcommunity.com/workshop/filedetails/discussion/3799476240/563668239243120957/) 留言：游戏崩溃、玩家无法完成加入、画面显示错误，或一局游戏出了故障。

**如果你的手机或平板电脑完全打不开加入页面**，请先阅读 [手机或平板电脑无法连接？](phone-connection-troubleshooting.md)。大多数连接问题都与该文介绍的 Wi-Fi、防火墙或路由器设置有关。

### 报告加入卡住的问题之前

启动一位玩家的游戏最多可能需要一分钟，在较慢的电脑上尤其如此。只要加入页面上 **正在加入…** 下方的那一行还在计时和变化，就说明仍在运行，请保持页面打开。

---

## 需要提供的信息

不必回答所有问题。前两项最有帮助。

### 1. 发生了什么，以及你原本预期会怎样

一两句话就够了。如果出现错误提示，请原样复制，包括下方较小的灰色文字，或者附上截图或屏幕照片。

### 2. 连接报告（加入或大厅问题）

*如果问题发生在对局中，请跳过这一步。*

在电脑上打开 **Couch Co-Op 二维码**，然后查看 **连接**。在 **连接问题** 下选择失败的连接，点击 **复制报告**，再粘贴到你的留言中。

报告会说明哪一步失败了、每一步用了多长时间、主机认为哪里出了问题，并列出下文所述日志文件的路径。

### 3. 日志文件

如果你已经复制了连接报告，里面就有确切的路径。

**游戏日志**，位于主机电脑上：

- Windows: `%APPDATA%\SlayTheSpire2\logs\godot.log`
- Linux: `~/.local/share/SlayTheSpire2/logs/godot.log`
- macOS: `~/Library/Application Support/SlayTheSpire2/logs/godot.log`

**玩家日志**。每位加入的玩家都会在主机电脑上运行一份隐藏的独立游戏副本，并各自记录日志。如果某位玩家卡在加入过程中，通常能从该玩家的日志中找到原因，游戏日志中通常没有。

第一位加入的玩家是 slot-2，下一位是 slot-3，以此类推。slot-2 的日志路径为：

- Windows: `%APPDATA%\SlayTheSpire2\couch-coop\headless-slots\slot-2\SlayTheSpire2\logs\godot.log`
- Linux: `~/.local/share/SlayTheSpire2/couch-coop/headless-slots/slot-2/SlayTheSpire2/logs/godot.log`
- macOS: `~/Library/Application Support/SlayTheSpire2/couch-coop/headless-slots/slot-2/Library/Application Support/SlayTheSpire2/logs/godot.log`

如果没有 `headless-slots` 文件夹，日志就在 `couch-coop/seat-logs/slot-2.log`，位于游戏日志所在的同一个 `SlayTheSpire2` 文件夹内。

**哪些行重要**。在这两种日志中，我最需要的是包含 `[couchcoop]` 的行（例如 `[INFO] [couchcoop] ...`），以及所有 `[ERROR]` 行，即使其中没有提到 couchcoop。通常这些就够了。

**在粘贴整份日志之前**：这是公开讨论帖。日志中包含你的 SteamID64（一串以 7656 开头、能关联到你的 Steam 个人资料的长数字），以及文件路径中你电脑的用户名。日志不包含密码或其他玩家的账户。如果你不想公开这两项信息，请在粘贴前替换掉，或者只贴出 `[couchcoop]` 和 `[ERROR]` 行。如果需要更多信息，我会再问你。

### 4. 版本和模组

- 你使用的是游戏的 **稳定** 分支还是 **公开测试** 分支。
- **你安装的其他模组**。每位玩家的游戏副本都会加载与主机相同的模组，所以即使主机的游戏运行正常，其他模组也可能导致玩家无法加入。
- 主机的操作系统。
- CouchCoop 的版本（如果你知道的话）。否则我会默认你用的是最新版。

### 5. 有助于缩小范围的信息

- 每次都会发生，还是只是偶尔发生？
- 每位玩家都会遇到，还是只有一位？
- 以前是否正常？之后有没有什么变化，比如游戏更新或新安装的模组？
