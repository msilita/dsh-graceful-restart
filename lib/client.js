window.__ModuleLoader__.load({
	id: "dsh-graceful-restart",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		/**
		 * dsh-graceful-restart — client 半。
		 *
		 * 信号 + 刷新，无轮询：
		 *   · 后端信号：新进程（被重启执行器拉起）的 /status 返回 restarted: true。
		 *   · 前端机制：监听 DSH 官方 connection/reset（连接建立/恢复事件）；
		 *     每次连接后 fetch 一次 /status 确认：
		 *        - restarted: true 且 pid ≠ 上次刷新时的 pid
		 *          → 这是"重启完成后的新连接"→ 记录 pid + 自动 reload()
		 *        - 其余情况 → 不动
		 *   · 提示：刷新后的页面（pid 匹配）显示"✅ 重启完成"，几秒后消失。
		 *
		 * pid 防循环：重启后新进程 pid 变化 → 刷新一次；刷新后新页面
		 * 再次连接，pid 与记录相同 → 不再刷新。下次重启 pid 又变 → 再刷新。
		 */
		exports.name = "dsh-graceful-restart-client";
		exports.apply = function apply(ctx) {
			var React = require("react");

			// 每次页面加载都发 ack（幂等；Host 未就绪时失败静默）
			try {
				fetch("/plugins/dsh-graceful-restart/ack", { method: "POST" }).catch(function () {});
			} catch (e) {}

			var PID_KEY = "dsh-graceful-restart-last-pid";
			var lastPid = null;
			try { lastPid = window.sessionStorage.getItem(PID_KEY); } catch (e) {}

			// 状态机：normal | done（提示用）
			var state = { phase: "normal" };
			var listeners = [];
			function setPhase(next) {
				if (state.phase === next) return;
				state.phase = next;
				for (var i = 0; i < listeners.length; i++) listeners[i](next);
			}
			function subscribe(fn) { listeners.push(fn); return function () { listeners = listeners.filter(function (f) { return f !== fn; }); }; }

			// 监听连接建立/恢复事件：确认 restarted 信号后刷新
			// （connection/reset 在页面首次连接和每次重连时都会触发）
			// hasConnected：页面打开后的首次连接跳过——
			//   新打开的页面本身已是最新，无需刷新；
			//   只有"页面存活期间的重连"（重启导致）才检查并刷新。
			var hasConnected = false;
			var timer = null;
			ctx.on("connection/reset", function () {
				if (timer !== null) return; // 同一次连接只确认一次
				timer = window.setTimeout(function () { timer = null; }, 1000);
				if (!hasConnected) { hasConnected = true; return; }
				try {
					fetch("/plugins/dsh-graceful-restart/status", { method: "GET" }).then(function (res) {
						return res.json().catch(function () { return null; });
					}).then(function (data) {
						if (data && data.restarted === true) {
							var pid = String(data.pid);
							if (lastPid === pid) {
								// 已刷新过这个进程（刷新后页面再次连接）：显示提示即可
								setPhase("done");
								window.setTimeout(function () { setPhase("normal"); }, 5000);
								return;
							}
							// 新进程：记录 pid + 刷新
							try { window.sessionStorage.setItem(PID_KEY, pid); } catch (e) {}
							window.location.reload();
						}
					}).catch(function () {});
				} catch (e) {}
			});

			// shell.overlay：重启完成提示
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
