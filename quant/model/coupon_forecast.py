"""Issuance-coupon forecast on the complete data (coupon-forecast-v3).

Live reference implementation. The forecast coupon of a product is

    sector-curve anchor at the product tenor (last quote day)
  + the issuer's median deviation over its last five same-type issues
  + a fixed Huber model on standardised features (the residual).

Nothing is filled except the documented issuer-valuation rule: the sector curve is
interpolated across tenor and an issuer valuation is carried forward at most
FILL_LIMIT quote days. Everything else must exist or the forecast is refused.
"""

import json
import math
from pathlib import Path

import numpy as np
import pandas as pd

FEATURE_VERSION = "coupon-forecast-v3"
ALPHA = 300.0  # Huber penalty on standardised features; the residual sits on top of anchor + issuer median + curve nowcast
CURVE_CODE = "5781a1ff7651967e0176978d957b7346"
TYPES = ("证券公司债", "证券公司次级债")
ISSUER = "东方财富证券股份有限公司"
RATES = {
    "GOV_1Y": "E1000172", "GOV_3Y": "E1000174", "GOV_10Y": "E1000180",
    "CDB_3Y": "E1701708", "CDB_10Y": "E1701714", "AAA_3Y": "E1000413",
    "DR007": "E1300004", "R007": "E1704420", "SHIBOR_3M": "E1300079",
}
PRIMARY = ["ISSUE_AMT", "ISSUE_NUM", "NET_FINANCE_AMT", "END_REPAY_AMT", "RESALE_AMT"]
# code -> (name, frequency); M = released with published_date, D = as-of daily
FUND = {
    "EMM00000012": ("GDP不变价同比", "M"), "EMM00121996": ("制造业PMI", "M"), "EMM00008445": ("工业增加值同比", "M"),
    "EMM00641328": ("工业企业利润总额同比", "M"), "EMI00135328": ("社零同比", "M"), "EMM00590832": ("固定资产投资同比", "M"),
    "EMI00120220": ("房地产开发投资同比", "M"), "EMM00053058": ("出口金额同比", "M"), "EMM00072301": ("CPI同比", "M"),
    "EMI01737210": ("核心CPI同比", "M"), "EMM00073348": ("PPI同比", "M"), "EMM01607812": ("GDP平减指数同比", "M"),
    "EMM00087084": ("M1同比", "M"), "EMM00087086": ("M2同比", "M"), "EMM00634721": ("社融存量同比", "M"), "EMM00087129": ("人民币贷款同比", "M"),
    "EMG00000733": ("美国CPI同比", "M"), "EMG00157776": ("美国核心PCE同比", "M"), "EMG00152118": ("美国新增非农", "M"), "EMG00001039": ("美国失业率", "M"),
    "EMI01778636": ("30城商品房成交", "D"), "EMI00227697": ("南华工业品指数", "D"), "EMI01670402": ("水泥价格指数", "D"),
    "EMG00001306": ("美债2Y", "D"), "EMG00001310": ("美债10Y", "D"), "EMG00001435": ("美元指数", "D"), "EMM00618963": ("USD/CNH", "D"),
    "EMI00531920": ("WTI原油", "D"), "EMI00224675": ("黄金", "D"), "EMG00002593": ("标普500", "D"), "EMG00002594": ("纳斯达克", "D"),
    "EMG01582711": ("MSCI新兴市场", "D"), "EMG00002651": ("VIX", "D"),
    "E1715081": ("7D逆回购利率", "D"), "E1300003": ("DR001", "D"), "E1000183": ("30Y国债", "D"),
}
RATING = {"AAA": 3, "AAAsti": 3, "AA+": 2}
NODE_TOL = 0.03
FILL_LIMIT = 20
HISTORY_EVENTS = 5
PATH_QUOTES = 10
QUERIES = json.loads((Path(__file__).resolve().parents[1] / "online/coupon-queries.json").read_text())
ALL_EDB_CODES = sorted({*RATES.values(), *FUND})


def _ts(value):
    return pd.Timestamp(value)


class Refused(ValueError):
    """Raised when a required input is missing; nothing is filled in its place."""


def _series(rows, field):
    s = {}
    for r in rows:
        if r["field"] == field and r["value"] is not None and r["observation_date"] not in s:
            s[_ts(r["observation_date"])] = float(r["value"])
    return pd.Series(s, dtype=float).sort_index()


def _curve_frame(rows):
    frame = pd.DataFrame(rows)
    frame["observation_date"] = pd.to_datetime(frame["observation_date"])
    return frame.pivot_table(index="observation_date", columns="tenor_years", values="yield_pct")


def quote_context(inputs):
    days = pd.DatetimeIndex(sorted(_ts(d["observation_date"]) for d in inputs["datasets"]["curve_days"]))
    as_of = _ts(inputs["as_of_date"])
    days = days[days < as_of]
    if len(days) < 30 or days[-1] != _ts(inputs["required_source_date"]):
        raise Refused("Stale sector curve")
    return days


def nearest_node(nodes, tenor):
    nodes = np.asarray(sorted(nodes), float)
    near = nodes[np.abs(nodes - tenor).argmin()]
    return float(near) if abs(near - tenor) <= NODE_TOL else None


def issuer_history(inputs, days):
    """Deviation of every in-scope past issue of the issuer; mirrors the research ledger."""
    piv = _curve_frame(inputs["datasets"]["curve"] + inputs["datasets"]["event_curves"])
    rows = []
    for e in inputs["datasets"]["issuer_events"]:
        tender = _ts(e["tender_date"])
        prior = days[days < tender]
        if not len(prior) or prior[-1] not in piv.index:
            continue
        q = prior[-1]
        node = nearest_node(piv.columns, e["tenor"])
        if node is None or node < 1.0 or e["bond_rating"] not in RATING or np.isnan(piv.at[q, node]):
            continue
        label = _ts(e["tender_announcement_date"] or e["tender_date"])
        rows.append({"bond_code": e["bond_code"], "bond_type": e["bond_type"], "tender": tender, "label": label,
                     "dev": (float(e["coupon"]) - float(piv.at[q, node])) * 100, "amount": float(e["amount"]),
                     "rating": e["bond_rating"]})
    frame = pd.DataFrame(rows)
    if frame.empty:
        raise Refused("No issuer history")
    return frame.sort_values(["tender", "bond_code"]).reset_index(drop=True)


def issuer_terms(history, as_of, bond_type):
    """Median deviation and planned size from the last five same-type issues public a full day before as_of."""
    usable = history[(history.bond_type == bond_type) & (history.label + pd.Timedelta(days=1) < as_of)].tail(HISTORY_EVENTS)
    if len(usable) < 2:
        raise Refused(f"Fewer than two prior {bond_type} issues")
    latest = history[history.label + pd.Timedelta(days=1) < as_of].iloc[-1]
    return float(usable.dev.median()), float(usable.amount.median()), float(RATING[latest.rating]), int(len(usable))


def issuer_valuation(inputs, days, p, piv_all):
    """Balance-weighted spread of the issuer's live bonds to the interpolated sector curve."""
    obs = pd.DataFrame(inputs["datasets"]["issuer_bonds"])
    if obs.empty:
        raise Refused("No issuer bond valuations")
    obs["date"] = pd.to_datetime(obs["date"])
    bad_days = set(obs[obs.bal.isna()].date) | set(obs[(obs.bal > 0) & (obs.y.isna() | obs.term.isna())].date)
    live = obs[(obs.bal > 0) & obs.y.notna() & obs.term.notna() & obs.date.isin(piv_all.index)].copy()
    cache, curve = {}, []
    for d, t in zip(live.date, live.term):
        if d not in cache:
            row = piv_all.loc[d].dropna()
            cache[d] = (row.index.to_numpy(float), row.to_numpy(float))
        x, y = cache[d]
        curve.append(np.interp(t, x, y) if x[0] <= t <= x[-1] else np.nan)
    live["curve"] = curve
    live = live.dropna(subset=["curve"])
    live["sp"] = (live.y - live.curve) * 100
    live["w_sp"] = live.sp * live.bal
    live["w_term"] = live.term * live.bal
    g = live.groupby("date").agg(w_sp=("w_sp", "sum"), w_term=("w_term", "sum"), bal=("bal", "sum"), n=("code", "count"))
    g["spread"] = g.w_sp / g.bal
    g["term"] = g.w_term / g.bal
    g.loc[g.index.isin(bad_days), ["spread", "term"]] = np.nan
    filled = {k: g[k].reindex(days).ffill(limit=FILL_LIMIT) for k in ("spread", "term", "bal", "n")}
    return filled


def features(inputs, product, catch_up_hat, issuer_stats, days=None):
    """The full feature row of one product at the last quote day."""
    days = quote_context(inputs) if days is None else days
    p = len(days) - 1
    q = days[p]
    ds = inputs["datasets"]
    piv = _curve_frame(ds["curve"])
    node = nearest_node(piv.columns, product["tenor"])
    if node is None or q not in piv.index or np.isnan(piv.at[q, node]):
        raise Refused("Missing sector anchor")
    out = {}
    series = {name: _series(ds["edb"], code) for name, code in RATES.items()}
    for name, s in series.items():
        v0 = s.get(q, np.nan)
        out[name] = v0
        for k in (1, 5):
            out[f"{name}_chg{k}"] = (v0 - s.get(days[p - k], np.nan)) * 100
    for k in (1, 5):
        out[f"SECTOR_chg{k}"] = (piv.at[q, node] - piv.at[days[p - k], node]) * 100
    out["SECTOR_slope_3_5"] = (piv.at[q, 5.0] - piv.at[q, 3.0]) * 100
    out["credit_spread"] = (piv.at[q, 3.0] - out["GOV_3Y"]) * 100
    out["term_spread_10_1"] = (out["GOV_10Y"] - out["GOV_1Y"]) * 100
    out["cdb_gov_3y"] = (out["CDB_3Y"] - out["GOV_3Y"]) * 100
    qi = pd.DataFrame(ds["quant_input"])
    qi["observation_date"] = pd.to_datetime(qi["observation_date"])
    wide = qi.pivot_table(index="observation_date", columns="field", values="value")
    wide = wide.reindex(pd.date_range(wide.index.min(), wide.index.max()))
    for f in PRIMARY:
        out[f"{f}_5d"] = wide[f].rolling(5, min_periods=5).sum().get(q, np.nan)
    wc = wide["WEIGHTED_COST"]
    out["WEIGHTED_COST"] = wc.get(q, np.nan)
    out["WEIGHTED_COST_chg5"] = (wc.get(q, np.nan) - wc.get(days[p - 5], np.nan)) * 100
    median, amount, rating, n_prior = issuer_stats
    out["tenor_node"] = node
    out["subordinated"] = 1.0 if product["bond_type"] == "证券公司次级债" else 0.0
    out["log_amount"] = math.log(max(amount, 1e-6))
    out["rating_rank"] = rating
    out["catch_up_hat"] = float(catch_up_hat)
    # fundamentals
    for code, (name, freq) in FUND.items():
        rows = [r for r in ds["edb"] if r["field"] == code and r["value"] is not None]
        if freq == "M":
            seen = {}
            for r in rows:
                seen.setdefault(r["observation_date"], r)
            avail = sorted((_ts(r["published_date"]), float(r["value"])) for r in seen.values() if r["published_date"])
            usable = [v for d, v in avail if d <= q]
            out[name] = usable[-1] if usable else np.nan
            out[f"{name}·较上期变化"] = usable[-1] - usable[-2] if len(usable) >= 2 else np.nan
        else:
            s = _series(ds["edb"], code)
            def level(date, s=s):
                prior = s[s.index <= date]
                if prior.empty or (date - prior.index[-1]) > pd.Timedelta(days=10):
                    return np.nan
                return float(prior.iloc[-1])
            out[name] = level(q)
            out[f"{name}·5日变化"] = level(q) - level(days[p - 5])
    # issuer valuation
    piv_all = _curve_frame(ds["curve"])
    val = issuer_valuation(inputs, days, p, piv_all)
    s0, s5 = val["spread"].iloc[p], val["spread"].iloc[p - 5]
    out["issuer_spread"] = s0
    out["issuer_spread_chg5"] = s0 - s5
    out["issuer_term_gap"] = val["term"].iloc[p] - node
    bal = val["bal"].iloc[p]
    out["issuer_log_balance"] = math.log(bal) if bal > 0 else np.nan
    out["issuer_n_bonds"] = val["n"].iloc[p]
    out["_anchor_pct"] = float(piv.at[q, node])
    out["_node"] = node
    return out


GROUPS = ("利率", "信用", "资金面", "基本面", "一级发行", "二级行情", "发行条款")
_CREDIT = {"credit_spread", "SECTOR_slope_3_5"}


def feature_group(name):
    if name.startswith(("GOV_", "CDB_")) or name in ("term_spread_10_1", "cdb_gov_3y") or name.startswith(("美债", "30Y国债")):
        return "利率"
    if name.startswith(("AAA_3Y", "SECTOR_")) or name in _CREDIT:
        return "信用"
    if name.startswith(("DR007", "R007", "SHIBOR", "7D逆回购", "DR001")):
        return "资金面"
    if name.startswith(("ISSUE_", "NET_FINANCE", "END_REPAY", "RESALE", "WEIGHTED_COST")):
        return "一级发行"
    if name.startswith(("issuer_", "catch_up_hat")):
        return "二级行情"
    if name in ("tenor_node", "subordinated", "log_amount", "rating_rank"):
        return "发行条款"
    return "基本面"


_RATE_NAMES = {"GOV_1Y": "1Y国债", "GOV_3Y": "3Y国债", "GOV_10Y": "10Y国债", "CDB_3Y": "3Y国开债", "CDB_10Y": "10Y国开债",
               "AAA_3Y": "3Y AAA企业债", "DR007": "DR007", "R007": "R007", "SHIBOR_3M": "SHIBOR 3M"}
_OTHER = {
    "SECTOR_slope_3_5": "券商债3Y-5Y曲线斜率", "credit_spread": "3Y券商债-国债利差", "term_spread_10_1": "国债10Y-1Y期限利差",
    "cdb_gov_3y": "3Y国开债-国债利差", "WEIGHTED_COST": "一级加权融资成本", "WEIGHTED_COST_chg5": "一级加权融资成本5日变动",
    "tenor_node": "发行期限", "subordinated": "次级债", "log_amount": "发行规模", "rating_rank": "主体评级",
    "catch_up_hat": "券商债曲线短期走势预测", "issuer_spread": "发行人存量债估值利差", "issuer_spread_chg5": "发行人存量债估值利差5日变动",
    "issuer_term_gap": "发行人存量债期限差", "issuer_log_balance": "发行人存量债余额", "issuer_n_bonds": "发行人存量债只数",
    "ISSUE_AMT_5d": "5日一级发行额", "ISSUE_NUM_5d": "5日一级发行只数", "NET_FINANCE_AMT_5d": "5日一级净融资额",
    "END_REPAY_AMT_5d": "5日到期偿还额", "RESALE_AMT_5d": "5日回售额",
}


def feature_label(name):
    if name in _OTHER:
        return _OTHER[name]
    for key, label in _RATE_NAMES.items():
        if name == key:
            return f"{label}收益率" if key not in ("DR007", "R007", "SHIBOR_3M") else label
        if name.startswith(f"{key}_chg"):
            return f"{label}{name.rsplit('chg', 1)[1]}日变动"
    if name.startswith("SECTOR_chg"):
        return f"券商债曲线{name.rsplit('chg', 1)[1]}日变动"
    return name


def columns():
    """Model columns in the order features() produces them."""
    out = []
    for name in RATES:
        out += [name, f"{name}_chg1", f"{name}_chg5"]
    out += ["SECTOR_chg1", "SECTOR_chg5", "SECTOR_slope_3_5", "credit_spread", "term_spread_10_1", "cdb_gov_3y"]
    out += [f"{f}_5d" for f in PRIMARY] + ["WEIGHTED_COST", "WEIGHTED_COST_chg5"]
    out += ["tenor_node", "subordinated", "log_amount", "rating_rank"]
    for name, freq in FUND.values():
        out += [name, f"{name}·较上期变化" if freq == "M" else f"{name}·5日变化"]
    out += ["issuer_spread", "issuer_spread_chg5", "issuer_term_gap", "issuer_log_balance", "issuer_n_bonds"]
    return out


def validate_model(model):
    n = len(model["columns"])
    if (model.get("kind") != "coupon_huber" or len(set(model["columns"])) != n
            or any(len(model[k]) != n for k in ("mean", "scale", "coef"))
            or not all(math.isfinite(x) for k in ("mean", "scale", "coef") for x in model[k])
            or any(x <= 0 for x in model["scale"]) or not math.isfinite(model["intercept"])):
        raise ValueError("Invalid coupon model")


def predict(model, row):
    """Residual prediction in bp and each feature's contribution."""
    values = np.array([row[c] for c in model["columns"]], float)
    if not np.isfinite(values).all():
        missing = [c for c, v in zip(model["columns"], values) if not np.isfinite(v)]
        raise Refused(f"Incomplete coupon inputs: {missing[:5]}")
    z = (values - np.asarray(model["mean"])) / np.asarray(model["scale"])
    contributions = z * np.asarray(model["coef"])
    return float(model["intercept"] + contributions.sum()), contributions


PRODUCTS = tuple(
    {"key": f"{tenor}y-{kind}", "tenor": float(tenor), "bond_type": bond_type, "label": f"{tenor}年{name}"}
    for tenor in (3, 5)
    for kind, bond_type, name in (("public", "证券公司债", "公募债"), ("sub", "证券公司次级债", "次级债"))
)


def product_forecast(manifest, model, inputs, timing, days, history, product):
    from data.issuance_calendar import IssuanceCalendar  # noqa: PLC0415

    as_of = _ts(inputs["as_of_date"])
    stats = issuer_terms(history, as_of, product["bond_type"])
    row = features(inputs, product, timing["catch_up_bp"], stats, days)
    residual, contributions = predict(model, row)
    median, amount, _rating, n_prior = stats
    anchor = row["_anchor_pct"]
    catch_up = float(timing["catch_up_bp"])
    deviation = median + catch_up + residual
    coupon = anchor + deviation / 100
    base = anchor * 100 + median + model["intercept"]
    detail = [
        {"feature": c, "label": feature_label(c), "group": feature_group(c), "value": float(row[c]), "contribution_bp": float(v)}
        for c, v in zip(model["columns"], contributions)
    ]
    detail.append({"feature": "catch_up_hat", "label": feature_label("catch_up_hat"), "group": "二级行情",
                   "value": catch_up, "contribution_bp": catch_up})
    groups = {g: 0.0 for g in GROUPS}
    for d in detail:
        groups[d["group"]] += d["contribution_bp"]
    if abs(base + sum(groups.values()) - coupon * 100) > 1e-6:
        raise ValueError("Contributions do not reconcile")
    calendar = IssuanceCalendar(manifest["calendar"])
    path = []
    for h in range(PATH_QUOTES):
        try:
            day = calendar.next_quote_day(inputs["required_source_date"], 1 + h)
        except ValueError:
            break
        drift = timing["wait_bp"] * min(h, 3) / 3 / 100
        path.append({"date": str(day.date()), "coupon_percent": coupon + drift})
    return {
        "key": product["key"], "label": product["label"], "tenor": product["tenor"], "bond_type": product["bond_type"],
        "anchor_pct": anchor, "issuer_median_bp": median, "intercept_bp": model["intercept"], "base_coupon_bp": base,
        "deviation_bp": deviation, "coupon_pct": coupon, "n_prior": n_prior, "planned_amount_yi": amount,
        "groups": [{"group": g, "net_bp": groups[g]} for g in GROUPS], "contributions": detail, "path": path,
    }


def coupon_snapshot(manifest, model, inputs, timing):
    """timing carries the same-day sector nowcast: catch_up_bp, wait_bp, action."""
    validate_model(model)
    days = quote_context(inputs)
    history = issuer_history(inputs, days)
    products = [product_forecast(manifest, model, inputs, timing, days, history, p) for p in PRODUCTS]
    first = products[0]
    narrative = f"{first['label']}预测发行利率{first['coupon_pct']:.2f}%。"
    return {
        "schema_version": FEATURE_VERSION,
        "as_of_date": inputs["as_of_date"],
        "market_source_date": inputs["required_source_date"],
        "model_version": manifest["model_version"],
        "issuer": inputs["issuer"],
        "training_label_cutoff": manifest["training_label_cutoff"],
        "timing": {"catch_up_bp": timing["catch_up_bp"], "wait_bp": timing["wait_bp"], "action": timing["action"]},
        "products": products,
        "validation": manifest["validation"],
        "base_conclusion": {"verdict": timing["action"], "preferred_window": "", "narrative": narrative},
    }
