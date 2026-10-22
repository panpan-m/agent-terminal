"""Platform helpers (paths, service integration)."""

from .paths import (
    default_data_dir,
    default_log_dir,
    executable_suffix,
    is_windows,
    python_executable,
)

__all__ = [
    "default_data_dir",
    "default_log_dir",
    "executable_suffix",
    "is_windows",
    "python_executable",
]
