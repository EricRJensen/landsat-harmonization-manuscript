"""Share a small parquet-query budget across HTTP request types."""
from __future__ import annotations

from functools import wraps
from threading import BoundedSemaphore
from typing import Callable, ParamSpec, TypeVar

_P = ParamSpec("_P")
_T = TypeVar("_T")
_parquet_slots = BoundedSemaphore(2)


def limit_parquet_queries(function: Callable[_P, _T]) -> Callable[_P, _T]:
    """Limit uncached scans, leaving lightweight requests free to run."""
    @wraps(function)
    def limited(*args: _P.args, **kwargs: _P.kwargs) -> _T:
        with _parquet_slots:
            return function(*args, **kwargs)

    return limited
