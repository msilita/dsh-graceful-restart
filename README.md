# dsh-graceful-restart

DSH 优雅重启/关闭插件。**用户启动方式完全不变**（`dsh web`），插件自动"套壳"：
第一代进程阻止自身启动（webServer 随机端口，不占 3080）并拉起正式实例（继承控制台），
随后常驻为隐形 launcher——重启时在原控制台拉起新一代，并自动唤醒智能体继续工作。

**无常驻看门狗**（第一代只响应显式请求）、**无外部工具**（不需要手动启动 launcher）。

## 架构（v5，自动套壳）

```
用户终端（ConPTY 管道）
  └── dsh web（第一代，用户启动）
        ├── 插件 apply（无 DSH_LAUNCHER_WRAPPER）→ wrapper 模式：
        │     · 阻止启动：bundle patch 把 webserver 端口条件化为 0（OS 随机，不占 3080）
        │     · spawn 第二代（非 detached + inherit → 继承控制台 + IPC 通道）
        │     · 常驻：监听第二代的 IPC（restart/shutdown）
        └── 第二代（DSH_LAUNCHER_WRAPPER=1）→ 正常模式：
              · 监听 3080，输出回到用户终端（继承第一代的控制台）
              · 插件注册 restart_harness / shutdown_harness / /restart / /shutdown
重启（第二代触发，等轮次结束）：
  → 写 resume marker → IPC 通知第一代 {type:'restart', wake}
  → 第一代杀第二代 → 拉起第三代（同控制台 + env DSH_GRACEFUL_RESTART_WAKE=1）
  → 第三代正常服务 + 读 marker → 轮询等会话恢复 → steer 唤醒
关闭（shutdown）：IPC 通知第一代 → 第一代杀子进程 → 第一代退出（整个树结束）
```

## 触发语义

| 触发方式 | 行为 | 唤醒 |
|---|---|---|
| 模型工具 `restart_harness` | 重启 | ✅ 自动 `steer()` 继续 |
| 斜杠命令 `/restart` | 重启 | ❌ 等人 |
| 模型工具 `shutdown_harness` | 关闭（不重启） | — |
| 斜杠命令 `/shutdown` | 关闭（不重启） | — |

## 控制台输出（区分代际）

```
[dsh-graceful-restart] 第一代 wrapper：正在启动正式 dsh（几秒内完成）...
[dsh-graceful-restart] 正式 dsh 已启动 pid=xxxx（下方输出来自正式实例）
dsh web: http://127.0.0.1:3080          ← 正式实例（继承控制台）
[dsh-graceful-restart] 正式 dsh 实例开始服务
── 重启时 ──
[dsh-graceful-restart] 收到重启请求，正在拉起新一代 dsh...
dsh web: http://127.0.0.1:3080          ← 新一代（仍在本终端）
```

## 关键设计

- **"一切皆插件"的边界**：跨进程拓扑（父子、控制台归属）发生在插件运行之前，无法由插件接管；
  wrapper 通过在"第一个进程"里扮演启动代理实现同等效果，用户启动方式不变
- **Windows Terminal（ConPTY）限制**（实测三重确认）：AttachConsole 外部附加不可渲染、
  数字 fd 继承失效、detached 断链——唯一可靠的"输出回原终端"是**句柄继承链**
  （第一代继承用户终端 → 第二代继承第一代 → 第三代继承第一代）
- **父退杀子**：非 detached 子进程在父退出时被连带终止（实测）——第一代因此**常驻不退出**
- **唤醒时序**：会话恢复发生在客户端重连之后，apply 时 agents 为空——
  重启前写 marker（活跃会话 id），重启后轮询等待恢复再 steer
- **可配置**（settings.yaml，热重载）：
  ```yaml
  dsh-graceful-restart:
    continuePrompt: '（自定义的继续提示）'
  ```

## 安装

```powershell
dsh plugin --profile web add "file:D:/Project/dsh-graceful-restart"
```

重启 DSH 生效。改代码后重新 remove + add 同步（file: 是复制快照）。

## 文件清单（$DSH_HOME 下）

- `dsh-process.json` — pid/命令行索引
- `dsh-graceful-restart-executor.cjs` — 备用外部执行器（wrapper 不可用时的兜底）
- `dsh-resume.json` — 唤醒 marker（重启前写，唤醒完成后删除）
- `dsh-graceful-restart.log` — 插件 + wrapper 日志
- `dsh-graceful-restart-launcher.log` — 外部 launcher（备用）日志
