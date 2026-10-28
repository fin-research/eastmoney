ALTER TABLE financing_model.model_run
  ADD COLUMN model_sample_count integer,
  ADD COLUMN model_sample_start_date date,
  ADD COLUMN model_sample_end_date date;

ALTER TABLE financing_model.model_run
  ADD CONSTRAINT financing_model_model_sample_range_check CHECK (
    (
      model_sample_count IS NULL AND
      model_sample_start_date IS NULL AND
      model_sample_end_date IS NULL
    ) OR
    (
      model_sample_count > 0 AND
      model_sample_start_date IS NOT NULL AND
      model_sample_end_date IS NOT NULL AND
      model_sample_start_date <= model_sample_end_date
    )
  );

COMMENT ON COLUMN financing_model.model_run.model_sample_count IS
  '最终逐笔预测模型实际使用的完整有效发行样本量';
COMMENT ON COLUMN financing_model.model_run.model_sample_start_date IS
  '最终逐笔预测模型完整有效样本的最早发行日';
COMMENT ON COLUMN financing_model.model_run.model_sample_end_date IS
  '最终逐笔预测模型完整有效样本的最晚发行日';
