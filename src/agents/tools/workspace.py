"""작업 시작·범위·열 역할·문서·AI 의견 도구."""
from typing import Literal
from langchain_core.tools import tool
from services.operations.schemas import Operation, OperationOutput, Rule, RowFilter, ScopeRequest
from services.recommendation.service import resolve_advice_columns, resolve_advice_subject
from services.workspace import resolve_columns

def build_workspace_tools(task_context: dict):
    workspace = task_context.get("workspace")

    @tool
    def open_investigation() -> dict:
        """PDF의 조사 조건을 읽고 확인·수정하는 화면을 연다. 행 선별·셀 수정·조건 확정을 수행하지 않는다."""
        return {"intent": "investigation", "answer": "PDF 추출내용을 열었어요. 검토 시트에서 값을 수정한 뒤 채팅으로 ‘PDF 수정 내용 반영’이라고 요청하세요. PDF를 첨부하면 추출과 검토 시트 작성을 시작해요. 거래 행 선별은 아직 실행하지 않았어요."}


    @tool
    def start_task(
            task_type: Literal[
                "investigation", "model_normalization", "counterparty_cleanup", "formula"
            ],
            input_column_ids: list[str] | None = None,
            output: OperationOutput | None = None,
    ) -> dict:
        """새 업무를 시작하거나 수식·조건부 비교를 요청한다.
        A열의 마지막 단어가 B열에 있으면 추출하는 요청은 formula이며 두 입력 열 ID를 지정한다.
        현재 작업 시트가 있어도 사용자가 업무 전환을 명시하면 사용한다.
        같은 업무 안의 전처리, 치환, 분리 요청에는 사용하지 않는다."""
        if output:
            if task_type != "formula" or not workspace:
                raise ValueError("작업표의 수식 요청에만 저장 위치를 지정하세요.")
            output_ids = [v for v in [output.column_id, output.anchor] if v]
            if output_ids:
                resolve_columns(workspace, output_ids)
        answer = "작업할 범위를 선택하고 설정을 확인해 주세요."
        if task_type == "formula" and workspace:
            if not input_column_ids:
                raise ValueError("수식에 사용할 입력 열을 실제 열 ID로 지정하세요. 모호하면 ask_user로 확인하세요.")
            resolve_columns(workspace, input_column_ids)
            if len(input_column_ids) > 20:
                raise ValueError("수식 입력은 최대 20열입니다.")
            names = [next(column.get("header", column["column_id"]) for column in workspace["columns"]
                          if str(column["column_id"]) == column_id) for column_id in input_column_ids]
            answer = "작업표의 ‘" + " · ".join(names) + "’ 열을 찾아 현재 데이터 전체 행으로 수식을 준비합니다. Excel에서 열을 따로 선택할 필요는 없습니다. 적용 전에 결과를 확인해 주세요."
        elif input_column_ids is not None:
            raise ValueError("작업 표의 수식 요청에만 입력 열 ID를 지정하세요.")
        return {
            "intent": "start_task",
            "task_type": task_type,
            "formula_column_ids": input_column_ids,
            "formula_output": output.model_dump() if output else None,
            "operation": None,
            "answer": answer,
        }


    @tool
    def change_scope(mode: Literal["replace", "include", "exclude", "clear"],
                     column_id: str | None = None,
                     operator: Literal["equals", "not_equals", "contains", "blank", "not_blank"] = "equals",
                     value: str = "") -> dict:
        """작업 대상 범위만 변경한다. 셀 값이나 결과 열은 쓰지 않는다.
        현재 대상에 조건 일치 행 추가는 include, 그중 제외는 exclude, 새 조건으로 지정은 replace,
        전체 행으로 돌아가기는 clear다. 정확한 문자열·빈칸 조건만 받으며 기업 동일성을 추측하지 않는다."""
        if not workspace:
            raise ValueError("먼저 작업 시트를 준비하세요.")
        if mode == "clear":
            if column_id is not None or value or operator != "equals":
                raise ValueError("전체 행으로 돌아갈 때는 조건을 지정하지 마세요.")
            condition = None
        else:
            if column_id is None:
                raise ValueError("범위를 판단할 조건 열을 지정하세요.")
            resolve_columns(workspace, [column_id])
            condition = RowFilter(column_id=column_id, operator=operator, value=value)
        request = ScopeRequest(mode=mode, condition=condition)
        return {"intent": "scope", "scope_change": request.model_dump(),
                "answer": "현재 값을 읽어 작업 범위를 변경할게요. 셀 값은 바꾸지 않아요."}


    @tool
    def recommend_preprocessing(
            column_ids: list[str] | None = None,
            subject: Literal["company", "model"] | None = None,
    ) -> dict:
        """명시적인 AI 의견 요청. 기업/거래처는 company, 모델규격/품명은 model.
        사용자가 주제를 명시하면 subject에 전달하고, 미지정이면 대상 열의 역할로 판단한다."""
        subject = resolve_advice_subject(workspace, column_ids, subject)
        if subject is None:
            return {"intent": "clarify", "answer": "기업·거래처와 모델규격 중 어느 쪽의 AI 의견이 필요한가요? 대상 열도 알려주세요."}
        ids = resolve_advice_columns({**workspace, "advice_subject": subject}, column_ids)

        return {
            "intent": "recommendation",
            "advice_subject": subject,
            "task_type": None,
            "operation": None,
            "similarity": None,
            "analysis_column_ids": ids,
            "answer": "대상 열의 전체 데이터를 읽어 조언을 준비하겠습니다.",
        }


    @tool
    def set_column_role(column_id: str, role: Literal["reference", "country_code", "party_code", "company_name", "declared_name", "trade_name", "model_spec"]) -> dict:
        """사용자가 요청한 작업표 열의 역할을 지정한다. 셀 값은 변경하지 않는다."""
        resolve_columns(workspace, [column_id])
        return {"intent": "workspace_action", "workspace_action": {"type": "workspace_action", "column_id": column_id, "role": role}, "answer": "요청한 열 역할을 저장할게요."}


    @tool
    def review_document(document_id: str, action: Literal["apply", "retry", "preprocess"],
                        kind: Literal["supplier", "item", "other"] = "supplier", column: str = "회사명",
                        rules: list[Rule] = []) -> dict:
        """PDF 검토 시트의 수정 반영, 추출 재시도, 전처리를 채팅에서 준비한다.
        document_id는 조사 문서 목록의 실제 ID다. preprocess는 supplier(거래처)/item(품목)/other(기타)와 열 이름,
        요청한 전처리 규칙을 지정한다. 예: supplier 회사명, item 규격. 적용 전에 채팅 확인을 거친다."""
        documents = (task_context.get("investigation") or {}).get("documents", [])
        if not any(str(item.get("document_id")) == document_id for item in documents):
            raise ValueError("현재 조사에 첨부한 PDF를 지정하세요.")
        if action == "preprocess":
            Operation(kind="preprocess", column_ids=["review-column"], rules=rules).validate_ready()
        return {"intent": "document", "document_action": {"type": "document_action", "action": action, "document_id": document_id,
                "kind": kind, "column": column, "rules": [Rule.model_validate(r).model_dump() for r in rules]},
                "answer": "PDF 검토 작업을 준비할게요. 아직 수정 내용을 적용하지 않았어요."}


    return {item.name: item for item in [
        open_investigation, start_task, change_scope, recommend_preprocessing, set_column_role, review_document
    ]}
