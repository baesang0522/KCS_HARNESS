from pathlib import Path

import yaml
from pydantic import BaseModel, ConfigDict, Field


PROMPT_PATH = Path(__file__).with_name("agent.yml")


class AgentPrompt(BaseModel):
    model_config = ConfigDict(extra="forbid")

    version: int = Field(ge=1)
    system: str = Field(min_length=1)
    tool_rules: str = ""

    def render(self) -> str:
        prompt_parts = [
            self.system.strip(),
            self.tool_rules.strip()
        ]

        return "\n\n".join(part for part in prompt_parts if part)


def load_agent_prompt(prompt_path: Path = PROMPT_PATH) -> AgentPrompt:
    with prompt_path.open(mode="r", encoding="utf-8") as prompt_file:
        prompt_data = yaml.safe_load(prompt_file)

    if not isinstance(prompt_data, dict):
        raise ValueError("agent.yml의 최상위 값은 객체 형식이어야 합니다.")

    return AgentPrompt.model_validate(prompt_data)









