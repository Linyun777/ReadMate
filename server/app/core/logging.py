"""日志配置。

Phase 0 只做标准库 logging 的最小配置；结构化日志与请求追踪在后续阶段按需加入。
"""

import logging


def configure_logging(level: int = logging.INFO) -> None:
    logging.basicConfig(
        level=level,
        format="%(asctime)s %(levelname)-8s %(name)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
