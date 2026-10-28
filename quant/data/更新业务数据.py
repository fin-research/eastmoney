"""兼容入口；实际刷新逻辑已纳入统一数据 pipeline。"""

from data.local_data import refresh_business_data


if __name__ == "__main__":
    frame = refresh_business_data()
    print(f"业务数据已刷新：{len(frame)} 行，最新 {frame.index.max():%Y-%m-%d}")
