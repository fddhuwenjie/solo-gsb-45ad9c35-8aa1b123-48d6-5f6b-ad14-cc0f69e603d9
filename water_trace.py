"""水质异常后的「用水回溯」核心。

把轮灌编排台生成的 **15 分钟半开灌溉时段** ``[start, end)`` 与某水源按既有
「连续两次」状态机（见 ``water_quality``）重建的**当日状态半开区间**求交：

- 采样时刻起采用该采样重算出的新状态，即每个状态区间为 ``[ts, next_ts)``；
- 当日首条采样之前，沿用**最近一条历史采样**的状态（``history``）；
- 没有任何历史样本可沿用时，该段标记为「证据不足」（``insufficient``）；
- 阀门未绑定水源时，其全部灌溉时段同样为「证据不足」。

区间分类：

- 「超标」状态的重叠部分记为 **风险水（risk）**；
- 「观察」状态的重叠部分记为 **待复核水（review）**；
- 「正常」为安全（safe），「证据不足」为 unknown；
- 水量 = 阀门额定流量 (L/min) × 重叠分钟数。

本模块为纯函数，不访问数据库；采样序列由应用层用
``water_quality.recompute_source`` 重算后传入。
"""

from datetime import datetime, timedelta

import water_quality as wq

NORMAL, OBSERVING, EXCEEDED = wq.NORMAL, wq.OBSERVING, wq.EXCEEDED
INSUFFICIENT = "insufficient"

RISK, REVIEW, SAFE, UNKNOWN = "risk", "review", "safe", "unknown"
CLASS_BY_STATUS = {
    EXCEEDED: RISK,
    OBSERVING: REVIEW,
    NORMAL: SAFE,
    INSUFFICIENT: UNKNOWN,
}
# 分区判定优先级：只要有风险分钟就判风险，其次待复核，再次证据不足，最后才安全
VERDICT_ORDER = [RISK, REVIEW, UNKNOWN, SAFE]

STATUS_LABEL = {**wq.STATUS_LABEL, INSUFFICIENT: "证据不足"}
CLASS_LABEL = {RISK: "风险", REVIEW: "待复核", SAFE: "正常", UNKNOWN: "证据不足"}
KIND_LABEL = {
    "sample": "当日采样",
    "history": "沿用最近历史采样",
    "none": "无历史样本",
    "unbound": "阀门未绑定水源",
}

REASON_NO_HISTORY = "当日首条采样前无历史样本，状态证据不足"
REASON_UNBOUND = "阀门未绑定水源"

DAY_FMT = "%Y-%m-%d"


# ---------------------------------------------------------------- 工具

def parse_day(day):
    """'YYYY-MM-DD' -> (当日 00:00, 次日 00:00)，非法日期抛 ValueError。"""
    if not isinstance(day, str) or not day.strip():
        raise ValueError("日期格式应为 YYYY-MM-DD")
    text = day.strip()
    if len(text) != 10 or text[4] != "-" or text[7] != "-":
        raise ValueError(f"日期格式错误：{day}（应为 YYYY-MM-DD）")
    try:
        start = datetime.strptime(text, DAY_FMT)
    except ValueError:
        raise ValueError(f"日期格式错误：{day}（应为 YYYY-MM-DD）")
    return start, start + timedelta(days=1)


def _iso(dt):
    return dt.isoformat(timespec="seconds")


def _num(value, ndigits):
    """四舍五入并消除 -0.0。"""
    out = round(float(value), ndigits)
    return 0 if out == 0 else out


# ---------------------------------------------------------------- 状态区间

def state_segments(samples, day_start, day_end):
    """重建某水源覆盖 ``[day_start, day_end)`` 的状态半开区间序列。

    samples: 该水源**全部**历史采样（经 ``wq.recompute_source`` 重算，ts 升序）。
    每个区间返回：

      start/end:    ISO 半开区间端点（覆盖且仅覆盖当日，零长度段已剔除）
      status:       normal / observing / exceeded / insufficient
      triggers:     触发指标中文名列表
      source_ts:    决定该状态的采样时刻（证据不足时为 None）
      source_kind:  sample（当日采样）/ history（沿用最近历史采样）/ none（无历史样本）
      sample_id:    来源采样行 ID（证据不足时为 None）
    """
    # 初始段：当日首条采样之前沿用最近历史状态；无历史样本则证据不足
    history = [s for s in samples if datetime.fromisoformat(s["ts"]) < day_start]
    if history:
        last = history[-1]
        pieces = [{
            "status": last["status"],
            "triggers": list(last["triggers"]),
            "source_ts": last["ts"],
            "source_kind": "history",
            "sample_id": last["id"],
        }]
    else:
        pieces = [{
            "status": INSUFFICIENT, "triggers": [],
            "source_ts": None, "source_kind": "none", "sample_id": None,
        }]

    # 当日采样：采样时刻起采用新状态；恰落在次日 00:00 的采样属于次日
    for s in samples:
        ts = datetime.fromisoformat(s["ts"])
        if day_start <= ts < day_end:
            pieces.append({
                "status": s["status"],
                "triggers": list(s["triggers"]),
                "source_ts": s["ts"],
                "source_kind": "sample",
                "sample_id": s["id"],
            })

    bounds = [day_start]
    for piece in pieces[1:]:
        bounds.append(datetime.fromisoformat(piece["source_ts"]))
    bounds.append(day_end)

    segments = []
    for piece, lo, hi in zip(pieces, bounds[:-1], bounds[1:]):
        if hi > lo:  # 采样恰在 00:00 时初始段为零长度，剔除
            segments.append({**piece, "start": _iso(lo), "end": _iso(hi)})
    return segments


def unbound_segments(day_start, day_end):
    """阀门未绑定水源时全天为证据不足区间。"""
    return [{
        "status": INSUFFICIENT, "triggers": [],
        "source_ts": None, "source_kind": "unbound", "sample_id": None,
        "start": _iso(day_start), "end": _iso(day_end),
    }]


# ---------------------------------------------------------------- 求交

def intersect_window(segments, win_start, win_end):
    """灌溉半开区间 ``[win_start, win_end)`` 与状态区间求交。

    返回重叠片段列表（按时间升序），片段带分钟数与分类标签。
    """
    pieces = []
    for seg in segments:
        lo = max(win_start, datetime.fromisoformat(seg["start"]))
        hi = min(win_end, datetime.fromisoformat(seg["end"]))
        if hi <= lo:
            continue
        minutes = (hi - lo).total_seconds() / 60.0
        pieces.append({
            "start": _iso(lo),
            "end": _iso(hi),
            "minutes": minutes,
            "status": seg["status"],
            "classification": CLASS_BY_STATUS[seg["status"]],
            "triggers": list(seg["triggers"]),
            "source_ts": seg["source_ts"],
            "source_kind": seg["source_kind"],
            "sample_id": seg["sample_id"],
        })
    return pieces


# ---------------------------------------------------------------- 分区核算

def _empty_buckets():
    return {c: 0.0 for c in (RISK, REVIEW, UNKNOWN, SAFE)}


def build_zone_row(ctx, day_start, day_end):
    """核算单个已编排分区。

    ctx 字段：
      zone_id/zone_name/valve_id/valve_name/source_id/source_name、
      flow_lmin、start/end（datetime 半开区间）、
      samples（绑定水源的全部重算采样；未绑定时为 None）。
    """
    flow = float(ctx.get("flow_lmin") or 0)
    if ctx.get("source_id") is None:
        segments = unbound_segments(day_start, day_end)
    else:
        segments = state_segments(ctx["samples"], day_start, day_end)
    pieces = intersect_window(segments, ctx["start"], ctx["end"])

    liters = _empty_buckets()
    minutes = _empty_buckets()
    triggers, reasons = [], set()
    evidence = {}
    for p in pieces:
        p_liters = p["minutes"] * flow
        p["liters"] = p_liters
        cls = p["classification"]
        liters[cls] += p_liters
        minutes[cls] += p["minutes"]
        if cls in (RISK, REVIEW):
            for name in p["triggers"]:
                if name not in triggers:
                    triggers.append(name)
        if cls == UNKNOWN:
            reasons.add(REASON_UNBOUND if p["source_kind"] == "unbound"
                        else REASON_NO_HISTORY)
        if p["sample_id"] is not None:
            evidence[p["sample_id"]] = {
                "sample_id": p["sample_id"],
                "ts": p["source_ts"],
                "status": p["status"],
                "triggers": list(p["triggers"]),
                "source_kind": p["source_kind"],
            }

    verdict = next((c for c in VERDICT_ORDER if minutes[c] > 0), SAFE)

    out_pieces = []
    for p in pieces:
        out_pieces.append({
            "start": p["start"], "end": p["end"],
            "minutes": _num(p["minutes"], 1),
            "liters": _num(p["liters"], 2),
            "status": p["status"],
            "classification": p["classification"],
            "triggers": p["triggers"],
            "source_ts": p["source_ts"],
            "source_kind": p["source_kind"],
            "sample_id": p["sample_id"],
        })

    return {
        "zone_id": ctx["zone_id"],
        "zone": ctx["zone_name"],
        "valve_id": ctx.get("valve_id"),
        "valve": ctx.get("valve_name"),
        "source_id": ctx.get("source_id"),
        "source": ctx.get("source_name"),
        "start": ctx["start"].strftime("%H:%M"),
        "end": ctx["end"].strftime("%H:%M"),
        "duration_min": int((ctx["end"] - ctx["start"]).total_seconds() // 60),
        "flow_lmin": flow,
        "verdict": verdict,
        "verdict_label": CLASS_LABEL[verdict],
        "risk_min": _num(minutes[RISK], 1),
        "review_min": _num(minutes[REVIEW], 1),
        "unknown_min": _num(minutes[UNKNOWN], 1),
        "safe_min": _num(minutes[SAFE], 1),
        "risk_l": _num(liters[RISK], 2),
        "review_l": _num(liters[REVIEW], 2),
        "unknown_l": _num(liters[UNKNOWN], 2),
        "safe_l": _num(liters[SAFE], 2),
        "triggers": triggers,
        "reasons": sorted(reasons),
        "evidence": sorted(evidence.values(), key=lambda e: e["ts"]),
        "pieces": out_pieces,
    }


def traceback(day, contexts):
    """对一天的全部已编排分区核算用水回溯。

    contexts 为 ``build_zone_row`` 的入参列表；返回汇总 payload（不含生成时间等
    应用层元信息，由调用方补充）。
    """
    day_start, day_end = parse_day(day)
    zones = [build_zone_row(ctx, day_start, day_end) for ctx in contexts]

    totals = {"planned_zones": len(zones)}
    totals["verdict_counts"] = {
        c: sum(1 for z in zones if z["verdict"] == c)
        for c in (RISK, REVIEW, UNKNOWN, SAFE)
    }
    acc_l = _empty_buckets()
    acc_m = _empty_buckets()
    for z in zones:
        acc_l[RISK] += z["risk_l"]
        acc_l[REVIEW] += z["review_l"]
        acc_l[UNKNOWN] += z["unknown_l"]
        acc_l[SAFE] += z["safe_l"]
        acc_m[RISK] += z["risk_min"]
        acc_m[REVIEW] += z["review_min"]
        acc_m[UNKNOWN] += z["unknown_min"]
        acc_m[SAFE] += z["safe_min"]
    totals.update({
        "risk_l": _num(acc_l[RISK], 2),
        "review_l": _num(acc_l[REVIEW], 2),
        "unknown_l": _num(acc_l[UNKNOWN], 2),
        "safe_l": _num(acc_l[SAFE], 2),
        "risk_min": _num(acc_m[RISK], 1),
        "review_min": _num(acc_m[REVIEW], 1),
        "unknown_min": _num(acc_m[UNKNOWN], 1),
        "safe_min": _num(acc_m[SAFE], 1),
    })
    return {
        "day": day,
        "slot_minutes": wq_slot_min(),
        "status_labels": STATUS_LABEL,
        "class_labels": CLASS_LABEL,
        "kind_labels": KIND_LABEL,
        "totals": totals,
        "zones": zones,
    }


def wq_slot_min():
    """15 分钟槽粒度（与 scheduler.SLOT_MIN 保持一致，间接引用避免循环依赖）。"""
    import scheduler
    return scheduler.SLOT_MIN
