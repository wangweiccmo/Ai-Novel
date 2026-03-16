from __future__ import annotations

from typing import Annotated

from pydantic import Field

LLMProvider = Annotated[str, Field(min_length=1, max_length=64)]
