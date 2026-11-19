"""Goal execution reuses the manual tools; reads return evidence instead of a card."""
from langchain_core.tools import tool
from services.agent_runs import ReadAction
from services.operations.schemas import RowFilter, OperationOutput
from services.similarity import SimilaritySettings
from services.recommendation.service import resolve_columns


def execution_tools(context, manual_tools):
    workspace = context["workspace"]

    @tool
    def read_workspace(column_ids: list[str], condition: RowFilter | None = None) -> dict:
        """현재 작업 범위의 실제 값을 읽는다. condition은 현재 범위 안에서 추가로 적용한다.
        전체 일치 행을 읽어 값 조합별 건수·첫 실제 행을 반환한다. 셀과 저장 범위는 변경하지 않는다."""
        resolve_columns(workspace, column_ids)
        if condition:
            resolve_columns(workspace, [condition.column_id])
        action = ReadAction(column_ids=column_ids, condition=condition)
        return {"intent": "read", "read": action.model_dump(), "answer": "현재 범위의 실제 값을 읽고 있습니다."}

    @tool
    def compare_values(settings: SimilaritySettings, condition: RowFilter | None = None) -> dict:
        """현재 범위에서 기존 유사도 계산을 실행한다. 기준값은 실제 값이어야 한다.
        점수는 후보 비교일 뿐 기업 동일성·최종 판단이 아니다. 방법이 모호하면 질문한다.
        기존 200자·50,000쌍·계산 5초 한도 초과는 생략 없이 오류로 알린다."""
        settings.check_workspace(workspace)
        if condition:
            resolve_columns(workspace, [condition.column_id])
        action = ReadAction(column_ids=settings.input_column_ids, condition=condition, similarity=settings)
        return {"intent": "read", "read": action.model_dump(), "answer": "현재 범위의 값을 읽어 유사도를 비교합니다."}

    @tool
    async def calculate_formula(instruction: str, input_column_ids: list[str], output: OperationOutput | None = None) -> dict:
        """이번 단계의 구체적인 수식 계산 지시와 입력 열을 채팅 미리보기·확인으로 넘긴다.
        전체 조사 목표를 그대로 넘기지 않는다. 조건 범위 수식의 기존 차단은 유지한다."""
        if not instruction.strip() or len(instruction) > 8000:
            raise ValueError("이번 수식 계산 지시를 구체적으로 작성하세요.")
        start = next(item for item in manual_tools if item.name == "start_task")
        result = await start.ainvoke({"task_type": "formula", "input_column_ids": input_column_ids, "output": output.model_dump() if output else None})
        result["formula_instruction"] = instruction
        return result

    # Keep the existing preview/approval path; unsupported domain tools are not invented here.
    names = {"ask_user", "answer_question", "change_scope", "update_matching_rows",
             "remove_words", "preprocess", "replace_text", "split_text", "map_values", "group_values",
             "find_model_candidates"}
    return [item for item in manual_tools if item.name in names] + [read_workspace, compare_values, calculate_formula]
