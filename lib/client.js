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
		 * 机制（代际 ID = 进程启动时间 startedAt + 浏览器持久化对比，无轮询）：
		 *   · 每个 DSH 进程的 startedAt 即"代际 ID"（毫秒级唯一，比 pid 可靠）
		 *   · 页面加载时查一次 /status，把 startedAt 存入 localStorage（失败无妨，旧值仍在）
		 *   · 每次连接恢复（ws 重连成功，connection/reset）时查 /status：
		 *       - startedAt ≠ localStorage 持久化的值 → 进程重启过（wrapper 重启 / 手动
		 *         完整重启 / 守护回滚 / 关闭后重新打开）→ 先更新持久化值再刷新一次
		 *       - 相同 → 无动作（ws 抖动/重连，进程没变）
		 *   · 刷新后的新页面把当前 startedAt 写入 localStorage → 不再刷新（防循环）
		 */
		var LS_KEY = "dsh-graceful-restart.startedAt";
		var reloading = false;

		exports.name = "dsh-graceful-restart-client";
		exports.apply = function apply(ctx) {
			// 每次页面加载都发 ack（幂等；Host 未就绪时失败静默）
			try {
				fetch("/plugins/dsh-graceful-restart/ack", { method: "POST" }).catch(function () {});
			} catch (e) {}

			function readStored() {
				try { return localStorage.getItem(LS_KEY); } catch (e) { return null; }
			}
			function store(value) {
				try { localStorage.setItem(LS_KEY, value); } catch (e) {}
			}

			// 页面加载：更新持久化基线（失败无妨——旧值保留，重连对比依然有效）
			fetch("/plugins/dsh-graceful-restart/status", { method: "GET" })
				.then(function (res) { return res.json().catch(function () { return null; }); })
				.then(function (data) {
					if (data && data.startedAt != null) store(String(data.startedAt));
				})
				.catch(function () {});

			// 连接恢复（重连成功）：查一次 startedAt，与持久化值对比
			ctx.on("connection/reset", function () {
				if (reloading) return;
				fetch("/plugins/dsh-graceful-restart/status", { method: "GET" })
					.then(function (res) { return res.json().catch(function () { return null; }); })
					.then(function (data) {
						if (!data || data.startedAt == null) return;
						var startedAt = String(data.startedAt);
						var stored = readStored();
						if (stored !== null && stored !== startedAt) {
							// 页面存活期间进程重启过 → 先更新持久化值（防刷新循环）再刷新
							reloading = true;
							store(startedAt);
							window.location.reload();
						} else if (stored === null) {
							store(startedAt);
						}
					})
					.catch(function () {});
			});
		};
		return module.exports;
	}
});
