"""模型特征分组规则。

集中维护不依赖市场观测值、可由目标日期直接确定的日历特征，避免训练层
和发行择时应用层互相引用私有实现。
"""

CALENDAR_FEATURES = frozenset(
    {
        "day_of_week",
        "month",
        "is_month_end",
        "is_quarter_end",
        "is_year_end",
        "days_to_month_end",
        "days_to_quarter_end",
    }
)


def split_feature_names(feature_names: list[str]) -> tuple[list[str], list[str]]:
    """按输入顺序返回 ``(市场特征, 日历特征)``。"""
    return (
        [name for name in feature_names if name not in CALENDAR_FEATURES],
        [name for name in feature_names if name in CALENDAR_FEATURES],
    )
