from typing import Literal
from services.chat.actions import DocumentAction, WorkspaceAction, FormulaOutputAction

from pydantic import BaseModel, ConfigDict, Field, ValidationInfo, model_validator

from services.errors import SHARED_MESSAGES
from agents.request_graph import run_request_graph
from services.operations.schemas import Operation, ScopeRequest
from services.formula.schemas import FormulaOutput
from services.chat.state import TaskType
from services.similarity import SimilaritySettings
from services.group_review import GroupReviewRequest
from services.recommendation.service import resolve_advice_columns, resolve_advice_subject
from services.workspace import resolve_columns


class RequestDecision(BaseModel):
    model_config = ConfigDict(extra="forbid")
    intent: Literal["general", "start_task", "clarify", "task_followup", "operation", "similarity", "recommendation", "cleaning_help", "group_review", "investigation", "scope", "agent", "workspace_action", "document", "formula_output"]
    document_action: DocumentAction | None = None
    workspace_action: WorkspaceAction | None = None
    formula_output_action: FormulaOutputAction | None = None
    formula_output: FormulaOutput | None = None
    goal: str | None = Field(default=None, min_length=1, max_length=8000)
    resume_agent: bool = False
    code_grouping_request: str | None = Field(default=None, min_length=1, max_length=8000)
    task_type: TaskType | None = None
    operation: Operation | None = None
    similarity: SimilaritySettings | None = None
    group_review_request: GroupReviewRequest | None = None
    scope_change: ScopeRequest | None = None
    formula_reference_sheets: list[str] | None = None
    formula_instruction: str | None = Field(default=None, min_length=1, max_length=8000)
    formula_column_ids: list[str] | None = Field(default=None, min_length=1, max_length=20)
    answer: str = Field(min_length=1, max_length=8000)
    advice_subject: Literal["company", "model"] | None = None
    analysis_column_ids: list[str] | None = Field(default=None, max_length=200)

    @model_validator(mode="after")
    def validate_decision(self, info: ValidationInfo):
        if self.code_grouping_request is not None and (self.intent != "agent" or self.resume_agent):
            raise ValueError("대표 부호 연결 지시는 새 조사 목표에만 지정하세요.")
        for intent, payload in [("document", self.document_action), ("workspace_action", self.workspace_action), ("formula_output", self.formula_output_action)]:
            if (self.intent == intent) != (payload is not None):
                raise ValueError("요청 종류와 실행 설정이 일치하지 않습니다.")
        if self.formula_output is not None and (self.intent != "start_task" or self.task_type != "formula"):
            raise ValueError("수식 작업에만 수식 저장 위치를 지정하세요.")
        if self.intent == "agent":
            if bool(self.goal) == self.resume_agent:
                raise ValueError("새 목표 또는 기존 목표 재개 중 하나만 지정하세요.")
        elif self.goal is not None or self.resume_agent:
            raise ValueError("조사 실행에만 목표를 지정하세요.")
        if (self.intent == "scope") != (self.scope_change is not None):
            raise ValueError("작업 범위 요청에는 범위 변경 조건을 지정하세요.")
        if self.group_review_request is not None and self.intent != "group_review":
            raise ValueError("묶음 검토 요청에만 기준값과 표시 설정을 지정하세요.")
        if not self.answer.strip():
            raise ValueError("답변이 비어 있습니다.")
        # 현재 작업의 업무 종류를 중복 기재한 경우만 생략한다.
        if (self.intent == "operation" and self.task_type is not None
                and self.task_type == (info.context or {}).get("workspace_task_type")):
            self.task_type = None
        if self.formula_instruction is not None and (self.intent != "start_task" or self.task_type != "formula"):
            raise ValueError("수식 작업에만 수식 지시를 지정하세요.")
        if self.formula_column_ids is not None and (self.intent != "start_task" or self.task_type != "formula"):
            raise ValueError("수식 작업에만 formula_column_ids를 지정하세요.")
        if self.intent == "start_task" and self.task_type is None:
            raise ValueError("작업 시작에는 작업 종류가 필요합니다.")
        if self.intent != "start_task" and self.task_type is not None:
            raise ValueError("새 작업 시작 외에는 task_type을 null로 반환해야 합니다.")
        if self.intent == "operation" and self.operation is None:
            raise ValueError("연산 요청에는 연산 설정이 필요합니다.")
        if self.intent != "operation" and self.operation is not None:
            raise ValueError("연산 요청 외에는 operation을 null로 반환해야 합니다.")
        if self.intent == "similarity" and self.similarity is None:
            raise ValueError("유사도 요청에는 검사 설정이 필요합니다.")
        if self.intent != "similarity" and self.similarity is not None:
            raise ValueError("유사도 요청 외에는 similarity를 null로 반환해야 합니다.")
        if self.intent == "recommendation" and len(self.answer) > 6000:
            raise ValueError("추천 설명은 6,000자 이내로 작성하세요.")
        if self.intent in {"cleaning_help", "group_review"} and self.analysis_column_ids is not None and len(self.analysis_column_ids) != 1:
            raise ValueError("정제 도움의 초기 대상은 한 열만 지정하세요.")
        if self.intent not in {"recommendation", "cleaning_help", "group_review"} and self.analysis_column_ids is not None:
            raise ValueError("조언·정제 도움 요청 외에는 analysis_column_ids를 지정할 수 없습니다.")
        return self


async def route_request(runtime, messages, *, task_context: dict, log_context=None, pdf_documents=None):
    workspace = task_context.get("workspace")
    validation_context = {
        "workspace_task_type": (
            workspace.get("task_type") if workspace else None
        ),
    }

    result = await run_request_graph(runtime, messages, task_context, log_context=log_context, pdf_documents=pdf_documents)
    decision = RequestDecision.model_validate(result, context=validation_context)
    reasons = []

    if decision.intent == "start_task" and decision.task_type == "formula":
        if workspace:
            if not decision.formula_column_ids:
                return RequestDecision(intent="clarify", answer="수식에 사용할 열을 알려주세요. 비교할 열이 있다면 함께 지정해 주세요."), reasons
            resolve_columns(workspace, decision.formula_column_ids)
        elif decision.formula_column_ids is not None:
            raise ValueError("수식 입력 열을 연결할 작업 표가 없습니다.")

    if decision.operation:
        if not workspace:
            raise ValueError(SHARED_MESSAGES["WORKSPACE_SETUP_REQUIRED"])

        columns = {
            column["column_id"]
            for column in workspace["columns"]
        }
        referenced = decision.operation.input_column_ids + ([decision.operation.destination_column_id] if decision.operation.destination_column_id else [])
        if decision.operation.output:
            referenced += [value for value in [decision.operation.output.column_id, decision.operation.output.score_column_id, decision.operation.output.anchor] if value]
        if not set(referenced) <= columns:
            raise ValueError("현재 작업 시트에 없는 열을 요청했습니다.")

    if decision.scope_change:
        if not workspace:
            raise ValueError(SHARED_MESSAGES["WORKSPACE_SETUP_REQUIRED"])
        if decision.scope_change.condition:
            resolve_columns(workspace, decision.scope_change.condition.column_ids)
        from services.investigation.bindings import bind_scope
        bind_scope(decision.scope_change, task_context.get("investigation"))

    if decision.similarity:
        decision.similarity.check_workspace(workspace)

    if decision.intent == "task_followup" and not (
        workspace or task_context.get("active_formula_job")
    ):
        raise ValueError("후속 질문을 연결할 현재 작업이 없습니다.")

    if decision.intent in {"cleaning_help", "group_review"} and decision.analysis_column_ids is not None:
        resolve_columns(workspace, decision.analysis_column_ids)

    if decision.intent == "recommendation":
        if not workspace:
            return RequestDecision(
                intent="clarify",
                answer="먼저 분석할 작업 시트를 준비해 주세요.",
            ), reasons

        subject = resolve_advice_subject(workspace, decision.analysis_column_ids, decision.advice_subject)
        if subject is None:
            return RequestDecision(intent="clarify", answer="기업·거래처와 모델규격 중 어느 쪽의 AI 의견이 필요한가요?"), reasons
        ids = resolve_advice_columns({**workspace, "advice_subject": subject}, decision.analysis_column_ids)
        decision = decision.model_copy(update={
            "analysis_column_ids": ids, "advice_subject": subject,
            "answer": "대상 열의 전체 데이터를 읽어 조언을 준비하겠습니다.",
        })

    return decision, reasons
