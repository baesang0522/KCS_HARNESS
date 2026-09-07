from pathlib import Path

import yaml
from pydantic import BaseModel, ConfigDict, Field

CONFIG_PATH = Path(__file__).with_name("config.yml")


class LLMSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")

    base_url:str
    model:str
    api_key:str = "not-needed"
    temperature:float = Field(default=0.1, ge=0, le=2)
    timeout_seconds: float = Field(default=120, gt=0)
    max_tokens: int = Field(default=2048, gt=0)
    max_retries: int = Field(default=2, ge=0)


class MCPSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")
    server_url: str = ""
    timeout_seconds: float = Field(default=30, gt=0)


class AgentSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")

    max_iterations: int = Field(default=5, gt=0)
    verbose: bool = True


class WorkspaceSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")
    root_path: str = "."


class Settings(BaseModel):
    model_config = ConfigDict(extra="forbid")

    llm: LLMSettings
    mcp: MCPSettings = MCPSettings()
    agent: AgentSettings = AgentSettings()
    workspace: WorkspaceSettings = WorkspaceSettings()


def load_settings() -> Settings:
    with CONFIG_PATH.open(mode="r", encoding="utf-8") as config_file:
        config_data = yaml.safe_load(config_file)
    if not isinstance(config_data, dict):
        raise ValueError(
            "config.yml의 최상위 값은 객체 형식이어야 합니다."
        )
    return Settings.model_validate(config_data)