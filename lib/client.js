window.__ModuleLoader__.load({
	id: "dsh-graceful-restart",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		/**
		 * dsh-graceful-restart — client 半。
		 *
		 * 事件驱动，零轮询。两个确定信号：
		 *   1. 启动信号：新进程（被重启执行器拉起）的 /status 返回
		 *      `restarted: true`。页面加载时 fetch 一次（非轮询）：
		 *      看到 restarted → 显示"✅ 重启完成"，短暂后消失。
		 *   2. 重连信号：DSH 官方 `connection/reset`（重连完成事件）——
		 *      重启期间旧页面 WebSocket 断开，新进程连上时触发；
		 *      此时自动 location.reload() 一次（sessionStorage 防循环）。
		 *
		 * "正在重启"提示由触发方承担：/restart 命令或 restart_harness
		 * 工具的结果文本本身就是"重启已安排"的反馈。
		 */
		exports.name = "dsh-graceful-restart-client";
		exports.apply = function apply(ctx) {
			var React = require("react");

			// 每次页面加载都发 ack（幂等；Host 未就绪时失败静默）
			try {
				fetch("/plugins/dsh-graceful-restart/ack", { method: "POST" }).catch(function () {});
			} catch (e) {}

			// 1) 启动信号：fetch 一次 /status，读取 restarted
			var state = { phase: "normal" }; // normal | done
			var listeners = [];
			function setPhase(next) {
				if (state.phase === next) return;
				state.phase = next;
				for (var i = 0; i < listeners.length; i++) listeners[i](next);
			}
			function subscribe(fn) { listeners.push(fn); return function () { listeners = listeners.filter(function (f) { return f !== fn; }); }; }

			var doneTimer = null;
			try {
				fetch("/plugins/dsh-graceful-restart/status", { method: "GET" }).then(function (res) {
					return res.json().catch(function () { return null; });
				}).then(function (data) {
					if (data && data.restarted === true) {
						// 本进程是重启拉起的：显示"重启完成"提示，几秒后消失
						setPhase("done");
						doneTimer = window.setTimeout(function () { setPhase("normal"); }, 4000);
					}
				}).catch(function () {});
			} catch (e) {}

			// 2) 重连信号：DSH 官方 connection/reset（重连完成）→ 刷新一次
			var KEY = "dsh-graceful-restart-reloaded";
			var alreadyReloaded = false;
			try { alreadyReloaded = window.sessionStorage.getItem(KEY) === "1"; } catch (e) {}
			if (!alreadyReloaded) {
				ctx.on("connection/reset", function () {
					// 连接重连完成（重启后的新进程连上了）→ 刷新旧页面
					try { window.sessionStorage.setItem(KEY, "1"); } catch (e) {}
					if (doneTimer !== null) window.clearTimeout(doneTimer);
					window.setTimeout(function () { window.location.reload(); }, 800);
				});
			} else {
				// 自动刷新后的页面：清除标记，恢复正常
				try { window.sessionStorage.removeItem(KEY); } catch (e) {}
			}

			// 3) shell.overlay：重启完成提示
			var slots = ctx.get("slots");
			if (slots !== undefined) {
				slots.inject("shell.overlay", function () {
					return slots.register(
						{ name: "shell.overlay", id: "dsh-graceful-restart-status", order: 100 },
						function Overlay() {
							var pair = React.useState(state.phase);
							var current = pair[0];
							var setCurrent = pair[1];
							React.useEffect(function () {
								return subscribe(function (next) { setCurrent(next); });
							}, []);
							if (current !== "done") return null;
							var style = {
								position: "fixed",
								top: "16px",
								right: "16px",
								zIndex: 9999,
								padding: "10px 16px",
								borderRadius: "8px",
								color: "#fff",
								background: "#16a34a",
								fontSize: "14px",
								boxShadow: "0 4px 12px rgba(0,0,0,0.25)",
								pointerEvents: "none",
							};
							return React.createElement("div", { style: style }, "✅ 重启完成，系统已恢复");
						}
					);
				});
			}
		};
		return module.exports;
	}
});
