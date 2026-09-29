/* 灌溉水质连续监测 —— 原生 JS */
(() => {
  "use strict";

  const STATUS_TEXT = { normal: "正常", observing: "观察", exceeded: "超标" };
  const METRIC_ORDER = ["ph", "ec", "turbidity", "nitrate"];

  let state = null;
  const filter = { source_id: null, date: "" };

  const $ = (sel, root = document) => root.querySelector(sel);

  // ------------------------------------------------------------ 工具

  function toast(msg, isError = false) {
    const el = $("#toast");
    el.textContent = msg;
    el.className = "toast show" + (isError ? " error" : "");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (el.className = "toast"), 2800);
  }

  async function api(path, options = {}) {
    const opts = { headers: {}, ...options };
    if (opts.body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(opts.body);
    }
    const res = await fetch(path, opts);
    let data = null;
    try { data = await res.json(); } catch (e) { /* 非 JSON */ }
    if (!res.ok) throw new Error((data && data.error) || `请求失败 (${res.status})`);
    return data;
  }

  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function nowLocalInput() {
    const d = new Date();
    d.setSeconds(0, 0);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function fmtTs(ts) { return String(ts).replace("T", " "); }
  function fmtNum(v) { return (Math.round(v * 100) / 100).toString(); }

  function metricMeta(key) {
    return state.metrics.find((m) => m.key === key);
  }

  // ------------------------------------------------------------ 加载

  function stateUrl(extra = {}) {
    const p = new URLSearchParams();
    const sid = extra.source_id ?? filter.source_id ?? state?.selected_id;
    if (sid) p.set("source_id", sid);
    const day = extra.date !== undefined ? extra.date : filter.date;
    if (day) p.set("date", day);
    else p.set("limit", extra.limit ?? 50);
    return "/api/water/state?" + p.toString();
  }

  async function load() {
    state = await api(stateUrl());
    if (state.selected_id) filter.source_id = state.selected_id;
    renderAll();
  }

  function renderAll() {
    renderSources();
    renderSummary();
    renderFilterBar();
    renderRanges();
    renderCharts();
    renderTable();
    syncMetaForm();
  }

  // ------------------------------------------------------------ 水源列表 / 总览

  function renderSources() {
    const ul = $("#source-list");
    ul.innerHTML = "";
    if (!state.sources.length) {
      ul.innerHTML = `<li class="entity-row" style="color:var(--ink-soft)">暂无水源，请先添加</li>`;
      return;
    }
    state.sources.forEach((s) => {
      const li = document.createElement("li");
      li.className = "entity-row source-item" +
        (s.id === state.selected_id ? " selected" : "");
      li.innerHTML =
        `<span class="grow">
           <span class="name"><i class="dot ${s.status}"></i>${escapeHtml(s.name)}</span>
           <div class="meta"><span class="badge ${s.status}">${STATUS_TEXT[s.status]}</span>
             ${s.triggers.length ? "· " + escapeHtml(s.triggers.join("、")) : ""}</div>
           <div class="meta">${s.sample_count} 条采样${s.last_ts ? " · " + fmtTs(s.last_ts) : ""}</div>
         </span>`;
      li.addEventListener("click", () => selectSource(s.id));
      ul.appendChild(li);
    });
  }

  function renderSummary() {
    const box = $("#overall-box");
    const badge = $("#overall-badge");
    badge.className = "overall-badge " + state.overall_status;
    badge.textContent = state.sources.length ? STATUS_TEXT[state.overall_status] : "—";
    box.title = "所有水源当前状态取最差者";

    const ul = $("#source-summary");
    ul.innerHTML = "";
    state.sources.forEach((s) => {
      const li = document.createElement("li");
      li.style.cursor = "pointer";
      li.innerHTML =
        `<span class="dot ${s.status}"></span>
         <span class="src-name">${escapeHtml(s.name)}</span>
         <span class="badge ${s.status}">${STATUS_TEXT[s.status]}</span>
         <span class="src-meta">${s.triggers.length ? escapeHtml(s.triggers.join("、")) : "全部指标在区间内"}
           · ${s.sample_count} 条</span>`;
      li.addEventListener("click", () => selectSource(s.id));
      ul.appendChild(li);
    });
  }

  function renderFilterBar() {
    const sel = $("#filter-source");
    sel.innerHTML = state.sources.length
      ? state.sources.map((s) =>
          `<option value="${s.id}"${s.id === state.selected_id ? " selected" : ""}>` +
          `${escapeHtml(s.name)}（${STATUS_TEXT[s.status]}）</option>`).join("")
      : `<option value="">（无水源）</option>`;
    $("#filter-date").value = state.date || "";
  }

  function syncMetaForm() {
    const form = $("#source-meta-form");
    const s = state.sources.find((x) => x.id === state.selected_id);
    form.elements.id.value = s ? s.id : "";
    form.elements.note.value = s ? (s.note || "") : "";
    $("#btn-source-delete").disabled = !s;
    $("#sample-form").style.opacity = s ? "1" : ".55";
    $("#range-form").style.opacity = s ? "1" : ".55";
  }

  async function selectSource(id) {
    filter.source_id = id;
    filter.date = "";
    try { await load(); } catch (e) { toast(e.message, true); }
  }

  // ------------------------------------------------------------ 区间表单

  function renderRanges() {
    const form = $("#range-form");
    METRIC_ORDER.forEach((k) => {
      const r = state.ranges[k];
      form.elements[`${k}_low`].value = r.low;
      form.elements[`${k}_high`].value = r.high;
    });
    const s = state.sources.find((x) => x.id === state.selected_id);
    $("#range-source-name").textContent = s ? `· ${s.name}` : "";
  }

  // ------------------------------------------------------------ 趋势图（内联 SVG）

  function renderCharts() {
    const wrap = $("#charts");
    const subtitle = $("#trend-subtitle");
    wrap.innerHTML = "";
    const samples = state.samples;
    if (!state.selected_id) {
      subtitle.textContent = "";
      wrap.innerHTML = `<div class="chart-empty">请先在左侧添加并选择水源</div>`;
      return;
    }
    if (!samples.length) {
      subtitle.textContent = "";
      wrap.innerHTML = `<div class="chart-empty">该水源${filter.date ? "在所选日期" : ""}暂无采样记录</div>`;
      return;
    }
    subtitle.textContent =
      (filter.date ? `${filter.date} · ` : `最近 ${samples.length} 条 · `) +
      "灰色色带为正常区间，点色为该指标当时状态（绿=正常 / 橙=观察 / 红=超标）";

    const W = 340, H = 110, PAD_L = 34, PAD_R = 10, PAD_T = 12, PAD_B = 18;
    const n = samples.length;
    const xAt = (i) => PAD_L + (n === 1 ? (W - PAD_L - PAD_R) / 2 :
      i * (W - PAD_L - PAD_R) / (n - 1));

    METRIC_ORDER.forEach((key) => {
      const meta = metricMeta(key);
      const vals = samples.map((s) => s[key]);
      let lo = Math.min(...vals, meta.low);
      let hi = Math.max(...vals, meta.high);
      if (lo === hi) { lo -= 1; hi += 1; }
      const pad = (hi - lo) * 0.12;
      lo -= pad; hi += pad;
      const yAt = (v) => PAD_T + (hi - v) * (H - PAD_T - PAD_B) / (hi - lo);

      const svgNS = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(svgNS, "svg");
      svg.setAttribute("viewBox", `0 0 ${W} ${H}`);

      // 正常区间色带
      const band = document.createElementNS(svgNS, "rect");
      band.setAttribute("class", "range-band");
      band.setAttribute("x", PAD_L);
      band.setAttribute("width", W - PAD_L - PAD_R);
      band.setAttribute("y", yAt(meta.high));
      band.setAttribute("height", Math.max(0, yAt(meta.low) - yAt(meta.high)));
      svg.appendChild(band);

      // 折线
      const pts = samples.map((s, i) => `${xAt(i)},${yAt(s[key])}`).join(" ");
      const line = document.createElementNS(svgNS, "polyline");
      line.setAttribute("class", "trend-line");
      line.setAttribute("points", pts);
      svg.appendChild(line);

      // 数据点（按该指标当时状态着色）
      samples.forEach((s, i) => {
        const c = document.createElementNS(svgNS, "circle");
        c.setAttribute("class", "trend-pt pt-" + s.metric_states[key]);
        c.setAttribute("cx", xAt(i));
        c.setAttribute("cy", yAt(s[key]));
        c.setAttribute("r", n > 30 ? 2.4 : 3.4);
        c.appendChild(document.createElementNS(svgNS, "title")).textContent =
          `${fmtTs(s.ts)}\n${meta.label}：${fmtNum(s[key])} ${meta.unit}\n` +
          `状态：${STATUS_TEXT[s.metric_states[key]]}`;
        svg.appendChild(c);
      });

      // 坐标标注：区间上下限 + 首末时间
      [
        { v: meta.high, y: yAt(meta.high) },
        { v: meta.low, y: yAt(meta.low) },
      ].forEach(({ v, y }) => {
        const t = document.createElementNS(svgNS, "text");
        t.setAttribute("class", "chart-axis");
        t.setAttribute("x", 3);
        t.setAttribute("y", Math.min(H - 4, Math.max(9, y + 3)));
        t.textContent = fmtNum(v);
        svg.appendChild(t);
      });
      const t0 = document.createElementNS(svgNS, "text");
      t0.setAttribute("class", "chart-axis");
      t0.setAttribute("x", PAD_L);
      t0.setAttribute("y", H - 5);
      t0.textContent = samples[0]["ts"].slice(5, 16).replace("T", " ");
      svg.appendChild(t0);
      const t1 = document.createElementNS(svgNS, "text");
      t1.setAttribute("class", "chart-axis");
      t1.setAttribute("x", W - PAD_R);
      t1.setAttribute("y", H - 5);
      t1.setAttribute("text-anchor", "end");
      t1.textContent = samples[n - 1]["ts"].slice(5, 16).replace("T", " ");
      svg.appendChild(t1);

      const box = document.createElement("div");
      box.className = "chart-box";
      const h3 = document.createElement("h3");
      h3.innerHTML = `<span>${escapeHtml(meta.label)}</span>` +
        `<small>区间 ${fmtNum(meta.low)} ~ ${fmtNum(meta.high)} ${escapeHtml(meta.unit)}</small>`;
      box.append(h3, svg);
      wrap.appendChild(box);
    });
  }

  // ------------------------------------------------------------ 明细表

  function renderTable() {
    const tbody = $("#sample-rows");
    const subtitle = $("#detail-subtitle");
    tbody.innerHTML = "";
    const samples = [...state.samples].reverse(); // 最新在前
    subtitle.textContent = state.selected_id
      ? `共 ${samples.length} 条${filter.date ? "（" + filter.date + "）" : "（最近 50 条）"}`
      : "";
    if (!samples.length) {
      tbody.innerHTML = `<tr class="empty-row"><td colspan="8">暂无采样记录</td></tr>`;
      return;
    }
    samples.forEach((s) => {
      const tr = document.createElement("tr");
      const cells = METRIC_ORDER.map((k) => {
        const meta = metricMeta(k);
        const out = s[k] < meta.low || s[k] > meta.high;
        return `<td class="${out ? "violation" : ""}">${fmtNum(s[k])}</td>`;
      }).join("");
      tr.innerHTML =
        `<td>${fmtTs(s.ts)}</td>
         <td><span class="badge ${s.status}">${STATUS_TEXT[s.status]}</span></td>
         <td class="triggers">${s.triggers.length ? escapeHtml(s.triggers.join("、")) : "—"}</td>
         ${cells}
         <td><button class="del-btn" title="删除该采样（删除后重算状态）">🗑</button></td>`;
      tr.querySelector(".del-btn").addEventListener("click", () => removeSample(s));
      tbody.appendChild(tr);
    });
  }

  async function removeSample(s) {
    if (!confirm(`删除 ${fmtTs(s.ts)} 的采样？删除后将按时间重算该水源状态。`)) return;
    try {
      await api(`/api/water/samples/${s.id}`, { method: "DELETE" });
      await load();
      toast("采样已删除，状态已重算");
    } catch (e) { toast(e.message, true); }
  }

  // ------------------------------------------------------------ 表单

  function bindForms() {
    $("#source-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = e.target;
      try {
        const created = await api("/api/water/sources", {
          method: "POST",
          body: { name: f.elements.name.value.trim() },
        });
        f.reset();
        filter.source_id = created.selected_id;
        filter.date = "";
        await load();
        toast("水源已添加，区间为默认值，可在下方调整");
      } catch (err) { toast(err.message, true); }
    });

    $("#source-meta-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = e.target;
      const id = f.elements.id.value;
      if (!id) return;
      const cur = state.sources.find((x) => x.id === Number(id));
      try {
        await api(`/api/water/sources/${id}`, {
          method: "PUT",
          body: { name: cur.name, note: f.elements.note.value.trim() },
        });
        await load();
        toast("备注已保存");
      } catch (err) { toast(err.message, true); }
    });

    $("#btn-source-delete").addEventListener("click", async () => {
      const s = state.sources.find((x) => x.id === state.selected_id);
      if (!s) return;
      if (!confirm(`删除水源「${s.name}」？其全部采样与区间配置将一并删除。`)) return;
      try {
        await api(`/api/water/sources/${s.id}`, { method: "DELETE" });
        filter.source_id = null;
        await load();
        toast("水源已删除");
      } catch (err) { toast(err.message, true); }
    });

    $("#sample-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!state.selected_id) { toast("请先选择水源", true); return; }
      const f = e.target;
      const body = {
        ts: f.elements.ts.value,
        ph: Number(f.elements.ph.value),
        ec: Number(f.elements.ec.value),
        turbidity: Number(f.elements.turbidity.value),
        nitrate: Number(f.elements.nitrate.value),
      };
      try {
        await api(`/api/water/sources/${state.selected_id}/samples`, {
          method: "POST", body,
        });
        f.reset();
        f.elements.ts.value = nowLocalInput();
        await load();
        const s = state.sources[state.sources.length - 1];
        toast(s ? `采样已提交，当前状态：${STATUS_TEXT[s.status]}` : "采样已提交");
      } catch (err) { toast(err.message, true); }
    });

    $("#btn-now").addEventListener("click", () => {
      $("#sample-form").elements.ts.value = nowLocalInput();
    });

    $("#range-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!state.selected_id) return;
      const f = e.target;
      const ranges = {};
      METRIC_ORDER.forEach((k) => {
        ranges[k] = [Number(f.elements[`${k}_low`].value),
                     Number(f.elements[`${k}_high`].value)];
      });
      try {
        await api(`/api/water/sources/${state.selected_id}/ranges`, {
          method: "PUT", body: { ranges },
        });
        await load();
        toast("区间已保存，全部历史采样状态已重算");
      } catch (err) { toast(err.message, true); }
    });
  }

  // ------------------------------------------------------------ 筛选 / 导出

  function bindFilters() {
    $("#btn-filter-apply").addEventListener("click", async () => {
      if (!state.selected_id) { toast("请先选择水源", true); return; }
      filter.source_id = Number($("#filter-source").value);
      filter.date = $("#filter-date").value;
      try { await load(); } catch (e) { toast(e.message, true); }
    });
    $("#filter-source").addEventListener("change", () => {
      filter.source_id = Number($("#filter-source").value) || null;
      filter.date = "";
      load().catch((e) => toast(e.message, true));
    });
    $("#btn-filter-clear").addEventListener("click", () => {
      filter.date = "";
      load().catch((e) => toast(e.message, true));
    });
    $("#btn-export").addEventListener("click", () => {
      const p = new URLSearchParams();
      if (state.selected_id) p.set("source_id", state.selected_id);
      if (filter.date) p.set("date", filter.date);
      window.location.href = "/api/water/export?" + p.toString();
    });
  }

  // ------------------------------------------------------------ 启动

  $("#sample-form").elements.ts.value = nowLocalInput();
  bindForms();
  bindFilters();
  load().catch((e) => toast(e.message, true));
})();
