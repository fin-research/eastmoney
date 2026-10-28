"""Restore an approved, frozen one-hidden-layer coupon model without fitting."""

import json
from pathlib import Path

import numpy as np

from .issuance_study_protocol import digest

METHOD = "relu_path_integrated_gradients"
POLICY = "user_selected_frozen_mlp"


def _verified_sources(sources):
    for source in sources.values():
        if digest(source["path"]) != source["sha256"]:
            raise ValueError("frozen MLP source checksum mismatch")
    root = Path(sources["inventory"]["path"]).resolve().parent
    inventory = json.loads(Path(sources["inventory"]["path"]).read_text())
    indexed = {item["path"]: item["sha256"] for item in inventory}
    for path, checksum in indexed.items():
        if digest(root / path) != checksum:
            raise ValueError("sealed MLP inventory mismatch")
    for name, source in sources.items():
        if name in ("summary", "inventory"):
            continue
        relative = Path(source["path"]).resolve().relative_to(root).as_posix()
        if indexed.get(relative) != source["sha256"]:
            raise ValueError("MLP source is absent from sealed inventory")
    return {
        name: json.loads(Path(sources[name]["path"]).read_text())
        for name in ("state", "receipt", "summary", "audit", "protocol")
    }


def _verify_audit(evidence, sources):
    audit = evidence["audit"]
    folds = [
        row["name"] for row in evidence["protocol"]["folds"] if row["status"] == "ready"
    ]
    suffixes = (
        "attempt.json",
        "state.json",
        "optimizer.json",
        "optimizer-raw.npz",
        "optimizer-raw.warnings.json",
        "receipt.json",
        "csv",
    )
    expected = {f"{fold}.{suffix}" for fold in folds for suffix in suffixes}
    if (
        audit.get("all_passed") is not True
        or audit.get("fit_calls") != 0
        or audit.get("states") != 6
        or len(audit.get("checks", [])) != 6
        or len(folds) != 6
        or {row["fold"] for row in audit["checks"]} != set(folds)
        or set(audit["artifacts"]) != expected
        or audit["protocol_sha256"] != sources["protocol"]["sha256"]
        or evidence["summary"]["independent_audit_sha256"] != sources["audit"]["sha256"]
    ):
        raise ValueError("frozen MLP independent audit mismatch")
    indexed = {
        item["path"]: item["sha256"]
        for item in json.loads(Path(sources["inventory"]["path"]).read_text())
    }
    for name, checksum in audit["artifacts"].items():
        if indexed.get("study/" + name) != checksum:
            raise ValueError("MLP audit artifact differs from sealed inventory")
    for source, receipt_key in (
        ("state", "state_sha256"),
        ("optimizer", "optimizer_sha256"),
        ("optimizer_raw", "optimizer_raw_sha256"),
        ("optimizer_warnings", "optimizer_warnings_sha256"),
        ("predictions", "predictions_sha256"),
    ):
        name = Path(sources[source]["path"]).name
        if (
            evidence["receipt"][receipt_key] != sources[source]["sha256"]
            or audit["artifacts"].get(name) != sources[source]["sha256"]
        ):
            raise ValueError("MLP receipt or audit source linkage mismatch")


class FrozenMLP:
    def __init__(self, state):
        self.state = state
        prep = state["preprocessing"]
        self.fill, self.center, self.scale = (
            np.asarray(prep[key], dtype=float) for key in ("fill", "center", "scale")
        )
        self.w0, self.w1 = (np.asarray(x, dtype=float) for x in state["coefs"])
        self.b0, self.b1 = (np.asarray(x, dtype=float) for x in state["intercepts"])
        self.mean = float(state["target_mean_bp"])
        self.target_scale = float(state["target_scale_bp"])
        n = len(prep["feature_names"])
        shapes = (
            self.fill.shape == self.center.shape == self.scale.shape == (n,)
            and self.w0.shape == (n, 8)
            and self.w1.shape == (8, 1)
            and self.b0.shape == (8,)
            and self.b1.shape == (1,)
        )
        arrays = (
            self.fill,
            self.center,
            self.scale,
            self.w0,
            self.w1,
            self.b0,
            self.b1,
        )
        if (
            not shapes
            or not all(np.isfinite(x).all() for x in arrays)
            or not np.isfinite([self.mean, self.target_scale]).all()
            or not (self.scale > 0).all()
            or self.target_scale <= 0
            or state["settings"]["activation"] != "relu"
        ):
            raise ValueError("invalid frozen MLP dimensions or parameters")

    def transformed(self, matrix):
        values = np.asarray(matrix, dtype=float)
        return (
            np.where(np.isnan(values), self.fill, values) - self.center
        ) / self.scale

    def predict(self, matrix):
        z = self.transformed(matrix)
        hidden = np.maximum(0, z @ self.w0 + self.b0)
        return (hidden @ self.w1 + self.b1).ravel() * self.target_scale + self.mean

    def contributions(self, matrix):
        """Exact straight-path integrated gradients from standardized zero."""
        z = self.transformed(matrix)
        delta = z @ self.w0
        end = self.b0 + delta
        # Fraction of the path where each ReLU is active; no subtraction of
        # almost equal activations. A zero path at the kink contributes zero.
        fraction = np.zeros_like(delta)
        fraction[(self.b0 > 0) & (end > 0)] = 1.0
        rising = (self.b0 <= 0) & (end > 0)
        falling = (self.b0 > 0) & (end <= 0)
        fraction[rising] = end[rising] / delta[rising]
        start = np.broadcast_to(self.b0, delta.shape)
        fraction[falling] = -start[falling] / delta[falling]
        slopes = (fraction * self.w1.ravel()) @ self.w0.T
        values = self.target_scale * z * slopes
        base = self.mean + self.target_scale * float(
            (np.maximum(0, self.b0) @ self.w1 + self.b1)[0]
        )
        return np.column_stack((values, np.full(len(z), base)))


def load_frozen_release(path):
    value = json.loads(Path(path).read_text())
    if (
        value.get("release_policy") != POLICY
        or value.get("adoption", {}).get("authorized_by") != "user"
        or value.get("training_label_cutoff") != "2026-01-01"
        or value.get("forecast_horizons") != [1, 14, 30]
        or value.get("expected_savings_supported") is not False
        or value.get("issuance_scope") != "public_only"
        or value.get("candidate")
        != dict(
            kind="mlp",
            target="coupon",
            years=0,
            profile=0,
            feature_set="quote_history",
            lead_policy="uniform",
            market_change="none",
        )
    ):
        raise ValueError("invalid frozen MLP release identity")
    sources = value["sources"]
    evidence = _verified_sources(sources)
    _verify_audit(evidence, sources)
    state, receipt, summary = (
        evidence[name] for name in ("state", "receipt", "summary")
    )
    if (
        state["protocol_sha256"] != sources["protocol"]["sha256"]
        or receipt["state_sha256"] != sources["state"]["sha256"]
        or receipt["protocol_sha256"] != state["protocol_sha256"]
        or state["training_cutoff"] != value["training_label_cutoff"]
        or state["training_label_end"] >= state["training_cutoff"]
        or state["settings"] != evidence["protocol"]["settings"]
        or summary["inventory_sha256"] != sources["inventory"]["sha256"]
        or value["metrics"]
        != [{**row, "year": 2026} for row in summary["validation"]["metrics"]]
        or value["training_tscv"] != summary["tscv"]
    ):
        raise ValueError("frozen MLP release differs from sealed evidence")
    FrozenMLP(state)
    return value


def restore_frozen_model(evaluation):
    from .issuance_unified import CouponCandidate, CouponModel

    source = evaluation["sources"]["state"]
    if digest(source["path"]) != source["sha256"]:
        raise ValueError("frozen MLP state checksum mismatch")
    state = json.loads(Path(source["path"]).read_text())
    model = CouponModel(CouponCandidate(**evaluation["candidate"]))
    for key in ("numeric", "categories", "feature_names"):
        setattr(model, key, state["preprocessing"][key])
    model.estimator = FrozenMLP(state)
    model.audit = {
        "training_as_of": state["training_cutoff"],
        "training_label_cutoff": state["training_cutoff"],
        "training_label_end": state["training_label_end"],
        "events": state["training_events"],
        "rows": state["training_requests"],
        "estimand": "conditional_mean",
        "issuance_scope": evaluation["issuance_scope"],
        "loss": "weighted_l2",
        "source_state_sha256": source["sha256"],
        "source_protocol_sha256": state["protocol_sha256"],
        "restored_without_fit": True,
        "attribution_method": METHOD,
    }
    return model
