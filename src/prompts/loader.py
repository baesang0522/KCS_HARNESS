from pathlib import Path

import yaml
from pydantic import BaseModel, ConfigDict, Field


class AgentPrompt(BaseModel):
    model_config = ConfigDict(extra="forbid")

    version: int = Field(ge=1)
    system: str = Field(min_length=1)

    def render(self) -> str:
        return self.system.strip()


def load_agent_prompt(prompt_path: Path) -> AgentPrompt:
    with prompt_path.open(mode="r", encoding="utf-8") as prompt_file:
        prompt_data = yaml.safe_load(prompt_file)

    if not isinstance(prompt_data, dict):
        raise ValueError(f"{prompt_path.name}의 최상위 값은 객체 형식이어야 합니다.")

    return AgentPrompt.model_validate(prompt_data)
