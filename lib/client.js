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
		 * 机制（轮询 /status + pid 对比，不依赖任何连接事件）：
		 *   · 每 3s 查一次 /status（fetch 失败 = 服务真空期，下轮自动再试）
		 *   · 首次成功响应 = 基线（页面加载时连接的进程 pid）
		 *   · 之后 pid 变化 → 页面存活期间进程重启过（wrapper 重启 / 手动完整重启 /
		 *     守护回滚 / 关闭后重新打开）→ 自动刷新一次
		 *   · 刷新后的新页面重新建立基线 → 不再刷新（防循环）
		 *   事件驱动（connection/reset）不可靠（插件 apply 可能晚于首次连接、
		 *   部分重启场景不触发），轮询覆盖一切且更简单。
		 */
		exports.name = "dsh-graceful-restart-client";
		exports.apply = function apply(ctx) {
			// 每次页面加载都发 ack（幂等；Host 未就绪时失败静默）
			try {
				fetch("/plugins/dsh-graceful-restart/ack", { method: "POST" }).catch(function () {});
			} catch (e) {}

			var loadedPid = null;
			var reloading = false;
			var POLL_MS = 3000;

			function poll() {
				window.setTimeout(function () {
					fetch("/plugins/dsh-graceful-restart/status", { method: "GET" })
						.then(function (res) { return res.json().catch(function () { return null; }); })
						.then(function (data) {
							if (data && data.pid != null) {
								var pid = String(data.pid);
								if (loadedPid === null) {
									loadedPid = pid; // 基线：页面加载时连接的进程
								} else if (pid !== loadedPid && !reloading) {
									reloading = true;
									window.location.reload();
									return;
								}
							}
						})
						.catch(function () { /* 网络失败（真空期/服务未起）→ 下轮再试 */ })
						.then(function () { poll(); });
				}, POLL_MS);
			}
			poll();
		};
		return module.exports;
	}
});
