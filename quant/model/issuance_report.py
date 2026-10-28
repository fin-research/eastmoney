"""Concise real-coupon research output; Dashboard keeps its own modules."""


def coupon_report(snapshot):
    terms = snapshot["terms"]
    decision = snapshot["decision"]
    lines = [
        f"# 发行利率预测｜{snapshot['as_of_date']}",
        "",
        f"{terms['issuer']}，{terms['rating']}，{terms['tenor']:g}年{terms['bond_type']}，{terms['placement_type']}。",
        "",
        f"**{decision['action']}**。较低日期：{'、'.join(decision['low_rate_dates']) or '无'}。",
        "",
        "|日期|预测票面|",
        "|---|---:|",
    ]
    lines.extend(
        f"|{row['date']}|{row['coupon_percent']:.4f}%|" for row in snapshot["forecast"]
    )
    lines += [
        "",
        "|提前期|年份|发行事件|MAE(bp)|RMSE(bp)|偏差(bp)|命中率(±5bp)|",
        "|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for row in snapshot["validation"]["metrics"]:
        win = (
            "样本不足"
            if row.get("hit_rate_5bp") is None
            else f"{row['hit_rate_5bp']:.1%}"
        )
        lines.append(
            f"|{row['lead_days']}|{row['year']}|{row['samples']}|{row['mae_bp']:.2f}|{row['rmse_bp']:.2f}|{row['bias_bp']:.2f}|{win}|"
        )
    lines += [
        "",
        "命中率：实际票面与预测票面的绝对误差不超过5bp，高估、低估对称判定。固定阈值不参与选模。",
        "历史结果是给定发行条件的真实票面回放，已观察数据不构成新的独立前向证据。",
    ]
    return "\n".join(lines) + "\n"
