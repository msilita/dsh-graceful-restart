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
			// 当前标记：current = 时间戳键值，直接匹配快照 at（唯一指针）
			var currentIdx = 0;
			if (snap.current) {
				for (var ci0 = 0; ci0 < history.length; ci0++) {
					if (history[ci0].at === snap.current) {
						currentIdx = ci0;
						break;
					}
				}
			}
			var nameOf = function (e) { return typeof e === "string" ? e : (e && e.name) || ""; };
			var verOf = function (e) { return (e && e.version !== undefined) ? e.version : ""; };
			for (var i = 0; i < history.length; i++) {
				var h = history[i];
				var rows = []; // 包管理格式：+ 包名@版本
				if (h.diff) {
					if (h.diff.added && h.diff.added.length) {
						for (var ai = 0; ai < h.diff.added.length; ai++) {
							var a = h.diff.added[ai];
							rows.push({ text: "+ " + nameOf(a) + (verOf(a) ? "@" + verOf(a) : ""), color: "#2e7d32" });
						}
					}
					if (h.diff.removed && h.diff.removed.length) {
						for (var ri = 0; ri < h.diff.removed.length; ri++) {
							var r = h.diff.removed[ri];
							rows.push({ text: "- " + nameOf(r) + (verOf(r) ? "@" + verOf(r) : ""), color: "#c62828" });
						}
					}
					if (h.diff.changed && h.diff.changed.length) {
						for (var ci = 0; ci < h.diff.changed.length; ci++) {
							var c = h.diff.changed[ci];
							// git 风格：- 旧版本（红）+ 新版本（绿），不用黄色 ~
							rows.push({ text: "- " + nameOf(c) + (c.from !== undefined ? "@" + c.from : ""), color: "#c62828" });
							rows.push({ text: "+ " + nameOf(c) + (c.to !== undefined ? "@" + c.to : ""), color: "#2e7d32" });
						}
					}
					if (rows.length === 0) rows.push({ text: "（无变化）", color: null });
				} else {
					rows.push({ text: "（完整基线）", color: null });
				}
				histRows.push(jsx("tr", { key: "h" + i },
					jsx("td", { style: { ...tdStyle, width: 150, whiteSpace: "nowrap" } }, [
						fmtAt(h.at),
						i === currentIdx && jsx("span", { style: { marginLeft: 6, padding: "1px 6px", borderRadius: 8, background: "#2e7d32", color: "#fff", fontSize: 10, fontWeight: 600 } }, "当前"),
					]),
					jsx("td", {
						style: h.error ? { ...tdStyle, backgroundColor: "rgba(198,40,40,0.12)" } : tdStyle,
					},
						rows.map(function (rw, ri2) {
							return jsx("div", { key: "r" + ri2, style: { fontFamily: "monospace", fontSize: 12, color: rw.color || "inherit", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, rw.text);
						}),
					),
				));
			}

			return jsx("div", { style: { padding: 4 } }, [
				jsx("p", { style: descStyle }, "启动守护：进程启动失败时自动回滚（新增卸载 / 版本变化恢复基线版本）并重试；成功基线保留多个版本，逐级回溯直到成功或历史耗尽。"),
				jsx("div", { style: rowStyle }, [
					jsx("label", { style: labelStyle }, "快照时间线（最新在前）"),
					jsx("table", { style: { width: "100%", borderCollapse: "collapse", fontSize: 12 } }, [
						jsx("thead", {},
							jsx("tr", {},
								jsx("th", { style: { ...thStyle, width: 150 } }, "时间"),
								jsx("th", { style: thStyle }, "变化"),
							),
						),
						jsx("tbody", {}, histRows),
					]),
					// 错误信息（独立记录，不在快照条目里）：黑底终端风格 + 复制按钮
					(() => {
						var errs = snap.errors || [];
						if (errs.length === 0) return null;
						var copyErr = function (e) {
							var text = (e.detail || "") + (e.stderr ? "\n\n" + e.stderr : "");
							if (navigator.clipboard && navigator.clipboard.writeText) {
								navigator.clipboard.writeText(text).then(function () {}, function () {});
							}
						};
						return jsx("div", { style: { marginTop: 8, padding: 8, borderRadius: 6, background: "#111", border: "1px solid #333" } },
							errs.map(function (e, ei) {
								return jsx("div", { key: "err" + ei, style: { fontSize: 12, color: "#e0e0e0", marginBottom: ei < errs.length - 1 ? 8 : 0 } }, [
									jsx("div", { style: { display: "flex", alignItems: "center", gap: 8, whiteSpace: "pre-wrap", wordBreak: "break-all" } }, [
										jsx("span", { style: { flex: 1 } }, "⚠ " + fmtAt(e.at) + " " + (e.detail || "")),
										jsx("button", {
											style: { padding: "2px 10px", borderRadius: 4, border: "1px solid #555", background: "transparent", color: "#ccc", fontSize: 11, cursor: "pointer" },
											onClick: function () { copyErr(e); },
										}, "复制"),
									]),
									e.stderr ? jsx("pre", { style: { margin: "4px 0 0", padding: "6px 8px", borderRadius: 4, background: "#000", color: "#c8c8c8", fontSize: 11, whiteSpace: "pre-wrap", wordBreak: "break-all", maxHeight: 320, overflowY: "auto" } }, e.stderr) : null,
								]);
							}),
						);
					})(),
				]),
				snap.wakeLog && snap.wakeLog.entries.length > 0 && jsx("div", { style: rowStyle }, [
					jsx("label", { style: labelStyle }, "最近唤醒记录（" + fmtAt(snap.wakeLog.startedAt) + " 起）"),
					jsx("div", { style: { fontSize: 12, whiteSpace: "pre-wrap" } },
						snap.wakeLog.entries.map(function (e, i) {
							return jsx("div", { key: "w" + i },
								"· " + fmtAt(e.at) + " " + e.detail);
						}),
					),
				]),
				snap.rollbackLog && snap.rollbackLog.entries.length > 0 && jsx("div", { style: rowStyle }, [
					jsx("label", { style: labelStyle }, "最近回滚过程（" + fmtAt(snap.rollbackLog.startedAt) + " 起）"),
					jsx("div", { style: { fontSize: 12, color: "#c62828", whiteSpace: "pre-wrap" } },
						snap.rollbackLog.entries.map(function (e, i) {
							return jsx("div", { key: "e" + i },
								"· " + fmtAt(e.at) + " " + e.detail);
						}),
					),
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
