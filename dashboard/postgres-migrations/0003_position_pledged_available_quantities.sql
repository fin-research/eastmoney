ALTER TABLE bond.daily_position
  ADD COLUMN pledged_quantity numeric(30, 10),
  ADD COLUMN available_quantity numeric(30, 10),
  ADD CONSTRAINT daily_position_availability_check CHECK (
    (pledged_quantity IS NULL AND available_quantity IS NULL)
    OR (
      pledged_quantity IS NOT NULL AND available_quantity IS NOT NULL
      AND pledged_quantity >= 0 AND available_quantity >= 0
      AND abs(pledged_quantity + available_quantity - current_quantity) <= 0.000001
    )
  );

COMMENT ON COLUMN bond.daily_position.pledged_quantity IS
  '今日质押量，单位张；旧台账未提供时为 NULL，面值金额按每张100元计算';
COMMENT ON COLUMN bond.daily_position.available_quantity IS
  '今日可用量，单位张；旧台账未提供时为 NULL，面值金额按每张100元计算';
