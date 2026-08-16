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
		 *       - startedAt ≠ 持久化值（含缺失：首次部署/清过存储）→ 页面状态可能过时 →
		 *         先更新持久化值（防刷新循环）再刷新一次
		 *       - 相同 → 无动作（ws 抖动/重连，进程没变）
		 *   · 刷新后的新页面把当前 startedAt 写入 localStorage → 不再刷新（防循环）
		 */
		var LS_KEY = "dsh-graceful-restart.startedAt";
		var reloading = false;

		/* ------------------------------------------------------------------ */
		/* 设置菜单（settings.section：快照保留版本数 + 重启继续提示）           */
		/* ------------------------------------------------------------------ */

		var React = require("react");
		var jsx = React.createElement;

		var rowStyle = { display: "flex", flexDirection: "column", gap: 4, padding: "10px 0" };
		var labelStyle = { fontSize: 13, fontWeight: 600 };
		var descStyle = { fontSize: 12, opacity: 0.65 };
		var inputStyle = { width: 120, padding: "4px 8px", borderRadius: 6, border: "1px solid currentColor", background: "transparent", color: "inherit" };
		var buttonStyle = { padding: "6px 16px", borderRadius: 6, border: "1px solid currentColor", background: "transparent", color: "inherit", cursor: "pointer" };
		var thStyle = { textAlign: "left", padding: "6px 8px", borderBottom: "1px solid currentColor", opacity: 0.7, fontWeight: 600 };
		var tdStyle = { padding: "6px 8px", borderBottom: "1px solid rgba(128,128,128,0.25)", verticalAlign: "top" };

		function SettingsSection() {
			var s = React.useState({ value: null, revision: null, error: null, saved: false, saving: false, snap: null });
			var state = s[0];
			var setState = s[1];
			var autoSaveTimer = React.useRef(null);

			function loadSnapshot() {
				fetch("/plugins/dsh-graceful-restart/snapshot", { method: "GET" })
					.then(function (res) { return res.json().catch(function () { return null; }); })
					.then(function (data) {
						if (data && data.ok) setState(function (prev) { return { ...prev, snap: data }; });
					})
					.catch(function () {});
			}

			React.useEffect(function () {
				var alive = true;
				fetch("/plugins/dsh-graceful-restart/settings", { method: "GET" })
					.then(function (res) { return res.json().catch(function () { return null; }); })
					.then(function (data) {
						if (alive && data && data.ok) {
							setState({ value: data.value || {}, revision: data.revision, error: null, saved: false, saving: false, snap: null });
						}
					})
					.catch(function () {});
				loadSnapshot();
				var iv = setInterval(loadSnapshot, 3000); // 快照视图自动刷新
				return function () { alive = false; clearInterval(iv); };
			}, []);

			function patch(next) {
				setState(function (prev) { return { ...prev, value: { ...(prev.value || {}), ...next } }; });
			}

			// 自动保存（debounce 500ms，无保存按钮）
			function autoSave(next) {
				patch(next);
				setState(function (prev) { return { ...prev, saved: false, error: null }; });
				if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
				autoSaveTimer.current = setTimeout(function () {
					setState(function (prev) {
						var v = { ...(prev.value || {}), ...next };
						fetch("/plugins/dsh-graceful-restart/settings", {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({ patch: v, expectedRevision: prev.revision }),
						})
							.then(function (res) { return res.json().catch(function () { return null; }); })
							.then(function (data) {
								if (data && data.ok) {
									setState({ value: data.value, revision: data.revision, error: null, saved: true, saving: false, snap: null });
								} else {
									setState(function (p) { return { ...p, error: (data && data.error) || "保存失败", saving: false }; });
								}
							})
							.catch(function () { setState(function (p) { return { ...p, error: "网络错误", saving: false } }); });
						return { ...prev, value: v, saving: true, saved: false };
					});
				}, 500);
			}

			var value = state.value || {};
			var snap = state.snap || {};
			var fmtAt = function (iso) {
				try { return new Date(iso).toLocaleString("zh-CN", { hour12: false }); } catch (e) { return iso || ""; }
			};
			var histRows = [];
			var history = snap.history || [];
			for (var i = 0; i < history.length; i++) {
				var h = history[i];
				var changes = "";
				if (h.diff) {
					var parts = [];
					if (h.diff.added && h.diff.added.length) parts.push("新增 " + h.diff.added.join(", "));
					if (h.diff.removed && h.diff.removed.length) parts.push("移除 " + h.diff.removed.join(", "));
					if (h.diff.changed && h.diff.changed.length) parts.push("版本 " + h.diff.changed.join(", "));
					changes = parts.length ? parts.join("；") : "（无变化）";
				} else {
					changes = "（完整基线 " + Object.keys(h.deps || {}).length + " 包）";
				}
				histRows.push(jsx("tr", { key: "h" + i },
					jsx("td", { style: tdStyle }, i === 0 ? "当前" : "#" + i),
					jsx("td", { style: tdStyle }, fmtAt(h.at)),
					jsx("td", { style: tdStyle }, changes),
				));
			}

			return jsx("div", { style: { padding: 4 } }, [
				jsx("p", { style: descStyle }, "启动守护：进程启动失败时自动回滚（新增卸载 / 版本变化恢复基线版本）并重试；成功基线保留多个版本，逐级回溯。"),
				jsx("div", { style: rowStyle }, [
					jsx("label", { style: labelStyle }, "快照保留版本数（自动保存）"),
					jsx("input", {
						type: "number", min: 1, max: 10,
						style: inputStyle,
						value: value.snapshotKeep == null ? 3 : value.snapshotKeep,
						onChange: function (e) { autoSave({ snapshotKeep: Number(e.target.value) }); },
					}),
					jsx("span", { style: descStyle }, "成功基线保留 1-10 个版本（默认 3）；第 N 次回滚使用第 N 个旧基线。" + (state.saved ? " ✓ 已保存" : "") + (state.error ? " ✗ " + String(state.error) : "")),
				]),
				jsx("div", { style: rowStyle }, [
					jsx("label", { style: labelStyle }, "快照时间线（最新在前）"),
					jsx("table", { style: { width: "100%", borderCollapse: "collapse", fontSize: 12 } }, [
						jsx("thead", {},
							jsx("tr", {},
								jsx("th", { style: thStyle }, ""),
								jsx("th", { style: thStyle }, "时间"),
								jsx("th", { style: thStyle }, "变化"),
							),
						),
						jsx("tbody", {}, histRows),
					]),
				]),
				snap.lastError && jsx("div", { style: rowStyle }, [
					jsx("label", { style: labelStyle }, "最近一次错误"),
					jsx("div", { style: { fontSize: 12, color: "#c62828", whiteSpace: "pre-wrap" } },
						"· " + fmtAt(snap.lastError.at) + " " + snap.lastError.detail),
				]),
			]);
		}

		exports.name = "dsh-graceful-restart-client";
		exports.inject = ["slots"];
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

			// 查 /status：连接恢复瞬间插件端点可能尚未注册（404）或服务短暂不可用，
			// 带短窗口重试（10 次 × 500ms ≈ 5s，事件驱动，非轮询）
			function queryStatus(attemptsLeft) {
				return fetch("/plugins/dsh-graceful-restart/status", { method: "GET" })
					.then(function (res) { return res.json().catch(function () { return null; }); })
					.catch(function () {
						if (attemptsLeft <= 0) return null;
						return new Promise(function (resolve) {
							window.setTimeout(function () {
								queryStatus(attemptsLeft - 1).then(resolve);
							}, 500);
						});
					});
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
				queryStatus(10).then(function (data) {
					if (!data || data.startedAt == null) return;
					var startedAt = String(data.startedAt);
					var stored = readStored();
					if (stored !== startedAt) {
						// 持久化值缺失（首次部署/清过存储）或与当前不同（进程重启过）：
						// 都是"页面状态可能已过时"→ 先更新持久化值（防刷新循环）再刷新
						reloading = true;
						store(startedAt);
						window.location.reload();
					}
				});
			});

			// 设置菜单：注册到设置页（settings.section）
			try {
				ctx.slots.inject("settings.section", function () {
					return ctx.slots.register({
						name: "settings.section",
						id: "dsh-graceful-restart",
						order: 90,
						label: function () { return "优雅重启"; },
					}, SettingsSection);
				});
			} catch (e) { console.warn("[dsh-graceful-restart] settings section registration failed:", e); }
		};
		return module.exports;
	}
});
