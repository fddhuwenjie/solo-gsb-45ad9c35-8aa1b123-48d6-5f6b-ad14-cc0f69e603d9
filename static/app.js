/* 温室分区轮灌编排台 —— 原生 JS */
(() => {
  "use strict";

  const SLOT_MIN = 15;
  const SLOTS = 96;

  let state = null;
  let selectedZoneId = null;
  let editingValveId = null;
  let editingBlackoutId = null;

  const $ = (sel, root = document) => root.querySelector(sel);

  // ------------------------------------------------------------ 工具

  function toast(msg, isError = false) {
    const el = $("#toast");
    el.textContent = msg;
    el.className = "toast show" + (isError ? " error" : "");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (el.className = "toast"), 2600);
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

  function hhmm(slot) {
    slot = Math.max(0, Math.min(SLOTS, Math.round(slot)));
    const h = Math.floor(slot / 4);
    const m = (slot % 4) * 15;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }

  function toSlot(t) {
    if (!t) return null;
    const [h, m] = t.split(":").map(Number);
    return h * 4 + m / 15;
  }

  function slotsForWater(waterL, flowLmin) {
    return Math.max(1, Math.ceil(waterL / (flowLmin * SLOT_MIN)));
  }

  // ------------------------------------------------------------ 加载 / 总渲染

  async function refresh() {
    state = await api("/api/state");
    renderSettings();
    renderValves();
    renderZones();
    renderBlackouts();
    renderTimeline();
    renderIssues();
    syncZoneForm();
  }

  // ------------------------------------------------------------ 设置

  function renderSettings() {
    $("#plan-date").value = state.settings.plan_date || "";
    $("#total-flow").value = state.settings.total_flow;
  }

  async function saveSettings(patch) {
    try {
      state = await api("/api/settings", { method: "POST", body: patch });
      renderSettings();
      renderTimeline();
      renderIssues();
    } catch (e) { toast(e.message, true); }
  }

  // ------------------------------------------------------------ 阀门

  const valveColorIndex = (vid) => {
    const i = state.valves.findIndex((v) => v.id === vid);
    return i < 0 ? "other" : i;
  };

  function renderValves() {
    const ul = $("#valve-list");
    ul.innerHTML = "";
    state.valves.forEach((v) => {
      const li = document.createElement("li");
      if (editingValveId === v.id) {
        li.appendChild(buildValveEditor(v));
      } else {
        li.className = "entity-row";
        li.innerHTML =
          `<span class="grow"><span class="name"><i class="swatch valve-${valveColorIndex(v.id)}"></i>${escapeHtml(v.name)}</span>
             <div class="meta">${v.flow_lmin} L/min · 并发上限 ${v.concur}</div></span>`;
        const edit = iconButton("✏️", "编辑", () => { editingValveId = v.id; renderValves(); });
        const del = iconButton("🗑", "删除", () => removeValve(v), true);
        li.append(edit, del);
      }
      ul.appendChild(li);
    });

    const sel = $("#zone-form select[name=valve_id]");
    sel.innerHTML = state.valves.length
      ? state.valves.map((v) => `<option value="${v.id}">${escapeHtml(v.name)}（${v.flow_lmin} L/min）</option>`).join("")
      : `<option value="">（请先添加阀门）</option>`;
  }

  function buildValveEditor(v) {
    const wrap = document.createElement("div");
    wrap.className = "inline-form";
    wrap.style.gridTemplateColumns = "1fr 64px 52px auto auto";
    wrap.innerHTML =
      `<input data-k="name" value="${escapeAttr(v.name)}">
       <input data-k="flow_lmin" type="number" min="0.1" step="0.1" value="${v.flow_lmin}">
       <input data-k="concur" type="number" min="1" step="1" value="${v.concur}">`;
    const saveBtn = btn("保存", async () => {
      const body = readEditor(wrap, ["name", "flow_lmin", "concur"]);
      body.flow_lmin = Number(body.flow_lmin);
      body.concur = Number(body.concur);
      try {
        state = await api(`/api/valves/${v.id}`, { method: "PUT", body });
        editingValveId = null;
        toast("阀门已更新，计划已重新校验");
        renderValves(); renderZones(); renderTimeline(); renderIssues();
      } catch (e) { toast(e.message, true); }
    }, true);
    const cancelBtn = btn("取消", () => { editingValveId = null; renderValves(); });
    wrap.append(saveBtn, cancelBtn);
    return wrap;
  }

  async function removeValve(v) {
    if (!confirm(`确定删除阀门「${v.name}」？`)) return;
    try {
      state = await api(`/api/valves/${v.id}`, { method: "DELETE" });
      toast("阀门已删除");
      renderValves(); renderZones(); renderTimeline(); renderIssues(); syncZoneForm();
    } catch (e) { toast(e.message, true); }
  }

  // ------------------------------------------------------------ 分区

  function renderZones() {
    const ul = $("#zone-list");
    ul.innerHTML = "";
    const valveOrder = new Map(state.valves.map((v, i) => [v.id, i]));
    const sorted = [...state.zones].sort((a, b) =>
      (valveOrder.get(a.valve_id) ?? 99) - (valveOrder.get(b.valve_id) ?? 99) || a.id - b.id);

    sorted.forEach((z) => {
      const item = state.items.find((it) => it.zone_id === z.id);
      const issue = state.evaluation.issues.find((i) => i.zone_id === z.id);
      const unsched = state.evaluation.unscheduled.find((u) => u.zone_id === z.id);
      const li = document.createElement("li");
      li.className = "entity-row clickable" + (z.id === selectedZoneId ? " selected" : "");
      const when = item
        ? `${hhmm(item.start_slot)}–${hhmm(item.start_slot + item.length)}`
        : "未编排";
      const mark = issue || unsched ? ` <span title="${escapeAttr((issue ? issue.reasons : unsched.reasons).join("；"))}">🔴</span>` : "";
      li.innerHTML =
        `<span class="grow"><span class="name"><i class="swatch valve-${valveColorIndex(z.valve_id)}"></i>${escapeHtml(z.name)}${mark}</span>
           <div class="meta">${z.water_l} L · ${escapeHtml(z.valve_name)} · ${z.earliest}–${z.latest}</div>
           <div class="meta">计划：${when}</div></span>`;
      li.addEventListener("click", () => selectZone(z.id));
      const del = iconButton("🗑", "删除分区", async (e) => {
        e.stopPropagation();
        if (!confirm(`确定删除分区「${z.name}」及其计划？`)) return;
        try {
          state = await api(`/api/zones/${z.id}`, { method: "DELETE" });
          if (selectedZoneId === z.id) { selectedZoneId = null; resetZoneForm(); }
          toast("分区已删除");
          renderAllFromState();
        } catch (err) { toast(err.message, true); }
      }, true);
      li.appendChild(del);
      ul.appendChild(li);
    });
  }

  function selectZone(id) {
    selectedZoneId = id;
    renderZones();
    syncZoneForm();
    const block = $(`.block[data-zone-id="${id}"]`);
    if (block) block.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function resetZoneForm() {
    const form = $("#zone-form");
    form.reset();
    form.elements.id.value = "";
    $("#zone-submit").textContent = "添加分区";
    $("#item-start-label").classList.add("hidden");
  }

  function syncZoneForm() {
    const form = $("#zone-form");
    const z = selectedZoneId ? state.zones.find((x) => x.id === selectedZoneId) : null;
    if (!z) { resetZoneForm(); return; }
    form.elements.id.value = z.id;
    form.elements.name.value = z.name;
    form.elements.water_l.value = z.water_l;
    form.elements.valve_id.value = z.valve_id ?? "";
    form.elements.earliest.value = z.earliest;
    form.elements.latest.value = z.latest;
    $("#zone-submit").textContent = "保存分区修改";
    const item = state.items.find((it) => it.zone_id === z.id);
    const row = $("#item-start-label");
    row.classList.remove("hidden");
    form.elements.item_start.value = item ? hhmm(item.start_slot) : "";
  }

  // ------------------------------------------------------------ 停水时段

  function renderBlackouts() {
    const ul = $("#blackout-list");
    ul.innerHTML = "";
    state.blackouts.forEach((b) => {
      const li = document.createElement("li");
      if (editingBlackoutId === b.id) {
        li.appendChild(buildBlackoutEditor(b));
      } else {
        li.className = "entity-row";
        li.innerHTML =
          `<span class="grow"><span class="name">${escapeHtml(b.name)}</span>
             <div class="meta">${b.start} – ${b.end}</div></span>`;
        li.append(
          iconButton("✏️", "编辑", () => { editingBlackoutId = b.id; renderBlackouts(); }),
          iconButton("🗑", "删除", async () => {
            if (!confirm(`删除停水时段「${b.name}」？`)) return;
            try {
              state = await api(`/api/blackouts/${b.id}`, { method: "DELETE" });
              toast("停水时段已删除，计划已重新校验");
              renderAllFromState();
            } catch (e) { toast(e.message, true); }
          }, true));
      }
      ul.appendChild(li);
    });
  }

  function buildBlackoutEditor(b) {
    const wrap = document.createElement("div");
    wrap.className = "inline-form";
    wrap.style.gridTemplateColumns = "1fr 70px 70px auto auto";
    wrap.innerHTML =
      `<input data-k="name" value="${escapeAttr(b.name)}">
       <input data-k="start" type="time" step="900" value="${b.start}">
       <input data-k="end" type="time" step="900" value="${b.end}">`;
    wrap.append(
      btn("保存", async () => {
        const body = readEditor(wrap, ["name", "start", "end"]);
        try {
          state = await api(`/api/blackouts/${b.id}`, { method: "PUT", body });
          editingBlackoutId = null;
          toast("停水时段已更新，计划已重新校验");
          renderAllFromState();
        } catch (e) { toast(e.message, true); }
      }, true),
      btn("取消", () => { editingBlackoutId = null; renderBlackouts(); }));
    return wrap;
  }

  // ------------------------------------------------------------ 时间轴

  function renderTimeline() {
    renderRuler();
    const tracks = $("#tracks");
    tracks.innerHTML = "";
    tracks.appendChild(buildBlackoutTrack());

    const valveOrder = new Map(state.valves.map((v, i) => [v.id, i]));
    const sorted = [...state.zones].sort((a, b) =>
      (valveOrder.get(a.valve_id) ?? 99) - (valveOrder.get(b.valve_id) ?? 99) || a.id - b.id);

    if (!sorted.length) {
      const empty = document.createElement("div");
      empty.className = "track";
      empty.innerHTML = `<span class="unscheduled-row" style="cursor:default">暂无分区，请在左侧录入（或点击「恢复示例」）</span>`;
      tracks.appendChild(empty);
      return;
    }

    sorted.forEach((z) => tracks.appendChild(buildZoneTrack(z)));
  }

  function renderRuler() {
    const ruler = $("#ruler-track");
    ruler.innerHTML = "";
    for (let s = 0; s < SLOTS; s++) {
      if (s % 4 !== 0) continue;
      const tick = document.createElement("div");
      tick.className = "tick major";
      tick.style.left = pct(s);
      const label = document.createElement("span");
      label.className = "tick-label";
      label.textContent = hhmm(s);
      tick.appendChild(label);
      ruler.appendChild(tick);
    }
  }

  function buildBlackoutTrack() {
    const row = document.createElement("div");
    row.className = "track";
    row.style.height = "20px";
    row.style.setProperty("--track-h", "20px");
    const label = document.createElement("span");
    label.className = "label-absolute";
    label.textContent = "停水";
    row.appendChild(label);
    state.blackouts.forEach((b) => {
      const band = document.createElement("div");
      band.className = "blackout-band";
      setSlotRange(band, b.start_slot, b.end_slot);
      band.innerHTML = `<span class="bo-label">${escapeHtml(b.name)}</span>`;
      band.title = `${b.name} ${b.start}–${b.end}`;
      row.appendChild(band);
    });
    return row;
  }

  function buildZoneTrack(z) {
    const track = document.createElement("div");
    track.className = "track";
    const issue = state.evaluation.issues.find((i) => i.zone_id === z.id);
    const unsched = state.evaluation.unscheduled.find((u) => u.zone_id === z.id);
    if (issue || unsched) track.classList.add("has-conflict");

    const label = document.createElement("span");
    label.className = "label-absolute";
    label.textContent = z.name;
    label.title = `${z.name}（${z.valve_name}）`;
    track.appendChild(label);

    // 允许灌溉时段
    const win = document.createElement("div");
    win.className = "window-band";
    setSlotRange(win, z.earliest_slot, z.latest_slot);
    win.title = `允许时段 ${z.earliest}–${z.latest}`;
    track.appendChild(win);

    // 停水覆盖
    state.blackouts.forEach((b) => {
      const s = Math.max(b.start_slot, 0);
      const e = Math.min(b.end_slot, SLOTS);
      if (e > s) {
        const band = document.createElement("div");
        band.className = "blackout-band";
        setSlotRange(band, s, e);
        track.appendChild(band);
      }
    });

    const item = state.items.find((it) => it.zone_id === z.id);
    if (item) {
      track.appendChild(buildBlock(z, item, issue));
    } else {
      const note = document.createElement("div");
      note.className = "unscheduled-row";
      note.textContent = `⛔ 未编排 —— ${(unsched ? unsched.reasons : ["尚未安排"]).join("；")}`;
      note.title = note.textContent;
      note.addEventListener("click", () => selectZone(z.id));
      track.appendChild(note);
    }
    return track;
  }

  function buildBlock(z, item, issue) {
    const block = document.createElement("div");
    const colorIdx = valveColorIndex(z.valve_id);
    block.className = `block valve-${colorIdx}` + (issue ? " conflict" : "") +
      (z.id === selectedZoneId ? " selected" : "");
    block.dataset.zoneId = z.id;
    setSlotRange(block, item.start_slot, item.start_slot + item.length);
    block.innerHTML =
      `<div class="b-name">${escapeHtml(z.name)}</div><div class="b-time">${hhmm(item.start_slot)}–${hhmm(item.start_slot + item.length)}</div>`;
    const reasons = issue ? "\n冲突：" + issue.reasons.join("；") : "";
    block.title = `${z.name}（${z.valve_name} ${z.flow_lmin} L/min）\n` +
      `${hhmm(item.start_slot)}–${hhmm(item.start_slot + item.length)}，` +
      `${item.length * SLOT_MIN} 分钟，需水 ${z.water_l} L${reasons}`;
    block.addEventListener("click", () => selectZone(z.id));
    enableDrag(block, z, item);
    return block;
  }

  // ------------------------------------------------------------ 拖拽

  function enableDrag(block, zone, item) {
    let startX = 0, originSlot = 0, moved = false, ghost = null, track = null, colW = 0;

    block.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      track = block.parentElement;
      const rect = track.getBoundingClientRect();
      colW = rect.width / SLOTS;
      startX = ev.clientX;
      originSlot = item.start_slot;
      moved = false;
      block.setPointerCapture(ev.pointerId);

      const onMove = (e) => {
        const dx = e.clientX - startX;
        if (!moved && Math.abs(dx) < 5) return;
        if (!moved) {
          moved = true;
          block.classList.add("dragging");
          ghost = document.createElement("div");
          ghost.className = "ghost-hint";
          ghost.style.width = (item.length * colW) + "px";
          track.appendChild(ghost);
        }
        let slot = Math.round(originSlot + dx / colW);
        slot = Math.max(0, Math.min(SLOTS - item.length, slot));
        ghost.style.left = (slot * colW) + "px";
        ghost.innerHTML = `<span class="tip">${hhmm(slot)}–${hhmm(slot + item.length)}</span>`;
      };

      const onUp = async (e) => {
        block.removeEventListener("pointermove", onMove);
        block.removeEventListener("pointerup", onUp);
        block.classList.remove("dragging");
        if (ghost) ghost.remove();
        if (!moved) return; // 视为点击
        const dx = e.clientX - startX;
        let slot = Math.max(0, Math.min(SLOTS - item.length,
          Math.round(originSlot + dx / colW)));
        if (slot === originSlot) return;
        await moveItem(zone.id, slot);
      };

      block.addEventListener("pointermove", onMove);
      block.addEventListener("pointerup", onUp);
    });
  }

  async function moveItem(zoneId, newStart) {
    const items = state.items.map((it) =>
      it.zone_id === zoneId ? { ...it, start_slot: newStart } : it);
    try {
      state = await api("/api/schedule", { method: "PUT", body: { items } });
      renderAllFromState();
      const issue = state.evaluation.issues.find((i) => i.zone_id === zoneId);
      toast(issue ? `已移动：${issue.reasons.join("；")}` : "时段已调整，校验通过",
        Boolean(issue));
    } catch (e) { toast(e.message, true); await refresh(); }
  }

  // ------------------------------------------------------------ 冲突面板 / 状态

  function renderIssues() {
    const ev = state.evaluation;
    const bar = $("#status-bar");
    const text = $("#status-text");
    const meta = $("#status-meta");
    meta.textContent = `峰值流量 ${ev.max_flow} / ${state.settings.total_flow} L/min · ${state.zones.length} 个分区`;

    const panel = $("#issues-panel");
    const list = $("#issues-list");
    list.innerHTML = "";

    ev.issues.forEach((i) => {
      const li = document.createElement("li");
      li.innerHTML = `<strong>${escapeHtml(i.zone_name)}</strong>
        <span class="where">${hhmm(i.start_slot)}–${hhmm(i.end_slot)}</span>：
        <span class="reason">${i.reasons.map(escapeHtml).join("；")}</span>`;
      list.appendChild(li);
    });
    ev.unscheduled.forEach((u) => {
      const li = document.createElement("li");
      li.innerHTML = `<strong>${escapeHtml(u.zone_name)}</strong>
        <span class="where">未编排</span>：
        <span class="reason">${u.reasons.map(escapeHtml).join("；")}</span>`;
      li.addEventListener("click", () => selectZone(u.zone_id));
      li.style.cursor = "pointer";
      list.appendChild(li);
    });

    if (ev.valid) {
      bar.className = "status-bar";
      text.textContent = `✅ 计划有效：${state.items.length} 个分区全部编排，无冲突`;
      panel.classList.add("hidden");
    } else {
      bar.className = "status-bar bad";
      const n = ev.issues.length + ev.unscheduled.length;
      text.textContent = `❌ 校验未通过：${n} 个分区存在冲突或未编排`;
      panel.classList.remove("hidden");
    }
  }

  // ------------------------------------------------------------ 表单提交

  function bindForms() {
    $("#valve-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = e.target;
      const body = {
        name: f.elements.name.value.trim(),
        flow_lmin: Number(f.elements.flow_lmin.value),
        concur: Number(f.elements.concur.value),
      };
      try {
        await api("/api/valves", { method: "POST", body });
        f.reset(); f.elements.concur.value = 1;
        state = await api("/api/state");
        renderAllFromState();
        toast("阀门已添加");
      } catch (err) { toast(err.message, true); }
    });

    $("#blackout-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = e.target;
      const body = {
        name: f.elements.name.value.trim() || "停水时段",
        start: f.elements.start.value,
        end: f.elements.end.value,
      };
      try {
        await api("/api/blackouts", { method: "POST", body });
        f.reset();
        state = await api("/api/state");
        renderAllFromState();
        toast("停水时段已添加，计划已重新校验");
      } catch (err) { toast(err.message, true); }
    });

    $("#zone-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = e.target;
      const id = f.elements.id.value;
      const body = {
        name: f.elements.name.value.trim(),
        water_l: Number(f.elements.water_l.value),
        valve_id: Number(f.elements.valve_id.value),
        earliest: f.elements.earliest.value,
        latest: f.elements.latest.value,
      };
      const wantStart = toSlot(f.elements.item_start.value);
      try {
        if (id) {
          state = await api(`/api/zones/${id}`, { method: "PUT", body });
          // 同步该分区的计划时段：按新水量/流量重算时长
          const z2 = state.zones.find((x) => x.id === Number(id));
          const length = slotsForWater(z2.water_l, z2.flow_lmin);
          const old = state.items.find((it) => it.zone_id === z2.id);
          const items = state.items.filter((it) => it.zone_id !== z2.id);
          if (wantStart !== null || old) {
            let start = wantStart !== null ? wantStart : old.start_slot;
            start = Math.max(0, Math.min(SLOTS - length, start));
            items.push({ zone_id: z2.id, start_slot: start, length });
          }
          state = await api("/api/schedule", { method: "PUT", body: { items } });
          toast("分区已保存，计划已重新校验");
        } else {
          const created = await api("/api/zones", { method: "POST", body });
          selectedZoneId = created.id;
          state = await api("/api/state");
          resetZoneForm();
          toast("分区已添加，可点击「自动编排」或在时间轴上拖动");
        }
        renderAllFromState();
      } catch (err) { toast(err.message, true); }
    });

    $("#zone-cancel").addEventListener("click", () => {
      selectedZoneId = null;
      resetZoneForm();
      renderZones();
    });
  }

  // ------------------------------------------------------------ 顶部按钮

  function bindActions() {
    $("#plan-date").addEventListener("change", (e) => saveSettings({ plan_date: e.target.value }));
    $("#total-flow").addEventListener("change", (e) => saveSettings({ total_flow: e.target.value }));

    $("#btn-generate").addEventListener("click", async () => {
      try {
        state = await api("/api/generate", { method: "POST" });
        const n = state.evaluation.unscheduled.length;
        if (n === 0 && state.evaluation.valid) toast("自动编排完成，全部满足约束 ✅");
        else if (n > 0) toast(`已编排其他分区，${n} 个分区无可行位置`, true);
        else toast("编排完成，但存在约束冲突，请查看时间轴", true);
        renderAllFromState();
      } catch (e) { toast(e.message, true); }
    });

    $("#btn-save").addEventListener("click", async () => {
      try {
        state = await api("/api/schedule", {
          method: "PUT",
          body: { items: state.items.map(({ zone_id, start_slot, length }) => ({ zone_id, start_slot, length })) },
        });
        renderAllFromState();
        const ev = state.evaluation;
        if (ev.valid) toast("计划已保存，校验通过 ✅");
        else toast(`已保存，但有 ${ev.issues.length + ev.unscheduled.length} 处问题待处理`, true);
      } catch (e) { toast(e.message, true); }
    });

    $("#btn-clear").addEventListener("click", async () => {
      if (!confirm("将清空所有阀门、分区、停水时段与计划，确定继续？")) return;
      try {
        state = await api("/api/reset", { method: "POST", body: { sample: false } });
        selectedZoneId = null;
        resetZoneForm();
        renderAllFromState();
        toast("已清空，可从零开始编排");
      } catch (e) { toast(e.message, true); }
    });

    $("#btn-sample").addEventListener("click", async () => {
      if (!confirm("将清空当前数据并恢复内置示例，确定继续？")) return;
      try {
        state = await api("/api/reset", { method: "POST", body: { sample: true } });
        selectedZoneId = null;
        resetZoneForm();
        renderAllFromState();
        toast("示例数据已恢复，点击「自动编排」生成计划");
      } catch (e) { toast(e.message, true); }
    });
  }

  // ------------------------------------------------------------ 小工具

  function renderAllFromState() {
    renderSettings();
    renderValves();
    renderZones();
    renderBlackouts();
    renderTimeline();
    renderIssues();
    syncZoneForm();
  }

  function pct(slot) { return `${(slot / SLOTS) * 100}%`; }
  function setSlotRange(el, start, end) {
    el.style.left = pct(start);
    el.style.width = `${((end - start) / SLOTS) * 100}%`;
  }

  function iconButton(txt, title, onClick, danger = false) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "icon-btn" + (danger ? " del" : "");
    b.textContent = txt;
    b.title = title;
    b.addEventListener("click", onClick);
    return b;
  }

  function btn(txt, onClick, primary = false) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn small ghost" + (primary ? " primary" : "");
    if (primary) { b.classList.remove("ghost"); b.style.color = "#fff"; }
    b.textContent = txt;
    b.addEventListener("click", onClick);
    return b;
  }

  function readEditor(wrap, keys) {
    const out = {};
    keys.forEach((k) => { out[k] = wrap.querySelector(`[data-k="${k}"]`).value; });
    return out;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  const escapeAttr = escapeHtml;

  // ------------------------------------------------------------ 启动

  bindForms();
  bindActions();
  refresh().catch((e) => toast(e.message, true));
})();
