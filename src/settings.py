import os
from pathlib import Path
from typing import Literal

import yaml
from pydantic import BaseModel, ConfigDict, Field

CONFIG_PATH = Path(__file__).with_name("config.yml")


class StorageSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")

    provider: Literal["memory", "postgres"]
    url_env: str = "여기다 url 주소 입력"


class LLMSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")

    provider: Literal["openai_compatible", "codex_cli"]
    base_url:str = ""
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

    environment: Literal["external", "internal"]
    llm: LLMSettings
    storage: StorageSettings

    mcp: MCPSettings = Field(default_factory=MCPSettings)
    agent: AgentSettings = Field(default_factory=AgentSettings)
    workspace: WorkspaceSettings = Field(default_factory=WorkspaceSettings)


def load_settings() -> Settings:
    environment = os.environ.get("KCS_ENV", "").strip().lower()

    if environment not in {"external", "internal"}:
        raise ValueError(
            "KCS_ENV를 external 또는 internal로 지정하세요."
        )

    with CONFIG_PATH.open(mode="r", encoding="utf-8") as config_file:
        config_data = yaml.safe_load(config_file)

    if not isinstance(config_data, dict):
        raise ValueError(
            "config.yml의 최상위 값은 객체 형식이어야 합니다."
        )

    allowed_keys = {"workspace", "mcp", "agent", "environments"}
    unknown_keys = set(config_data) - allowed_keys
    if unknown_keys:
        raise ValueError(
            f"config.yml에 알 수 없는 설정이 있습니다: {unknown_keys}"
        )

    environments = config_data.get("environments")
    if not isinstance(environments, dict):
        raise ValueError("environments 설정이 필요합니다.")

    selected = environments.get(environment)
    if not isinstance(selected, dict):
        raise ValueError(
            f"environments.{environment} 설정이 필요합니다."
        )

    if set(selected) != {"llm", "storage"}:
        raise ValueError(
            f"environments.{environment}에는 "
            "llm과 storage를 지정해야 합니다."
        )

    merged = {
        key: value
        for key, value in config_data.items()
        if key != "environments"
    }
    merged.update(selected)
    merged["environment"] = environment

    settings = Settings.model_validate(merged)

    if not settings.llm.model.strip():
        raise ValueError("llm.model이 비어 있습니다.")

    if (
        settings.llm.provider == "openai_compatible"
        and not settings.llm.base_url.strip()
    ):
        raise ValueError(
            "openai_compatible 모델에는 llm.base_url이 필요합니다."
        )

    return settings