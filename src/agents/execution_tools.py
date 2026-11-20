"""Goal execution reuses the manual tools; reads return evidence instead of a card."""
from langchain_core.tools import tool
from services.agent_runs.schemas import ReadAction
from services.errors import RepeatedReadError
from services.operations.schemas import RowFilter, OperationOutput
from services.similarity import SimilaritySettings
from services.workspace import resolve_columns


def execution_tools(context, manual_tools):
    workspace = context["workspace"]

    def read_decision(action, answer):
        spec = action.model_dump(mode="json")
        if any(item["read"] == spec for item in context.get("agent_run", {}).get("read_results", [])):
            raise RepeatedReadError(
                "동일한 열·조건의 조회/비교는 이미 완료됐습니다. agent_run.read_results의 실제 결과를 사용하세요. "
                "셀 변경은 아직 하지 않았습니다. 같은 조회 대신 남은 목표의 기존 변경 도구로 미리보기를 준비하거나 결과를 보고하세요. "
                "정보가 실제로 부족한 경우에만 구체적인 확인 질문을 하세요."
            )
        return {"intent": "read", "read": spec, "answer": answer}

    @tool
    def read_workspace(column_ids: list[str], condition: RowFilter | None = None) -> dict:
        """현재 작업 범위의 실제 값을 읽는다. condition은 현재 범위 안에서 추가로 적용한다.
        전체 일치 행을 읽어 값 조합별 건수·첫 실제 행을 반환한다. 셀과 저장 범위는 변경하지 않는다."""
        resolve_columns(workspace, column_ids)
        if condition:
            resolve_columns(workspace, [condition.column_id])
        action = ReadAction(column_ids=column_ids, condition=condition)
        return read_decision(action, "현재 범위의 실제 값을 읽고 있습니다.")

    @tool
    def compare_values(settings: SimilaritySettings, condition: RowFilter | None = None) -> dict:
        """현재 범위에서 기존 유사도 계산을 실행한다. 기준값은 실제 값이어야 한다.
        점수는 후보 비교일 뿐 기업 동일성·최종 판단이 아니다. 방법이 모호하면 질문한다.
        기존 200자·50,000쌍·계산 5초 한도 초과는 생략 없이 오류로 알린다."""
        settings.check_workspace(workspace)
        if condition:
            resolve_columns(workspace, [condition.column_id])
        action = ReadAction(column_ids=settings.input_column_ids, condition=condition, similarity=settings)
        return read_decision(action, "현재 범위의 값을 읽어 유사도를 비교합니다.")

    @tool
    async def apply_group_by_code(code_column_id: str, group_column_id: str, score_column_id: str,
                                  code: str, group: str) -> dict:
        """100점 행에서 확인한 대표 부호의 그룹을 현재 범위의 같은 부호 행에 바로 반영한다.
        사용자가 부호 기준 그룹 연결을 요청했을 때만 사용한다. 미리보기 표시·추가 승인을 기다리지 않는다.
        세 열을 score=100 조건으로 먼저 읽어야 한다. 상호·부호·점수와 저장된 작업 범위는 유지한다."""
        ids = [code_column_id, group_column_id, score_column_id]
        resolve_columns(workspace, ids)
        if len(set(ids)) != 3 or not code.strip() or not group.strip():
            raise ValueError("서로 다른 부호·그룹·점수 열과 빈칸이 아닌 대표값이 필요합니다.")
        evidence = next((item["result"] for item in reversed(context.get("agent_run", {}).get("read_results", []))
                         if item["read"]["condition"] == {"column_id": score_column_id, "operator": "equals", "value": "100"}
                         and item["read"]["similarity"] is None and set(ids) <= set(item["read"]["column_ids"])), None)
        if evidence is None:
            raise ValueError("부호·그룹·점수 열을 점수=100 조건으로 먼저 읽으세요.")
        positions = [evidence["column_ids"].index(key) for key in ids]
        mapping = {}
        for row in evidence["groups"]:
            key, label, score = [row["values"][index] for index in positions]
            if not key.strip() or not label.strip() or score != "100" or key in mapping and mapping[key] != label:
                raise ValueError("100점 대표값에 빈 부호·그룹 또는 같은 부호의 그룹 충돌이 있습니다. 확인이 필요합니다.")
            mapping[key] = label
        if mapping.get(code) != group:
            raise ValueError("요청한 부호와 그룹이 실제 100점 조회 결과와 다릅니다.")
        update = next(item for item in manual_tools if item.name == "update_matching_rows")
        result = await update.ainvoke(dict(condition_column_id=code_column_id, operator="equals", value=code,
                                          destination_column_id=group_column_id, assigned_value=group, scope="current"))
        result["intent"] = "apply_group"
        result["answer"] = "같은 부호의 그룹을 현재 작업 범위에 반영하고 있습니다."
        return result

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

    # Reuse existing operations; only verified representative-code propagation skips approval.
    names = {"ask_user", "answer_question", "change_scope", "update_matching_rows",
             "remove_words", "preprocess", "replace_text", "split_text", "map_values", "group_values",
             "find_model_candidates", "match_suppliers"}
    tools = [item for item in manual_tools if item.name in names] + [read_workspace, compare_values, calculate_formula]
    if context.get("agent_run", {}).get("code_grouping_request"):
        tools.append(apply_group_by_code)
    return tools
