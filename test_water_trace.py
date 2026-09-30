"""用水回溯回归测试：15 分钟灌溉时段 × 水源「连续两次」状态半开区间。

覆盖关键边界：
- 采样时刻起采用新状态（[ts, next_ts)）；
- 当日首条采样前沿用最近历史状态（history），无历史样本 -> 证据不足；
- 超标重叠=风险水、观察重叠=待复核水，水量 = 阀门流量 × 重叠分钟；
- 阀门未绑定水源 -> 全天证据不足；
- 首条采样恰在 00:00 时零长度初始段剔除；
- 补录 / 删除采样后整体重算（用 recompute_source 重建序列模拟）。

运行（无需启动服务，纯模块级）：

    python -m unittest test_water_trace -v
"""

import unittest

import water_quality as wq
import water_trace as wt

DAY = "2026-09-30"


def sample(sid, ts, nitrate=10.0, ph=7.0, ec=1.0, turbidity=2.0):
    sample._i += 1
    return {"id": sample._i, "source_id": sid, "ts": ts, "ph": ph,
            "ec": ec, "turbidity": turbidity, "nitrate": nitrate}


sample._i = 0


def at(hhmm):
    return f"{DAY}T{hhmm}:00"


class TracebackTests(unittest.TestCase):
    def setUp(self):
        sample._i = 0
        self.ranges = wq.default_ranges()

    def _samples(self, rows):
        out = [sample(1, ts, nitrate=n) for ts, n in rows]
        wq.recompute_source(out, self.ranges)
        return out

    def _ctx(self, samples, start="08:00", end="11:00", flow=25,
             source_id=1, source_name="1# 机井水"):
        ds, _ = wt.parse_day(DAY)
        h0, m0 = map(int, start.split(":"))
        h1, m1 = map(int, end.split(":"))
        return {
            "zone_id": 1, "zone_name": "番茄区", "valve_id": 1,
            "valve_name": "北侧干管", "source_id": source_id,
            "source_name": source_name if source_id is not None else None,
            "flow_lmin": flow,
            "start": ds.replace(hour=h0, minute=m0),
            "end": ds.replace(hour=h1, minute=m1),
            "samples": samples,
        }

    def test_history_then_observe_then_normal(self):
        # 昨日两次越界 -> 最近历史为超标；09:00 回区间第 1 次=观察，10:00 第 2 次=正常
        samples = self._samples([
            ("2026-09-29T08:00:00", 34),
            ("2026-09-29T14:00:00", 36),
            (at("09:00"), 20),
            (at("10:00"), 20),
        ])
        z = wt.traceback(DAY, [self._ctx(samples)])["zones"][0]
        self.assertEqual(z["verdict"], "risk")
        self.assertEqual(z["risk_min"], 60)
        self.assertEqual(z["risk_l"], 1500)
        self.assertEqual(z["review_min"], 60)
        self.assertEqual(z["review_l"], 1500)
        self.assertEqual(z["safe_min"], 60)
        self.assertEqual(z["triggers"], ["硝酸盐"])
        kinds = {e["source_kind"] for e in z["evidence"]}
        self.assertEqual(kinds, {"history", "sample"})
        # 风险段的状态来源采样是最近一条历史采样（id=2）
        risk_piece = next(p for p in z["pieces"] if p["classification"] == "risk")
        self.assertEqual(risk_piece["source_kind"], "history")
        self.assertEqual(risk_piece["source_ts"], "2026-09-29T14:00:00")

    def test_no_history_before_first_sample_is_insufficient(self):
        # 当日 09:00 首次越界（观察）；08:00-09:00 无历史样本 -> 证据不足
        samples = self._samples([(at("09:00"), 34)])
        z = wt.traceback(DAY, [self._ctx(samples)])["zones"][0]
        self.assertEqual(z["unknown_min"], 60)
        self.assertEqual(z["review_min"], 120)
        self.assertEqual(z["verdict"], "review")  # 待复核优先于证据不足
        self.assertTrue(any("证据不足" in r for r in z["reasons"]))
        unknown = next(p for p in z["pieces"] if p["classification"] == "unknown")
        self.assertIsNone(unknown["sample_id"])
        self.assertEqual(unknown["source_kind"], "none")

    def test_no_samples_at_all(self):
        samples = self._samples([])
        z = wt.traceback(DAY, [self._ctx(samples)])["zones"][0]
        self.assertEqual(z["verdict"], "unknown")
        self.assertEqual(z["unknown_min"], 180)
        self.assertEqual(z["unknown_l"], 25 * 180)

    def test_unbound_valve(self):
        ctx = self._ctx(None, source_id=None, source_name=None)
        z = wt.traceback(DAY, [ctx])["zones"][0]
        self.assertEqual(z["verdict"], "unknown")
        self.assertEqual(z["unknown_min"], 180)
        self.assertIn("阀门未绑定水源", z["reasons"])
        self.assertTrue(all(p["source_kind"] == "unbound" for p in z["pieces"]))

    def test_state_applies_at_sample_timestamp_half_open(self):
        # 09:00 采样进入超标：恰从 09:00 起算风险（半开区间，分钟级精确）
        samples = self._samples([
            ("2026-09-29T08:00:00", 34),
            ("2026-09-29T14:00:00", 36),
            (at("08:30"), 40),
            (at("09:00"), 10),   # 回区间 1 次 -> 观察（09:00 起即观察，不含 08:59）
        ])
        ds, _ = wt.parse_day(DAY)
        ctx = self._ctx(samples, start="08:30", end="09:30")
        z = wt.traceback(DAY, [ctx])["zones"][0]
        pieces = {(p["start"][11:16], p["end"][11:16]): p["classification"]
                  for p in z["pieces"]}
        self.assertEqual(pieces[("08:30", "09:00")], "risk")
        self.assertEqual(pieces[("09:00", "09:30")], "review")

    def test_midnight_first_sample_zero_length_prefix(self):
        samples = self._samples([
            (at("00:00"), 34),
            (at("12:00"), 36),
        ])
        ds, de = wt.parse_day(DAY)
        segs = wt.state_segments(samples, ds, de)
        self.assertEqual(segs[0]["start"], at("00:00"))
        self.assertEqual(len(segs), 2)
        self.assertEqual(segs[0]["status"], "observing")
        self.assertEqual(segs[1]["status"], "exceeded")

    def test_recompute_after_delete_changes_verdict(self):
        samples = self._samples([
            ("2026-09-29T08:00:00", 34),
            ("2026-09-29T14:00:00", 36),
        ])
        z_before = wt.traceback(DAY, [self._ctx(samples)])["zones"][0]
        # 删除最近一条历史采样 -> 历史只剩 1 次越界（观察），风险水变待复核
        samples_after = self._samples([("2026-09-29T08:00:00", 34)])
        z_after = wt.traceback(DAY, [self._ctx(samples_after)])["zones"][0]
        self.assertGreater(z_before["risk_l"], 0)
        self.assertEqual(z_after["risk_l"], 0)
        self.assertEqual(z_after["review_min"], 180)

    def test_totals_and_multiple_zones(self):
        samples = self._samples([
            ("2026-09-29T08:00:00", 34),
            ("2026-09-29T14:00:00", 36),
        ])
        ctxs = [self._ctx(samples), self._ctx(samples, start="18:00", end="19:00")]
        ctxs[1]["zone_id"] = 2
        ctxs[1]["zone_name"] = "黄瓜区"
        payload = wt.traceback(DAY, ctxs)
        self.assertEqual(payload["totals"]["planned_zones"], 2)
        self.assertEqual(payload["totals"]["verdict_counts"]["risk"], 2)
        self.assertEqual(payload["totals"]["risk_min"], 240)  # 180 + 60
        self.assertEqual(payload["totals"]["risk_l"], 25 * 240)

    def test_bad_day_rejected(self):
        for bad in ("", "2026-9-30", "2026/09/30", "not-a-date"):
            with self.assertRaises(ValueError):
                wt.parse_day(bad)


if __name__ == "__main__":
    unittest.main()
