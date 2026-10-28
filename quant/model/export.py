"""冻结研究保留的导入路径；序列化实现由 artifacts 统一维护。"""

from artifacts import export_tree as _tree, write_json

__all__ = ["_tree", "write_json"]
