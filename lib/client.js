window.__ModuleLoader__.load({
	id: "dsh-graceful-restart",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		/**
		 * dsh-graceful-restart — client 半。
		 *
		 * 极简：一个信号，一个动作。
		 *   信号：新进程（被重启执行器拉起）的 /status 返回 `restarted: true`。
		 *   动作：页面加载时 fetch 一次 /status（非轮询）→ 看到 restarted
		 *         → 显示"✅ 重启完成"提示，几秒后自动消失。
		 *
		 * 不需要刷新：DSH 前端在连接恢复后自动 resync 会话 UI（官方机制）。
		 * 不需要防循环：页面加载只 fetch 一次，restarted 只是本次进程的
		 * 代际属性（正常启动为 false），提示后自然结束。
		 */
		exports.name = "dsh-graceful-restart-client";
		exports.apply = function apply(ctx) {
			var React = require("react");

			// 每次页面加载都发 ack（幂等；Host 未就绪时失败静默）
			try {
				fetch("/plugins/dsh-graceful-restart/ack", { method: "POST" }).catch(function () {});
			} catch (e) {}

			// 启动信号：fetch 一次 /status
			var state = { phase: "normal" }; // normal | done
			var listeners = [];
			function setPhase(next) {
				if (state.phase === next) return;
				state.phase = next;
				for (var i = 0; i < listeners.length; i++) listeners[i](next);
			}
			function subscribe(fn) { listeners.push(fn); return function () { listeners = listeners.filter(function (f) { return f !== fn; }); }; }

			try {
				fetch("/plugins/dsh-graceful-restart/status", { method: "GET" }).then(function (res) {
					return res.json().catch(function () { return null; });
				}).then(function (data) {
					if (data && data.restarted === true) {
						setPhase("done");
						// 提示几秒后自动消失
						window.setTimeout(function () { setPhase("normal"); }, 5000);
					}
				}).catch(function () {});
			} catch (e) {}

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
