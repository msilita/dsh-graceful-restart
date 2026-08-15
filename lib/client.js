window.__ModuleLoader__.load({
	id: "dsh-graceful-restart",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		/**
		 * dsh-graceful-restart — client 半。
		 *
		 * 无任何提示 UI（完全无感）：只负责"重启后自动刷新"。
		 *
		 * 机制（pid 对比，覆盖所有连接情况）：
		 *   · 页面加载时记录"当前进程 pid"（loadedPid）
		 *   · 每次 connection/reset 后查 /status：
		 *       - restarted=true 且 pid ≠ loadedPid → 页面存活期间发生了重启 → 自动刷新一次
		 *       - 其余情况 → 无动作（新打开/刷新后/抖动，页面本身已是最新）
		 *   · 刷新后的新页面 loadedPid 匹配当前进程 → 不再刷新（防循环）
		 */
		exports.name = "dsh-graceful-restart-client";
		exports.apply = function apply(ctx) {
			// 每次页面加载都发 ack（幂等；Host 未就绪时失败静默）
			try {
				fetch("/plugins/dsh-graceful-restart/ack", { method: "POST" }).catch(function () {});
			} catch (e) {}

			// 页面加载时记录"当前进程 pid"：判断"连接到的进程是否与页面加载时一致"。
			var loadedPidPromise = fetch("/plugins/dsh-graceful-restart/status", { method: "GET" })
				.then(function (res) { return res.json().catch(function () { return null; }); })
				.then(function (data) { return data && data.pid != null ? String(data.pid) : null; })
				.catch(function () { return null; });

			// 监听连接建立/恢复事件：确认 restarted 信号后决定是否刷新
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
								}
							}
						});
					}).catch(function () {});
				} catch (e) {}
			});
		};
		return module.exports;
	}
});
