"""一级发行定价数据：定价日前信息、发行时评级与保守的标签可用日期。"""

from pathlib import Path

import httpx
import pandas as pd

from choice.data_api import ChoiceAPIError, css
from .data import BondDataBuilder, DATA_FILE
from .rate_data import RateDataset
from .issuance_scope import excluded_private_mask, ISSUANCE_SCOPE


PRICING_METADATA_FILE = DATA_FILE.parent / "issuance_pricing_metadata.csv"
PRICING_METADATA_INDICATORS = (
    "TENDERANNCDATE,ISSCORPCREDITRAT,TENDERFINALCOUPON,TENDERDATE"
)
PRICING_METADATA_COLUMNS = {
    "code": "bond_code",
    "TENDERANNCDATE": "announcement_date",
    "ISSCORPCREDITRAT": "issuance_rating",
    "TENDERFINALCOUPON": "final_coupon",
    "TENDERDATE": "pricing_date",
}


def _query_pricing_batch(batch, client, indicators=PRICING_METADATA_INDICATORS):
    for attempt in range(3):
        try:
            return css(
                ",".join(batch),
                indicators,
                "Ispandas=1",
                client=client,
            )
        except ChoiceAPIError as exc:
            transient = "ConnectTimeout" in str(exc) or "ConnectError" in str(exc)
            if not transient or attempt == 2:
                raise
            print(
                f"[pricing metadata] transient connection failure; retry {attempt + 1}/2",
                flush=True,
            )


def eligible_primary_bonds(bonds: pd.DataFrame) -> pd.DataFrame:
    """与默认发行方案一致：固定利率，期限在可观测范围内。"""
    return bonds.loc[
        bonds["利率类型"].eq("固息")
        & bonds.tenor.between(1, 10)
        & bonds.bond_code.str.upper().str.endswith((".SH", ".SZ"))
        & ~excluded_private_mask(bonds)
    ].copy()


def refresh_pricing_metadata(
    path: Path = PRICING_METADATA_FILE, *, batch_size: int = 64
) -> dict:
    """显式增量查询，只补没有缓存的代码；每个成功批次原子落盘。"""
    bonds = eligible_primary_bonds(BondDataBuilder().bond_data(require_spread=False))
    cached = pd.read_csv(path) if path.exists() else pd.DataFrame(columns=["bond_code"])
    missing = sorted(set(bonds.bond_code) - set(cached.bond_code))
    checked = cached.get(
        "pricing_date_checked", pd.Series(False, index=cached.index)
    ).eq(True)
    enrich = sorted(set(cached.loc[~checked, "bond_code"]) & set(bonds.bond_code))
    with httpx.Client() as client:
        cached = _refresh_metadata_batches(missing, cached, path, batch_size, client)
        cached = _refresh_metadata_batches(
            enrich, cached, path, batch_size, client, indicators="TENDERDATE"
        )
    return {
        "eligible_bonds": len(bonds),
        "cached_codes": len(cached),
        "fetched_codes": len(missing),
        "pricing_dates_queried": len(enrich),
    }


def _refresh_metadata_batches(
    missing, cached, path, batch_size, client, indicators=PRICING_METADATA_INDICATORS
):
    for start in range(0, len(missing), batch_size):
        batch = missing[start : start + batch_size]
        response = _query_pricing_batch(batch, client, indicators)
        if response.error_code != 0:
            raise ChoiceAPIError(
                f"pricing metadata query failed: {response.error_code}"
            )
        result = pd.DataFrame(response.rows).rename(columns=PRICING_METADATA_COLUMNS)
        required = {
            "bond_code",
            *(PRICING_METADATA_COLUMNS[field] for field in indicators.split(",")),
        }
        if not required.issubset(result.columns):
            raise ValueError(
                "pricing metadata response is missing requested indicator fields"
            )
        canonical = {code.upper(): code for code in batch}
        if "bond_code" in result:
            result["bond_code"] = (
                result.bond_code.astype(str).str.upper().map(canonical)
            )
        if set(result.get("bond_code", [])) != set(batch):
            raise ValueError(
                "pricing metadata response code coverage differs from request"
            )
        result["fetched_at"] = pd.Timestamp.now(tz="UTC").isoformat()
        result["source"] = "Choice CSS / data API"
        result["pricing_date_checked"] = True
        cached = (
            result.set_index("bond_code")
            .combine_first(cached.set_index("bond_code"))
            .reset_index()
        )
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_suffix(".csv.tmp")
        cached.to_csv(temp, index=False)
        temp.replace(path)
        print(f"[pricing metadata] cached {len(cached)} codes", flush=True)
    return cached


def build_primary_pricing_dataset(
    rates: RateDataset,
    metadata_path: Path = PRICING_METADATA_FILE,
    *,
    bonds: pd.DataFrame | None = None,
    metadata: pd.DataFrame | None = None,
) -> tuple[pd.DataFrame, dict]:
    """招投标/簿记日开盘前预测最终票面；不把发行起始日当作定价日。"""
    bonds = (
        BondDataBuilder().bond_data(require_spread=False) if bonds is None else bonds
    )
    eligible = eligible_primary_bonds(bonds)
    meta = pd.read_csv(metadata_path) if metadata is None else metadata
    if meta.bond_code.duplicated().any():
        raise ValueError("duplicate bond codes in pricing metadata")
    frame = eligible.merge(meta, on="bond_code", how="left", validate="one_to_one")
    if "pricing_date" not in frame:
        raise ValueError("pricing dates missing; refresh pricing metadata first")
    text = frame.pricing_date.astype("string")
    full_date = text.str.match(r"^\d{4}[-/]\d{1,2}[-/]\d{1,2}$", na=False)
    frame["decision_date"] = pd.to_datetime(
        text.where(full_date), format="mixed", errors="coerce"
    )
    frame["final_coupon"] = pd.to_numeric(frame.final_coupon, errors="coerce")
    known = (
        frame.decision_date.notna()
        & frame.issuance_rating.notna()
        & frame.final_coupon.gt(0)
    )
    date_conflict = known & frame.decision_date.gt(frame.issue_date)
    # 冲突日期先隔离，等待原始发行公告核实，不能用可疑的晚定价日读入未来行情。
    valid = frame.loc[known & ~date_conflict].copy()
    valid["rating_snapshot"] = valid.rating
    valid["rating"] = valid.issuance_rating
    dates = rates.levels_bp.index
    prior = dates.searchsorted(valid.decision_date, side="left") - 1
    # 当日市场价格只用于分解事后票面标签，绝不进入当日预测的信息集。
    anchor = dates.searchsorted(valid.decision_date, side="right") - 1
    available = (
        (prior >= 0) & (anchor >= 0) & valid.decision_date.le(dates.max()).to_numpy()
    )
    valid = valid.loc[available].copy()
    prior, anchor = prior[available], anchor[available]
    valid["source_date"] = dates.take(prior)
    valid["market_anchor_date"] = dates.take(anchor)
    valid["known_market_bp"] = rates.levels_bp.AAA_3Y.iloc[prior].to_numpy()
    valid["anchor_market_bp"] = rates.levels_bp.AAA_3Y.iloc[anchor].to_numpy()
    valid["coupon_bp"] = valid.final_coupon * 100
    valid["premium_bp"] = valid.coupon_bp - valid.anchor_market_bp
    valid["label_available_date"] = valid[["issue_date", "decision_date"]].max(axis=1)
    valid["quote_age_days"] = (valid.decision_date - valid.source_date).dt.days
    audit = {
        "raw_bonds": len(bonds),
        "excluded_non_public_codes": sorted(
            bonds.loc[excluded_private_mask(bonds), "bond_code"]
            .astype(str)
            .str.upper()
            .unique()
        ),
        "non_public_excluded": int(excluded_private_mask(bonds).sum()),
        "offering_scope": ISSUANCE_SCOPE,
        "non_exchange_bonds_excluded": int(
            (~bonds.bond_code.str.upper().str.endswith((".SH", ".SZ"))).sum()
        ),
        "eligible_plain_fixed_bonds": len(eligible),
        "missing_metadata_or_final_coupon": int((~known).sum()),
        "pricing_before_issue_start": int(
            valid.decision_date.lt(valid.issue_date).sum()
        ),
        "pricing_on_issue_start": int(valid.decision_date.eq(valid.issue_date).sum()),
        "pricing_after_issue_start_quarantined": int(date_conflict.sum()),
        "usable_pricing_labels": len(valid),
        "rating_snapshot_mismatch": int(valid.rating.ne(valid.rating_snapshot).sum()),
        "coupon_reference_mismatch": int(
            (valid.final_coupon - valid.coupon).abs().gt(1e-6).sum()
        ),
        "source": str(metadata_path),
        "decision_semantics": "opening of recorded Choice TENDERDATE (auction/bookbuilding date)",
        "label_semantics": "final coupon; secondary anchor is only a pricing decomposition",
        "availability": "outcomes used only after both pricing date and issue-start date; source has day precision",
    }
    return valid.sort_values(["decision_date", "bond_code"]).reset_index(
        drop=True
    ), audit
