# dsh-graceful-restart

DeepSeek Harness（dsh）的优雅重启 / 关闭 / 启动守护插件。

**用户启动方式完全不变**（`dsh web`）。插件自动"套壳"：第一代进程阻止自身启动（占用非正式端口）并拉起正式实例（继承同一控制台），随后常驻为**隐形 launcher**——负责重启时的换代、启动失败的自动回滚，以及向正式实例传递重启 / 关闭请求。

无常驻看门狗（第一代只响应显式请求）、无外部工具、无轮询、无多余常驻进程。

---

## 做了什么

### 1. 优雅重启（等当前轮次结束）

`restart_harness` 工具或 `/restart` 命令触发后，插件不会立刻杀进程，而是等待**所有 agent 轮次结束**（当前回复完整落盘）再优雅退出，由第一代在同一控制台拉起新一代——**不丢工作**。

### 2. 重启后自动唤醒继续

重启前把活跃会话 id 写入 marker；新一代启动后轮询等待会话恢复，然后自动 `steer()` **唤醒智能体继续之前的工作**。唤醒时的继续提示优先级：

```
restart_harness 的 continuePrompt 参数（智能体触发时指定）> settings.yaml 默认值 > 内置默认
```

### 3. 关闭与撤销

- `shutdown_harness` / `/shutdown`：等轮次结束后关闭整个进程树（第一代一并退出），不重启
- `cancel_harness_action`：**撤销**已安排但尚未执行的重启 / 关闭（触发后发现不需要了，随时改变主意）

### 4. 启动守护：失败自动回滚（核心）

每次 spawn 前记录**插件清单快照**（profile `package.json` 的 dependencies）；第二代启动失败（退出码非 0，或宽限期 20 秒内退出）时：

1. 对比当前清单与**最近一次成功基线** → 找出"该基线之后新增"的插件
2. 逐个 `dsh plugin remove`（官方 CLI，同步清理 bundles）→ **自动重试**
3. 仍失败 → 逐级回溯**更早的成功基线**（多版本 history），再卸掉下一批增量
4. 连续回滚达上限后保持第一代存活，明确提示手动处理

成功基线保留**多个版本**（设置菜单可调 `snapshotKeep`，1–10，默认 3）：第 N 次回滚使用第 N 个旧基线。启动成功（存活超宽限期）后新基线入列，与最新相同则不重复记录。

误判保护：Ctrl+C、显式关闭、显式重启都不触发回滚——只有**意外启动失败**才会。

### 5. 页面自动刷新（无轮询）

每个 DSH 进程的代际 ID = 进程启动时刻 `startedAt`。页面加载时把 ID 存入 localStorage；每次**连接恢复**（ws 重连成功）时查一次 `/status` 对比：

- ID 不同（或缺失）→ 页面状态可能过时 → **自动刷新一次**（先更新持久化值防循环）
- ID 相同（ws 抖动）→ 不动

覆盖：wrapper 重启、手动完整重启（`dsh web`）、守护回滚（服务真空期有短窗口重试）、**页面一直开着、DSH 关闭很久后重新打开**。不依赖轮询，只在连接事件时动作。

### 6. 设置菜单

设置页新增 **"优雅重启"** 页签（`settings.section`）：
- **快照保留版本数**（1–10，默认 3）——成功基线保留几个版本，回滚逐级回溯用

---

## 设想的场景

| 场景 | 行为 |
|---|---|
| 长任务进行中需要重启（升级配置、装插件） | 等轮次结束再退出，不打断当前回复；重启后自动唤醒继续 |
| 装了一个会破坏启动的插件 | 第二代 boot 失败 → 守护自动卸载新增插件 → 重试 → 恢复服务（全程无人值守） |
| 多个坏插件叠加、或回滚后仍失败 | 逐级回溯更早的成功基线，再多卸一批；达上限后停下并提示 |
| 重启/关闭安排错了 | `cancel_harness_action` 一键撤销，进程继续运行 |
| 浏览器页面一直开着，DSH 关闭很久后重新打开 | 连接恢复 → 代际 ID 对比 → 自动刷新 |
| 手动完整重启 / wrapper 重启 / 回滚换代 | 页面都自动刷新，无需手动 F5 |
| 想彻底关闭 | `shutdown_harness` / `/shutdown` 优雅退出整棵树 |

---

## 工作原理（自动套壳）

```
用户终端（ConPTY 管道）
  └── dsh web（第一代，用户启动，无 DSH_LAUNCHER_WRAPPER）
        ├── bundle patch 把 webServer 端口条件化：第一代用正式端口+1（不占 3080）
        ├── spawn 第二代（非 detached + inherit → 继承控制台 + IPC 通道）
        ├── 启动守护：快照插件清单 → 监测第二代存活/退出
        └── 第二代（DSH_LAUNCHER_WRAPPER=1）→ 正常模式：
              · 监听正式端口，输出回用户终端（句柄继承链）
              · 注册 restart_harness / shutdown_harness / cancel_harness_action
              · /restart /shutdown 命令、/status /settings 端点、设置菜单
重启：等轮次结束 → 写 resume marker → IPC 通知第一代
  → 第一代杀旧第二代 → 拉起新一代（同控制台 + WAKE=1）
  → 新一代服务 + 读 marker → 等会话恢复 → steer 唤醒
失败回滚：新一代启动失败（非 0 退出/过快退出）
  → 第一代对比清单基线 → dsh plugin remove 新增插件 → 重试（逐级回溯）
关闭：IPC 通知第一代 → 杀子 → 整个树退出
```

### 关键设计笔记

- **Windows Terminal（ConPTY）限制**（实测三重确认）：AttachConsole 外部附加不可渲染、数字 fd 继承失效、detached 断链——唯一可靠的"输出回原终端"是**句柄继承链**（用户终端 → 第一代 → 第二代 → 新一代）
- **父退杀子**：非 detached 子进程在父退出时被连带终止（实测）——第一代因此常驻不退出
- **唤醒时序**：会话恢复发生在客户端重连之后，apply 时 agents 为空——重启前写 marker（活跃会话 id），重启后轮询等待恢复再 steer
- **回滚走官方 CLI**：`node bin.js plugin --profile <p> remove <pkg>`，与手敲 `dsh plugin remove` 完全等价（bin.js 是 dsh 命令的真实入口），remove 成功后自动同步 bundles
- **每次 spawn 都重读清单**：重启期间新装的插件也能进回滚判定（否则只对比 wrapper 启动时的旧清单）
- **回滚重试携带唤醒**：重启+唤醒触发的失败，恢复后仍会唤醒（marker 未消费）

---

## 安装

```powershell
# 从 npm（发布后）
dsh plugin --profile web add dsh-graceful-restart

# 或本地开发
dsh plugin --profile web add "file:D:/Project/dsh-graceful-restart"
```

重启 DSH 生效（`file:` 依赖是复制快照——改代码后需 `remove` + `add` 重新同步）。

### 设置（settings.yaml 或设置页"优雅重启"）

```yaml
dsh-graceful-restart:
  snapshotKeep: 3   # 成功基线保留版本数（1-10，默认 3）
```

### 触发表

| 触发方式 | 行为 | 唤醒 |
|---|---|---|
| 模型工具 `restart_harness`（可带 `continuePrompt`） | 重启 | ✅ 自动 `steer()` 继续 |
| 斜杠命令 `/restart` | 重启 | ❌ 等人 |
| 模型工具 `shutdown_harness` | 关闭（不重启） | — |
| 斜杠命令 `/shutdown` | 关闭（不重启） | — |
| 模型工具 `cancel_harness_action` | 撤销未执行的重启/关闭 | — |

---

## 文件清单（$DSH_HOME 下）

- `dsh-process.json` — pid/命令行索引
- `dsh-graceful-restart-snapshot.json` — 启动守护快照（成功基线 history / current / rollbacks）
- `dsh-resume.json` — 唤醒 marker（重启前写，唤醒完成后清除）
- `dsh-graceful-restart.log` — 插件 + wrapper + 守护日志

---

## 致谢

- **dsh-restart 插件作者（anweat）**：本项目最初正是为了理解并**替换**其插件（它会中断会话）而起。感谢它的存在让我系统研究了 dsh 的插件加载、启动链路与 Windows 控制台机制——本插件的每一个设计决策（自动套壳、句柄继承链、官方 CLI 回滚）都建立在对那次踩坑的完整复盘之上。致敬并致谢。
- 本插件由 **dsh（DeepSeek Harness）** 驱动开发，全部代码由 **deepseek-flash-0813** 模型编写、调试与迭代完成——包括这个 README。

## License

MIT
