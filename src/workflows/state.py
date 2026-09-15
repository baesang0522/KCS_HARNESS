from dataclasses import dataclass
from typing import Literal


TaskType = Literal[
    "model_normalization",
    "counterparty_cleanup",
    "formula"
]

@dataclass()
class WorkFlowState:
    pending_intent: str | None = None # 정제 종류가 명확해 지기 전의 원래 요청
    active_job_id: str | None = None # 현재 대화와 연결된 작업 아이디
    task_type: TaskType | None = None # 어떤 종류의 task인지

    phase: Literal[ # 대화가 어느 입력단계에 있는지
        "IDLE",
        "WAITING_TASK_TYPE",
        "WAITING_SELECTION",
        "JOB_ATTACHED",
    ] = "IDLE"



