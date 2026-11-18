from pydantic import BaseModel, ConfigDict, Field


class GroupReviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    match_text: str | None = Field(default=None, min_length=1, max_length=200)
    output_name: str | None = Field(default=None, min_length=1, max_length=200)
    assigned_value: str | None = Field(default=None, max_length=32767)
