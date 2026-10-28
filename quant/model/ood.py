"""
P3：OOD（分布外）检测 + KNN 降级预测 + P2/P3 联合预测入口。
"""

import numpy as np


def check_ood(
    x_vec: np.ndarray,
    feat_names: list[str],
    feature_ranges: dict,
    severity: str = "moderate",
) -> dict:
    """
    检测特征向量是否超出训练分布。

    severity: "moderate" 用 P5/P95，"strict" 用 P1/P99
    返回: {n_ood, ood_features, ood_ratio, confidence}
    """
    lo_key = "p05" if severity == "moderate" else "p01"
    hi_key = "p95" if severity == "moderate" else "p99"

    ood_list = []
    for j, fname in enumerate(feat_names):
        if fname not in feature_ranges:
            continue
        val = float(x_vec[j])
        lo = feature_ranges[fname][lo_key]
        hi = feature_ranges[fname][hi_key]
        if val < lo or val > hi:
            hint = (
                f"< P{5 if severity == 'moderate' else 1}"
                if val < lo
                else f"> P{95 if severity == 'moderate' else 99}"
            )
            ood_list.append(
                {
                    "feature": fname,
                    "value": round(val, 4),
                    "bound": f"[{lo:.4f}, {hi:.4f}]",
                    "direction": "偏低" if val < lo else "偏高",
                    "percentile_hint": hint,
                }
            )

    ratio = len(ood_list) / len(feat_names) if feat_names else 0
    if ratio == 0:
        confidence = "high"
    elif ratio <= 0.1:
        confidence = "medium"
    elif ratio <= 0.25:
        confidence = "low"
    else:
        confidence = "very_low"

    return {
        "n_ood": len(ood_list),
        "ood_features": ood_list,
        "ood_ratio": round(ratio, 3),
        "confidence": confidence,
    }


def knn_fallback_predict(
    x_vec: np.ndarray,
    train_X: np.ndarray,
    train_y: np.ndarray,
    feat_names: list[str],
    train_feat_names_subset: "list[str] | None" = None,
    k: int = 10,
) -> dict:
    """KNN 最近邻降级预测（当 OOD 严重时替代树模型）。"""
    from sklearn.neighbors import NearestNeighbors
    from sklearn.preprocessing import StandardScaler

    if train_feat_names_subset is None:
        train_feat_names_subset = feat_names

    common = [f for f in feat_names if f in train_feat_names_subset]
    if not common:
        return {
            "pred_bp": float(np.mean(train_y)),
            "pred_p25": float(np.percentile(train_y, 25)),
            "pred_p75": float(np.percentile(train_y, 75)),
            "knn_distances": [],
            "knn_labels": [],
            "n_neighbors": 0,
        }

    x_idx = [feat_names.index(f) for f in common]
    t_idx = [train_feat_names_subset.index(f) for f in common]

    x_sub = x_vec[x_idx].reshape(1, -1)
    t_sub = train_X[:, t_idx]

    scaler = StandardScaler()
    t_scaled = scaler.fit_transform(t_sub)
    x_scaled = scaler.transform(x_sub)

    nn = NearestNeighbors(n_neighbors=min(k, len(t_sub)), metric="euclidean")
    nn.fit(t_scaled)
    distances, indices = nn.kneighbors(x_scaled)

    neighbor_labels = train_y[indices[0]]
    return {
        "pred_bp": round(float(np.mean(neighbor_labels)), 2),
        "pred_p25": round(float(np.percentile(neighbor_labels, 25)), 2),
        "pred_p75": round(float(np.percentile(neighbor_labels, 75)), 2),
        "knn_distances": distances[0].tolist(),
        "knn_labels": neighbor_labels.tolist(),
        "n_neighbors": len(indices[0]),
    }


def predict_with_ood_check(
    x_vec: np.ndarray,
    feat_names: list[str],
    v2_model_info: dict,
    use_knn_threshold: float = 0.15,
    knn_k: int = 15,
) -> dict:
    """
    P2+P3 联合预测：分离模型预测 + OOD 检测 + KNN 降级混合。

    x_vec / feat_names 均为完整市场特征（含市场+日历），
    内部按 v2_model_info 的 indices 自动拆分。
    """
    mkt_indices = v2_model_info["market_feat_indices"]
    cal_indices = v2_model_info["calendar_feat_indices"]
    mkt_feat_names = v2_model_info["market_feat_names_only"]

    pred_market = float(
        v2_model_info["market_model"].predict(x_vec[mkt_indices].reshape(1, -1))[0]
    )
    pred_calendar = float(
        v2_model_info["calendar_model"].predict(x_vec[cal_indices].reshape(1, -1))[0]
    )
    pred_model = pred_market + pred_calendar

    ood_info = check_ood(x_vec, feat_names, v2_model_info["feature_ranges"])

    pred_source = "model"
    knn_info = None

    if ood_info["ood_ratio"] > use_knn_threshold:
        knn_info = knn_fallback_predict(
            x_vec[mkt_indices],
            v2_model_info["train_X_mkt"],
            v2_model_info["train_y"],
            mkt_feat_names,
            train_feat_names_subset=mkt_feat_names,
            k=knn_k,
        )
        knn_weight = min(ood_info["ood_ratio"] * 2, 0.8)
        final_pred = (1 - knn_weight) * pred_model + knn_weight * knn_info["pred_bp"]
        pred_source = "blended" if knn_weight < 0.8 else "knn"
    else:
        final_pred = pred_model

    if knn_info is not None:
        interval = (knn_info["pred_p25"], knn_info["pred_p75"])
    else:
        residual_std = float(
            np.std(v2_model_info["train_y"] - v2_model_info["train_preds"])
        )
        interval = (
            round(final_pred - residual_std, 2),
            round(final_pred + residual_std, 2),
        )

    return {
        "pred_bp": round(final_pred, 2),
        "pred_market": round(pred_market, 2),
        "pred_calendar": round(pred_calendar, 2),
        "ood_info": ood_info,
        "pred_source": pred_source,
        "confidence": ood_info["confidence"],
        "knn_info": knn_info,
        "pred_interval": interval,
    }
