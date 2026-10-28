"""退役本地上传边界；生产只由归档 Workflow 原子发布。"""


def upload_financing_model_snapshot(snapshot, database_url=None):
    raise RuntimeError(
        "本地模型上传已退役；请使用已核验的 BondInferenceWorkflow "
        "及 financing_model.publish_online_result 发布归档结果。"
    )
