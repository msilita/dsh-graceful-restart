window.__ModuleLoader__.load({
	id: "dsh-graceful-restart",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		/**
		 * dsh-graceful-restart — client 半。
		 *
		 * 职责：
		 *   1. 重启期间检测"后端连接恢复"（轮询 /plugins/dsh-graceful-restart/status，
		 *      从失败转为成功 = 新 DSH 已就绪）。
		 *   2. 界面提示（shell.overlay）：
		 *      - 检测到断开（重启中）→ "正在重启…"
		 *      - 检测到恢复（重启完成）→ "重启完成，即将刷新…" → 1.5s 后自动 reload
		 *      sessionStorage 标记防止刷新循环。
		 *   3. 页面加载（含刷新后）时 POST /plugins/dsh-graceful-restart/ack，
		 *      通知 Host（Host 再经 IPC 通知执行器退出）。
		 */
		exports.name = "dsh-graceful-restart-client";
		exports.apply = function apply(ctx) {
			var React = require("react");

			// 1) 每次页面加载都发 ack（幂等；Host 未就绪时失败静默）
			try {
				fetch("/plugins/dsh-graceful-restart/ack", { method: "POST" }).catch(function () {});
			} catch (e) {}

			// 2) 重启状态机
			var KEY = "dsh-graceful-restart-auto-reloaded";
			var alreadyReloaded = false;
			try { alreadyReloaded = window.sessionStorage.getItem(KEY) === "1"; } catch (e) {}

			// 外部可变状态 + 订阅（组件通过它感知变化）
			var state = { phase: alreadyReloaded ? "normal" : "tracking" };
			var listeners = [];
			function setPhase(next) {
				if (state.phase === next) return;
				state.phase = next;
				for (var i = 0; i < listeners.length; i++) listeners[i](next);
			}
			function subscribe(fn) { listeners.push(fn); return function () { listeners = listeners.filter(function (f) { return f !== fn; }); }; }

			if (!alreadyReloaded) {
				// 自动刷新后的页面会带标记；这里进入追踪：断开 → restarting，恢复 → done + reload
				var wasDown = false;
				var timer = window.setInterval(function () {
					try {
						fetch("/plugins/dsh-graceful-restart/status", { method: "GET" }).then(function (res) {
							// 任何 HTTP 响应（200/404/5xx）都说明后端可达——只有网络层
							// 连接失败（进程不在、端口未监听）才算"断开/重启中"。
							if (wasDown) {
								// 连接恢复（重启完成）：提示 + 1.5s 后刷新一次
								setPhase("done");
								try { window.sessionStorage.setItem(KEY, "1"); } catch (e) {}
								window.clearInterval(timer);
								window.setTimeout(function () { window.location.reload(); }, 1500);
							}
							wasDown = false;
						}).catch(function () {
							// 网络层失败（ECONNREFUSED 等）＝后端不可达（重启中）
							wasDown = true;
							setPhase("restarting");
						});
					} catch (e) {
						wasDown = true;
						setPhase("restarting");
					}
				}, 2000);
				ctx.effect(function () {
					return function () { window.clearInterval(timer); };
				});
			} else {
				// 这是自动刷新后的页面：清除标记，恢复正常
				try { window.sessionStorage.removeItem(KEY); } catch (e) {}
			}

			// 3) shell.overlay：重启状态提示（无 UI 时返回 null）
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
							if (current === "normal" || current === "tracking") return null;
							var style = {
								position: "fixed",
								top: "16px",
								right: "16px",
								zIndex: 9999,
								padding: "10px 16px",
								borderRadius: "8px",
								color: "#fff",
								background: current === "done" ? "#16a34a" : "rgba(15, 23, 42, 0.9)",
								fontSize: "14px",
								boxShadow: "0 4px 12px rgba(0,0,0,0.25)",
								pointerEvents: "none",
							};
							return React.createElement(
								"div",
								{ style: style },
								current === "restarting" ? "⏳ 正在重启 DeepSeek Harness…" : "✅ 重启完成，即将刷新页面…"
							);
						}
					);
				});
			}
		};
		return module.exports;
	}
});
