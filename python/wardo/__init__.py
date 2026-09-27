"""Python runtime for Wardo.

The module mirrors the TypeScript public API while keeping the runtime dependency-free.
HTTP calls use urllib; optional PyYAML is used when available for richer YAML configs.
"""
from .core import *
