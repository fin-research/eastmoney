# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
import importlib.util
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


def module(name, file):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / file)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


organize = module("organize", "organize-credit-materials.py")


class CreditMaterialsTest(unittest.TestCase):
    def test_organization_keeps_names_and_is_idempotent(self):
        for source in [
            "公司债券2025年度报告.pdf",
            "财务报表/25Q1-合并财务报表.xlsx",
            "授信资料反馈/青岛银行/评分.xlsx",
        ]:
            target = organize.destination(Path(source))
            self.assertEqual(target.name, Path(source).name)
            self.assertEqual(organize.destination(target), target)
        self.assertEqual(
            organize.destination(Path("公司债券2025年度报告.pdf")).parent.as_posix(),
            "定期报告/2025年度",
        )

    def test_confidentiality_directory_migration(self):
        mapping = {
            "定期报告与审计/2025年度/风险控制指标监管报表专项审计报告2025.pdf": "风控与监管指标/2025年/风险控制指标监管报表专项审计报告2025.pdf",
            "定期报告与审计/2025年度/公司2025年度审计报告.pdf": "定期报告/2025年度/公司2025年度审计报告.pdf",
            "风控与监管指标/历年汇总/监管指标.xlsx": "定期报告/财务与监管指标.xlsx",
            "风控与监管指标/历年汇总/风险控制指标统计201610-202601.xlsx": "风控与监管指标/历年汇总/风险控制指标统计201610-202601.xlsx",
        }
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source"
            for old, new in mapping.items():
                file = source / old
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_bytes(old.encode())
                self.assertEqual(organize.destination(Path(old)), Path(new))
                self.assertEqual(organize.destination(Path(new)), Path(new))
            organize.organize(source, Path(directory) / "migration.json", apply=True)
            for old, new in mapping.items():
                self.assertEqual((source / new).read_bytes(), old.encode())
            self.assertFalse((source / "定期报告与审计").exists())


if __name__ == "__main__":
    unittest.main()
