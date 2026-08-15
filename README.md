# dsh-graceful-restart

DSH 优雅重启插件：**等当前轮次结束后退出，由一次性重启执行器拉起新进程**；工具触发时自动唤醒智能体继续工作。

**无常驻看门狗**——重启由一次性执行器完成，任务结束即自毁，零残留、无互相拉起。

## 架构

```
触发（/restart 命令 | restart_harness 工具）
  → 插件内存 pendingAction + spawn 一次性"重启执行器"（detached + IPC）
  → 插件监听 agent/status，所有 agent idle（turn/end 已落盘）后：
      IPC 通知执行器 proceed → 插件 process.exit(0)
  → 执行器探测旧 DSH 退出 → spawn 新 DSH（env: DSH_GRACEFUL_RESTART_WAKE=1/0）
  → 新 DSH 插件 apply：读 env → WAKE=1 时 steer 唤醒
  → Client 半检测连接恢复 → 自动 location.reload() 一次 → POST /ack
  → 插件收到 /ack → IPC 通知执行器 → 执行器 60s 超时或收 ack 后自毁
```

## 触发语义

| 触发方式 | 唤醒 | 说明 |
|---|---|---|
| 模型工具 `restart_harness` | ✅ | 智能体在工作，重启后自动 `steer()` 继续 |
| 斜杠命令 `/restart` | ❌ | 人工触发，等人 |

## 关键设计

- **无看门狗**：执行器是一次性进程，proceed → 拉起 → ack/超时 → 自毁。崩溃不自动恢复（DSH 原生会话恢复会修复历史并提示 `TOOL_OUTCOME_UNKNOWN`）
- **零文件标志**：意图走 IPC/内存，代际信息走环境变量。文件只剩 `dsh-process.json`（pid 上报）
- **IPC 通道**：插件 spawn 执行器带 `stdio: ['ignore','ignore','ignore','ipc']`；执行器 spawn 新 DSH 也带 ipc，新 DSH 插件 apply 时可 `process.send({type:'ack'})` 直达执行器
- **自动刷新**：Client 半轮询 `/plugins/dsh-graceful-restart/status`，检测"断开 → 恢复"后 `location.reload()` 一次，`sessionStorage` 标记防循环
- **ack 确认**：页面加载即 `POST /plugins/dsh-graceful-restart/ack`（幂等），执行器收到 ack 或 60s 超时后退出

## 优雅重启（核心保证）

触发返回后**当前轮次正常收尾**：tool/result 提交、assistant 总结写入、`turn/end` 落盘（`agent/status → idle` 确认）→ 才 `process.exit(0)`。**永远不会在轮次中途杀进程**，会话历史始终完整。

## 安装

```powershell
dsh plugin --profile web add "file:D:/Project/dsh-graceful-restart"
```

重启 DSH 生效。改代码后重新 remove + add 同步（file: 是复制快照）。

## 文件清单（$DSH_HOME 下）

- `dsh-process.json` — pid/命令行索引（插件上报）
- `dsh-graceful-restart-executor.cjs` — 一次性重启执行器（运行时生成）
- `dsh-graceful-restart.log` — 插件 + 执行器日志

## 测试

```bash
node test/sandbox-test.mjs   # 执行器全链路：重启+唤醒 / 无 ack 存活
node test/apply-test.mjs     # host apply 集成
```
