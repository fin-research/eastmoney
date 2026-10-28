"""发行票面模型的训练导出与跨运行时推理，不再生成相对利差快照。"""

import json
import os
import subprocess
from pathlib import Path


from data.online_inputs import ISSUANCE_INPUT_GROUPS, fetch_inputs
from model.export import write_json
from .forecast import run_issuance_forecast

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_TERMS = {
    "issuer": "东方财富证券股份有限公司",
    "rating": "AAA",
    "tenor": 3.0,
    "bond_type": "证券公司债",
}


def run_online(
    mode,
    directory,
    as_of,
    input_path=None,
    *,
    terms=None,
    days=30,
    size=30.0,
    evaluation_directory=None,
    coupon_selection=None,
):
    if input_path is None and os.environ.get("QUANT_CHECKPOINT_RESTART") == "1":
        pinned = os.environ.get("QUANT_FROZEN_INPUT_PATH")
        input_path = Path(pinned) if pinned else None
    manifest = (
        json.loads((directory / "manifest.json").read_text())
        if mode == "infer"
        else None
    )
    if manifest:
        from model.release_eligibility import require_active_model

        require_active_model(manifest.get("model_version"))
    elif mode == "train":
        from model.release_eligibility import load_active_release

        load_active_release(coupon_selection)
    groups = (
        tuple(manifest["required_input_groups"])
        if manifest
        else (*ISSUANCE_INPUT_GROUPS, "industry_nodes")
    )
    inputs = (
        json.loads(input_path.read_text())
        if input_path
        else fetch_inputs(as_of, groups=groups)
    )
    if manifest:
        scope = manifest.get("issuance_scope", "all")
        if inputs.get("issuance_scope", scope) != scope:
            raise ValueError("input and manifest issuance scope mismatch")
        inputs["issuance_scope"] = scope
    if inputs["as_of_date"] != as_of:
        raise ValueError("Input snapshot date does not match --as-of")
    directory.mkdir(parents=True, exist_ok=True)
    input_file = directory / "inputs.json"
    write_json(input_file, inputs)
    del inputs
    if mode == "train":
        train_bundle(
            input_file,
            directory,
            as_of,
            terms or DEFAULT_TERMS,
            days,
            size,
            evaluation_directory,
            coupon_selection,
        )
    request_file = directory / "request.json"
    write_json(
        request_file,
        {"terms": terms or DEFAULT_TERMS, "window_days": days, "issue_size_yi": size},
    )
    subprocess.run(
        [
            "node",
            str(ROOT / "online/cli.mjs"),
            str(directory),
            str(input_file),
            str(request_file),
        ],
        check=True,
        cwd=ROOT,
    )
    return json.loads((directory / "result.json").read_text())


def train_bundle(
    path,
    directory,
    as_of,
    terms,
    days,
    size,
    evaluation_directory,
    coupon_selection=None,
):
    import shutil

    run_issuance_forecast(
        directory,
        as_of,
        days,
        path,
        terms,
        issue_size=size,
        evaluation_directory=evaluation_directory,
        coupon_selection=coupon_selection,
    )
    for file in (directory / "online").iterdir():
        if file.is_file():
            shutil.copy2(file, directory / file.name)
    manifest = json.loads((directory / "manifest.json").read_text())
    print(f"Exported unified coupon model {manifest['model_version']}")
    return manifest
