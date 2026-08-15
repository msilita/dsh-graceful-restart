window.__ModuleLoader__.load({
	id: "dsh-graceful-restart",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		/**
		 * dsh-graceful-restart — client 半。
		 *
		 * 无自定义浮层：重启完成的消息显示在 DSH 原生位置
		 * `conversation.input.dock`（输入框上方的整行，additive slot）。
		 *
		 * 机制（pid 对比，覆盖所有连接情况）：
		 *   · 页面加载时记录"当前进程 pid"（loadedPid）
		 *   · 每次 connection/reset 后查 /status：
		 *       - restarted=true 且 pid ≠ loadedPid → 页面存活期间发生了重启 → 自动刷新一次
		 *       - restarted=true 且 pid = loadedPid → 重启后新开/刷新后的页面 → 输入框上方提示
		 *       - restarted=false → 正常启动，无动作
		 *   · 刷新后的新页面 loadedPid 匹配当前进程 → 不再刷新（防循环）
		 */
		exports.name = "dsh-graceful-restart-client";
		exports.apply = function apply(ctx) {
			var React = require("react");

			// 每次页面加载都发 ack（幂等；Host 未就绪时失败静默）
			try {
				fetch("/plugins/dsh-graceful-restart/ack", { method: "POST" }).catch(function () {});
			} catch (e) {}

			// 状态机：normal | done（提示用）
			var state = { phase: "normal" };
			var listeners = [];
			function setPhase(next) {
				if (state.phase === next) return;
				state.phase = next;
				for (var i = 0; i < listeners.length; i++) listeners[i](next);
			}
			function subscribe(fn) { listeners.push(fn); return function () { listeners = listeners.filter(function (f) { return f !== fn; }); }; }

			// 页面加载时记录"当前进程 pid"：判断"连接到的进程是否与页面加载时一致"。
			var loadedPidPromise = fetch("/plugins/dsh-graceful-restart/status", { method: "GET" })
				.then(function (res) { return res.json().catch(function () { return null; }); })
				.then(function (data) { return data && data.pid != null ? String(data.pid) : null; })
				.catch(function () { return null; });

			// 监听连接建立/恢复事件：确认 restarted 信号后决定刷新或提示
			var timer = null;
			ctx.on("connection/reset", function () {
				if (timer !== null) return; // 同一次连接只确认一次
				timer = window.setTimeout(function () { timer = null; }, 1000);
				try {
					loadedPidPromise.then(function (loadedPid) {
						return fetch("/plugins/dsh-graceful-restart/status", { method: "GET" }).then(function (res) {
							return res.json().catch(function () { return null; });
						}).then(function (data) {
							if (data && data.restarted === true) {
								var pid = String(data.pid);
								if (loadedPid !== null && pid !== loadedPid) {
									// 页面存活期间进程变了（重启）→ 刷新一次（新页面 loadedPid 会匹配，不再刷新）
									window.location.reload();
								} else {
									// 连接到的进程与页面加载时一致（重启后新开/刷新后的页面）→ 原生位置提示
									setPhase("done");
									window.setTimeout(function () { setPhase("normal"); }, 5000);
								}
							}
						});
					}).catch(function () {});
				} catch (e) {}
			});

			// 原生位置提示：conversation.input.dock（输入框上方的整行，additive slot）
			var slots = ctx.get("slots");
			if (slots !== undefined) {
				slots.inject("conversation.input.dock", function () {
					return slots.register(
						{ name: "conversation.input.dock", id: "dsh-graceful-restart-notice", order: 100 },
						function Notice() {
							var pair = React.useState(state.phase);
							var current = pair[0];
							var setCurrent = pair[1];
							React.useEffect(function () {
								return subscribe(function (next) { setCurrent(next); });
							}, []);
							if (current !== "done") return null;
							var style = {
								display: "flex",
								alignItems: "center",
								gap: "8px",
								padding: "8px 14px",
								borderRadius: "8px",
								color: "#fff",
								background: "#16a34a",
								fontSize: "13px",
								lineHeight: 1.4,
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
