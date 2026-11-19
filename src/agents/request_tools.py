from typing import Literal
from langchain_core.tools import tool
from services.errors import SHARED_MESSAGES
from services.operations.schemas import Mapping, Operation, OperationOutput, Rule, RowFilter, ScopeRequest, extraction_column_id
from services.similarity import SimilaritySettings
from services.group_review import GroupReviewRequest
from services.recommendation.service import resolve_advice_columns, resolve_advice_subject, resolve_columns


def build_request_tools(task_context: dict):
    workspace = task_context.get("workspace")

    def prepare_operation(**settings) -> dict:
        if not workspace:
            raise ValueError("먼저 작업 시트를 준비해야 합니다.")

        operation = Operation.model_validate(settings)
        known_ids = {
            column["column_id"]
            for column in workspace["columns"]
        }
        referenced = operation.input_column_ids + ([operation.destination_column_id] if operation.destination_column_id else [])
        if operation.output:
            referenced += [value for value in [operation.output.column_id, operation.output.score_column_id, operation.output.anchor] if value]
            if operation.kind == "set" and operation.condition and (operation.output.mode != "existing" or operation.output.column_id != operation.destination_column_id):
                raise ValueError("조건부 변경은 지정한 기존 열에만 반영합니다. 다른 목적지에는 새 작업을 요청하세요.")
        if operation.kind != "extract" or operation.extraction_mode is not None:
            operation.validate_ready()
        if not set(referenced) <= known_ids:
            raise ValueError("현재 작업시트에 없는 열입니다.")

        return {
            "intent": "operation",
            "task_type": None,
            "operation": operation.model_dump(),
            "answer": (
                "현재 데이터로 변경 내용을 계산할게요. 채팅의 미리보기에서 저장 위치를 확인하고 적용해 주세요. "
                "아직 셀은 수정하지 않았습니다."
            ),
        }

    def target(column_id: str | None) -> str:
        if column_id is not None:
            return column_id

        ids = workspace.get("target_column_ids", []) if workspace else []
        if len(ids) != 1:
            raise ValueError("처리할 열 하나를 지정해 주세요")
        return ids[0]

    @tool
    def open_investigation() -> dict:
        """PDF의 조사 조건을 읽고 확인·수정하는 화면을 연다. 행 선별·셀 수정·조건 확정을 수행하지 않는다."""
        return {"intent": "investigation", "answer": "PDF 추출내용을 열었어요. 검토 시트에서 값을 수정한 뒤 채팅으로 ‘PDF 수정 내용 반영’이라고 요청하세요. PDF를 첨부하면 추출과 검토 시트 작성을 시작해요. 거래 행 선별은 아직 실행하지 않았어요."}

    @tool
    def answer_question(answer: str) -> dict:
        """일반 질문이나 사용법만 설명한다. 작업 설정, 실행 요청에는 사용하지 않는다."""
        answer = answer.strip()
        if not answer or len(answer) > 8000:
            raise ValueError("답변은 1~8,000자로 작성하세요.")
        return {
            "intent": "general",
            "task_type": None,
            "operation": None,
            "answer": answer,
        }

    @tool
    def ask_user(question: str) -> dict:
        """대상 열, 제거할 단어 등 필요한 정보가 부족하면 질문한다."""
        if not question.strip() or len(question) > 8000:
            raise ValueError("확인 질문은 1~8,000자로 작성하세요.")
        return {
            "intent": "clarify",
            "task_type": None,
            "operation": None,
            "answer": question,
        }

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

    def marking_review(column_id, match_text=None, output_name=None, assigned_value=None):
        ids = resolve_columns(workspace, [column_id]) if column_id is not None else None
        request = GroupReviewRequest(match_text=match_text, output_name=output_name, assigned_value=assigned_value)
        return {"intent": "group_review", "analysis_column_ids": ids, "group_review_request": request.model_dump(),
                "answer": "대상 행을 검토하는 화면을 준비했습니다. 현재 값을 불러와 필요한 후보를 선택한 뒤 확정·반영하세요. 아직 셀은 변경하지 않았습니다."}

    @tool
    def set_value(value: str, column_id: str | None = None,
                  match_text: str | None = None, output_name: str | None = None) -> dict:
        """판단이 필요한 후보에 값을 적거나 지우려는 요청을 대상 행 검토로 연결한다.
        명확한 단일 조건으로 기존 열을 바꾸는 요청은 update_matching_rows를 사용한다.
        column_id는 조건을 판단할 실제 입력 열이며 새 결과 열 이름이 아니다.
        match_text는 사용자가 말한 기준값, output_name은 요청한 새 열 이름이다.
        비슷한/같은 후보 요청은 기준값을 그대로 전달한다. 대상 행은 사용자가 선택한다."""
        return marking_review(column_id, match_text, output_name, value)

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
    def update_matching_rows(condition_column_id: str,
                             operator: Literal["equals", "not_equals", "contains", "blank", "not_blank"],
                             value: str, destination_column_id: str, assigned_value: str,
                             scope: Literal["current", "all"] = "current") -> dict:
        """명확한 단일 조건에 맞는 행의 기존 열 값만 변경하는 미리보기를 준비한다.
        조건 열과 반영할 기존 열의 실제 ID를 각각 전달한다. 같은 열도 가능하다.
        그중에서/현재 대상 안에서는 scope=current, 전체 작업표에서 다시 찾기는 scope=all이다.
        범위 지정이 없으면 current를 사용한다. 현재 범위와 새 조건은 함께 적용한다.
        문자열 포함은 contains, 전체 값 일치는 equals이며 공백·대소문자를 구분한다.
        맞지 않는 행은 유지한다. 비슷한 회사 판단, 새 열 생성, 복합 조건에는 사용하지 않는다.
        """
        result = prepare_operation(kind="set", column_ids=[condition_column_id],
                      condition=dict(column_id=condition_column_id, operator=operator, value=value),
                      destination_column_id=destination_column_id, assigned_value=assigned_value, condition_scope=scope)
        result["answer"] = ("작업표 전체에서" if scope == "all" else "현재 작업 범위 안에서") + " 조건에 맞는 행의 변경 내용을 준비할게요. 미리보기를 확인하고 적용하면 기존 열에 반영됩니다."
        return result

    @tool
    def remove_words(
            words: list[str],
            column_id: str | None = None,
            output: OperationOutput | None = None,
    ) -> dict:
        """사용자가 지정한 단어·구절·기호만 제거하도록 설정한다. 대소문자를 구분한다."""
        return prepare_operation(
            output=output,
            kind="preprocess",
            column_ids=[target(column_id)],
            rules=[{"operation": "remove_words", "words": words}],
        )

    @tool
    def preprocess(
            rules: list[Rule],
            column_id: str | None = None,
            output: OperationOutput | None = None,
    ) -> dict:
        """공백·전각·대소문자 변환, 한글 제거, 괄호 기호만 제거 등 독립된 전처리를 요청한 순서대로 설정한다."""
        return prepare_operation(
            output=output,
            kind="preprocess",
            column_ids=[target(column_id)],
            rules=rules,
        )

    @tool
    def replace_text(
            find: str | None = None,
            replacement: str = "",
            column_id: str | None = None,
            output: OperationOutput | None = None,
    ) -> dict:
        """부분 문자열 치환을 설정한다. 빈 replacement는 삭제, find가 미정이면 먼저 질문한다."""
        return prepare_operation(
            output=output,
            kind="replace",
            column_ids=[target(column_id)],
            find=find,
            replacement=replacement,
        )

    @tool
    def split_text(
            column_id: str | None = None,
            delimiter: str | None = None,
            part: Literal["all", "last"] = "all",
            output: OperationOutput | None = None,
    ) -> dict:
        """한 열의 문자열만 분리한다. delimiter=null은 공백, part=last는 마지막 단어다.
        다른 열에 포함되는지 검사하는 조건부 추출은 start_task의 formula를 사용한다."""
        return prepare_operation(
            output=output,
            kind="split",
            column_ids=[target(column_id)],
            delimiter=delimiter,
            part=part,
        )

    @tool
    def map_values(
            mappings: list[Mapping],
            column_id: str | None = None,
            output: OperationOutput | None = None,
    ) -> dict:
        """공백·대소문자 정리 후 같은 전체 값을 대표값으로 매핑한다. 빈 목록은 대응표가 미정이면 질문한다."""
        return prepare_operation(
            output=output,
            kind="map",
            column_ids=[target(column_id)],
            mappings=mappings,
        )

    @tool
    def group_values(
            column_ids: list[str],
            value_column_id: str,
            source_row: int | None = None,
            representative: str | None = None,
            group_mode: Literal["manual", "first_non_empty"] = "manual",
            output: OperationOutput | None = None,
    ) -> dict:
        """같은 기준의 행에 대표값을 적용하는 채팅 미리보기를 준비한다.

        manual은 지정한 기준 행의 그룹만 처리한다.
        first_non_empty는 모든 그룹에 첫 번째 빈칸 아닌 값을 적용한다.
        결과값과 변경여부를 새 열 두 개로 만든다.
        """
        return prepare_operation(
            output=output,
            kind="group",
            column_ids=column_ids,
            value_column_id=value_column_id,
            source_row=source_row,
            representative=representative,
            group_mode=group_mode,
        )

    @tool
    def find_model_candidates(
        column_id: str | None = None,
        extraction_mode: Literal["alphanumeric", "labelled"] | None = None,
            output: OperationOutput | None = None,
    ) -> dict:
        """모델규격명 한 열에서 문자+숫자 또는 MODEL·CODE·GRADE 뒤 후보를 추출한다.
        방식 미지정이면 실제 패턴 추천을 채팅에 표시한다. 다른 열과 비교하는 조건부 추출은 formula다. 자동 적용하지 않는다."""
        expected = extraction_column_id(workspace)
        if column_id is not None and column_id != expected:
            raise ValueError(SHARED_MESSAGES["MODEL_SPEC_REQUIRED"])
        return prepare_operation(
            output=output,
            kind="extract",
            column_ids=[expected],
            extraction_mode=extraction_mode,
        )

    @tool
    def change_output(output: OperationOutput) -> dict:
        """현재 채팅의 정제 또는 수식 미리보기 저장 위치만 바꿔 다시 계산한다. 적용은 하지 않는다.
        기존 열은 실제 column_id, 새 열은 name/anchor/side를 지정한다."""
        pending = workspace and workspace.get("pending_operation")
        if not pending:
            job = task_context.get("active_formula_job")
            if not job or job.get("status") != "PREVIEW_READY":
                raise ValueError("변경할 미리보기가 없습니다. 작업을 다시 요청하세요.")
            output_ids = [v for v in [output.column_id, output.anchor] if v]
            if output_ids:
                resolve_columns(workspace, output_ids)
            return {"intent": "formula_output", "formula_output_action": {"type": "formula_output", "formula_job_id": job["formula_job_id"], "output": output.model_dump()}, "answer": "수식 결과 저장 위치를 확인할게요. 기존 값이 있는 열은 덮어쓰지 않습니다."}
        return prepare_operation(**{**pending, "output": output})

    @tool
    def match_suppliers(column_id: str | None = None, output: OperationOutput | None = None,
                        method: Literal["auto", "levenshtein", "sequence"] = "auto") -> dict:
        """확인한 PDF 기준 거래처 n개와 현재 범위의 고유 해외거래처 N개를 비교한다.
        지정한 방식의 최고 점수 90 이상만 한국어 그룹명을 부여하고 동점은 저장 목록의 뒤 항목을 택한다.
        미지정은 auto: Levenshtein으로 먼저 비교하고 90 미만만 SequenceMatcher로 보완해 한 번에 미리보기한다.
        알고리즘 선택을 사용자에게 묻지 않는다. 특정 방식 지정 시에만 method=sequence 또는 levenshtein을 전달한다.
        기존 그룹·점수 열이 있으면 재사용하고 그룹이 빈 행만 비교한다. 채워진 그룹과 점수는 유지한다.
        대소문자·연속 공백을 통일해 비교한다. 기준 목록은 서버가 읽으며 AI가 매핑을 만들지 않는다.
        기존 결과가 없으면 새 그룹·점수 열의 변경 미리보기다. 확인 후 적용하며 90 미만은 미분류다."""
        return prepare_operation(kind="match_suppliers", column_ids=[target(column_id)], output=output, similarity_method=method)

    @tool
    def inspect_similarity(
            column_id: str | None = None,
            group_column_id: str | None = None,
            method: Literal["levenshtein", "sequence"] = "levenshtein",
            result_sheet: bool = False,
    ) -> dict:
        """정제한 한 열의 유사도를 계산해 채팅에 표시한다. 지정한 알고리즘을 전달한다.
         group_column_id는 요청한 경우에만 같은 값끼리 비교할 조건 열이다. 원본 셀은 수정하지 않는다."""
        settings = SimilaritySettings(
            column_id=target(column_id), group_column_id=group_column_id, method=method, result_sheet=result_sheet,
        )
        settings.check_workspace(workspace)
        return {
            "intent": "similarity",
            "task_type": None,
            "operation": None,
            "similarity": settings.model_dump(),
            "answer": "현재 범위의 실제 값을 읽어 유사도를 계산할게요. 결과는 채팅에 표시하며 셀은 변경하지 않습니다."
        }

    @tool
    def open_group_review(column_id: str | None = None, match_text: str | None = None,
                          output_name: str | None = None, assigned_value: str | None = None) -> dict:
        """공급자·기업·모델·임의 열의 후보를 사람이 비교하고 묶기·분리·확정하는 카드를 연다.
        같은 회사인지·모델인지 판단이 필요한 요청에 사용한다. 기준값·새 열 이름·표시값을 보존한다.
        명확한 단일 조건으로 기존 열만 바꾸는 요청은 update_matching_rows를 사용한다.
        값 읽기, 유사도 계산, 확정, 셀 반영은 사용자가 각각 선택한다. 자동 실행하지 않는다."""
        return marking_review(column_id, match_text, output_name, assigned_value)

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
    def start_agent(goal: str) -> dict:
        """방법을 맡긴 목표형 요청을 현재 작업표에서 읽기·비교·사용자 확인으로 이어간다.
        단일 정제/수식/범위 변경에는 기존 도구를 사용한다. 기업 동일성을 자동 확정하지 않는다."""
        if not workspace or not goal.strip() or len(goal) > 8000:
            raise ValueError("작업표와 구체적인 조사 목표가 필요합니다.")
        return {"intent": "agent", "goal": goal.strip(), "answer": "현재 데이터에서 목표에 필요한 작업을 이어갈게요."}

    @tool
    def resume_agent() -> dict:
        """이전 목표의 질문에 답하거나, 직접 수정/수동 작업 후 해당 목표를 계속하려는 요청이다."""
        if not task_context.get("agent_run"):
            raise ValueError("이어갈 조사 실행이 없습니다.")
        return {"intent": "agent", "resume_agent": True, "answer": "직접 수정한 값과 실행 결과를 확인하고 이어갈게요."}

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

    tools = [answer_question, ask_user, start_task, open_investigation, review_document]
    if workspace and not task_context.get("agent_execution"):
        tools.extend([start_agent, resume_agent])
    if workspace:
        tools.extend([
            # 묶음 검토 보류(2026-11-18): 재사용 여부 검토 후 불필요하면 삭제. 기존 저장 정보는 보존.
            # set_value,
            change_scope,
            change_output,
            set_column_role,
            update_matching_rows,
            remove_words,
            preprocess,
            replace_text,
            split_text,
            map_values,
            group_values,
            find_model_candidates,
            inspect_similarity, match_suppliers,
            # open_group_review,
            recommend_preprocessing,
        ])

    return tools










