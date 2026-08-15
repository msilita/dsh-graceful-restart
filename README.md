# dsh-graceful-restart

DSH 优雅重启/关闭插件：**等当前轮次结束后退出**；重启由一次性执行器拉起新进程（**输出回到原终端**），工具触发时自动唤醒智能体继续工作。

**无常驻看门狗、无 IPC、零文件标志**——执行器是一次性进程，任务完成即结束。

## 架构（v3.5）

```
触发（restart_harness 工具=重启+唤醒 | shutdown_harness 工具=关闭 | /restart | /shutdown）
  → 插件内存 pendingAction，监听 agent/status，所有 agent idle（turn/end 已落盘）后：
      - 重启+唤醒：写 dsh-resume.json（活跃会话 id 列表）
      - restart：spawn 一次性执行器（detached + stdio ['ignore',1,2]）
      - shutdown：不 spawn，直接 process.exit(0)
  → 执行器（detached，无控制台，父退出后存活）等旧 DSH 死（60s 上限）
  → 拉起新 DSH：同 argv/cwd，stdio ['ignore',1,2] + windowsHide
      - fd 1/2 = 旧 DSH 的 stdout/stderr（Windows Terminal ConPTY 管道 / conhost 句柄）
        → 新 DSH 输出回到用户启动 dsh 的终端
      - windowsHide（CREATE_NO_WINDOW）：父无控制台时系统不会为新 DSH 创建新 conhost 窗口
  → 执行器阻塞到新 DSH 退出（父退出会连带杀死共享控制台的子进程）
  → 新 DSH 插件 apply：读 env DSH_GRACEFUL_RESTART_WAKE → WAKE=1 时读 dsh-resume.json，
      轮询等待会话从持久化恢复（客户端重连触发 resume），然后 steer 唤醒 → 清 marker
  → Client 半检测连接恢复 → 自动 location.reload() 一次 → POST /ack（兼容保留）
```

## 触发语义

| 触发方式 | 行为 | 唤醒 |
|---|---|---|
| 模型工具 `restart_harness` | 重启 | ✅ 重启后自动 `steer()` 继续 |
| 斜杠命令 `/restart` | 重启 | ❌ 等人 |
| 模型工具 `shutdown_harness` | 关闭（不重启） | — |
| 斜杠命令 `/shutdown` | 关闭（不重启） | — |

## 关键设计

- **无看门狗**：执行器是一次性进程，等旧死 → 拉起 → 新 DSH 退出后随之退出。崩溃不自动恢复（DSH 原生会话恢复会修复历史并提示 `TOOL_OUTCOME_UNKNOWN`）
- **零 IPC**：代际信息走环境变量（`DSH_GRACEFUL_RESTART_WAKE`），会话恢复信息走 `dsh-resume.json` marker
- **输出回原终端**：执行器继承 DSH 的 stdout/stderr fd（Windows Terminal 的 ConPTY 管道），新 DSH 再继承执行器的同一 fd——整条句柄继承链让新进程日志出现在用户启动 dsh 的窗口（`AttachConsole` 在 ConPTY 下不可渲染，故不用）
- **windowsHide**：`CREATE_NO_WINDOW` 阻止系统为无控制台父进程的子进程创建新 conhost 窗口
- **唤醒时序**：会话恢复发生在客户端重连之后（apply 时 agents 为空），所以先写 marker、再轮询等待目标会话出现后 steer（此前"apply 时立即 steer"的版本永不生效）
- **自动刷新**：Client 半轮询 `/plugins/dsh-graceful-restart/status`，检测"断开 → 恢复"后 `location.reload()` 一次，`sessionStorage` 标记防循环

## 优雅重启/关闭（核心保证）

触发返回后**当前轮次正常收尾**：tool/result 提交、assistant 总结写入、`turn/end` 落盘（`agent/status → idle` 确认）→ 才 `process.exit(0)`。**永远不会在轮次中途杀进程**，会话历史始终完整。

## 安装

```powershell
dsh plugin --profile web add "file:D:/Project/dsh-graceful-restart"
```

重启 DSH 生效。改代码后重新 remove + add 同步（file: 是复制快照）。

## 文件清单（$DSH_HOME 下）

- `dsh-process.json` — pid/命令行索引（插件上报，执行器读取以重建启动参数）
- `dsh-graceful-restart-executor.cjs` — 一次性重启执行器（运行时生成）
- `dsh-resume.json` — 唤醒 marker（重启前写，唤醒完成后删除）
- `dsh-graceful-restart.log` — 插件 + 执行器日志
