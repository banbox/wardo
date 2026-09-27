"""Convenience launcher for machines that do not have Node.js installed."""
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parent / "python"))
from wardo import main  # noqa: E402

if __name__ == "__main__":
    main()
