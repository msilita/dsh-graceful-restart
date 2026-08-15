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
		 *      从失败转为成功 = 新 DSH 已就绪）→ 自动 location.reload() 一次，
		 *      并用 sessionStorage 标记防止刷新循环。
		 *   2. 页面加载（含刷新后）时 POST /plugins/dsh-graceful-restart/ack，
		 *      通知 Host（Host 再经 IPC 通知执行器退出）。
		 */
		exports.name = "dsh-lifecycle-client";
		exports.apply = function apply(ctx) {
			// 1) 每次页面加载都发 ack（幂等；Host 未就绪时失败静默）
			try {
				fetch("/plugins/dsh-graceful-restart/ack", { method: "POST" }).catch(function () {});
			} catch (e) {}

			// 2) 重启后的自动刷新：检测"断开 → 恢复"一次
			//    sessionStorage 标记：本次会话已经完成过一次自动刷新，避免循环
			var KEY = "dsh-graceful-restart-auto-reloaded";
			var alreadyReloaded = false;
			try { alreadyReloaded = window.sessionStorage.getItem(KEY) === "1"; } catch (e) {}
			if (alreadyReloaded) {
				// 这是自动刷新后的页面：清除标记，恢复正常（不再自动刷新）
				try { window.sessionStorage.removeItem(KEY); } catch (e) {}
				return;
			}

			var wasDown = false;
			var timer = window.setInterval(function () {
				try {
					fetch("/plugins/dsh-graceful-restart/status", { method: "GET" }).then(function (res) {
						if (res.ok) {
							if (wasDown) {
								// 连接恢复（重启完成）：刷新一次
								try { window.sessionStorage.setItem(KEY, "1"); } catch (e) {}
								window.clearInterval(timer);
								window.location.reload();
							}
							wasDown = false;
						} else {
							wasDown = true;
						}
					}).catch(function () {
						// 后端不可达（重启中）
						wasDown = true;
					});
				} catch (e) {
					wasDown = true;
				}
			}, 2000);
			// 生命周期：client 插件卸载时清理定时器
			ctx.effect(function () {
				return function () { window.clearInterval(timer); };
			});
		};
		return module.exports;
	}
});
