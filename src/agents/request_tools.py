from typing import Literal
from langchain_core.tools import tool
from services.errors import SHARED_MESSAGES
from services.operations.schemas import Mapping, Operation, Rule, extraction_column_id
from services.similarity import SimilaritySelection
from services.group_review import GroupReviewRequest
from services.recommendation.service import resolve_advice_columns, resolve_columns


def build_request_tools(task_context: dict):
    workspace = task_context.get("workspace")

    def card(**settings) -> dict:
        if not workspace:
            raise ValueError("먼저 작업 시트를 준비해야 합니다.")

        operation = Operation.model_validate(settings)
        known_ids = {
            column["column_id"]
            for column in workspace["columns"]
        }
        referenced = operation.input_column_ids + ([operation.destination_column_id] if operation.destination_column_id else [])
        if not set(referenced) <= known_ids:
            raise ValueError("현재 작업시트에 없는 열입니다.")

        return {
            "intent": "operation",
            "task_type": None,
            "operation": operation.model_dump(),
            "answer": (
                "요청한 작업의 설정 카드를 준비했습니다. "
                "대상 열과 조건을 확인한 뒤 변경 내용을 확인해 주세요. "
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
        return {"intent": "investigation", "answer": "PDF 추출내용을 열었어요. 검토 시트에서 값을 수정하고 ‘수정 내용 반영’을 눌러 주세요. PDF를 첨부하면 추출과 검토 시트 작성을 시작해요. 거래 행 선별은 아직 실행하지 않았어요."}

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
    ) -> dict:
        """새 업무를 시작하거나 수식·조건부 비교를 요청한다.
        A열의 마지막 단어가 B열에 있으면 추출하는 요청은 formula이며 두 입력 열 ID를 지정한다.
        현재 작업 시트가 있어도 사용자가 업무 전환을 명시하면 사용한다.
        같은 업무 안의 전처리, 치환, 분리 요청에는 사용하지 않는다."""
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
    def update_matching_rows(condition_column_id: str,
                             operator: Literal["equals", "not_equals", "contains", "blank", "not_blank"],
                             value: str, destination_column_id: str, assigned_value: str) -> dict:
        """명확한 단일 조건에 맞는 행의 기존 열 값만 변경하는 미리보기를 준비한다.
        조건 열과 반영할 기존 열의 실제 ID를 각각 전달한다. 같은 열도 가능하다.
        문자열 포함은 contains, 전체 값 일치는 equals이며 공백·대소문자를 구분한다.
        맞지 않는 행은 유지한다. 비슷한 회사 판단, 새 열 생성, 복합 조건에는 사용하지 않는다.
        """
        result = card(kind="set", column_ids=[condition_column_id],
                      condition=dict(column_id=condition_column_id, operator=operator, value=value),
                      destination_column_id=destination_column_id, assigned_value=assigned_value)
        result["answer"] = "조건에 맞는 행을 찾아 변경 내용을 준비할게요. 미리보기를 확인하고 적용하면 기존 열에 반영됩니다."
        return result

    @tool
    def remove_words(
            words: list[str],
            column_id: str | None = None,
    ) -> dict:
        """사용자가 지정한 단어·구절·기호만 제거하도록 설정한다. 대소문자를 구분한다."""
        return card(
            kind="preprocess",
            column_ids=[target(column_id)],
            rules=[{"operation": "remove_words", "words": words}],
        )

    @tool
    def preprocess(
            rules: list[Rule],
            column_id: str | None = None,
    ) -> dict:
        """공백·전각·대소문자 변환, 한글 제거, 괄호 기호만 제거 등 독립된 전처리를 요청한 순서대로 설정한다."""
        return card(
            kind="preprocess",
            column_ids=[target(column_id)],
            rules=rules,
        )

    @tool
    def replace_text(
            find: str | None = None,
            replacement: str = "",
            column_id: str | None = None,
    ) -> dict:
        """부분 문자열 치환을 설정한다. 빈 replacement는 삭제, find 미정은 카드에서 입력한다."""
        return card(
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
    ) -> dict:
        """한 열의 문자열만 분리한다. delimiter=null은 공백, part=last는 마지막 단어다.
        다른 열에 포함되는지 검사하는 조건부 추출은 start_task의 formula를 사용한다."""
        return card(
            kind="split",
            column_ids=[target(column_id)],
            delimiter=delimiter,
            part=part,
        )

    @tool
    def map_values(
            mappings: list[Mapping],
            column_id: str | None = None,
    ) -> dict:
        """공백·대소문자 정리 후 같은 전체 값을 대표값으로 매핑한다. 빈 목록은 선택 카드를 연다."""
        return card(
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
    ) -> dict:
        """같은 기준의 행에 대표값을 적용하는 카드를 연다.

        manual은 지정한 기준 행의 그룹만 처리한다.
        first_non_empty는 모든 그룹에 첫 번째 빈칸 아닌 값을 적용한다.
        결과값과 변경여부를 새 열 두 개로 만든다.
        """
        return card(
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
    ) -> dict:
        """모델규격명 한 열에서 문자+숫자 또는 MODEL·CODE·GRADE 뒤 후보를 추출한다.
        방식 미지정이면 추천 카드를 연다. 다른 열과 비교하는 조건부 추출은 formula다. 자동 적용하지 않는다."""
        expected = extraction_column_id(workspace)
        if column_id is not None and column_id != expected:
            raise ValueError(SHARED_MESSAGES["MODEL_SPEC_REQUIRED"])
        return card(
            kind="extract",
            column_ids=[expected],
            extraction_mode=extraction_mode,
        )

    @tool
    def inspect_similarity(
            column_id: str | None = None,
            group_column_id: str | None = None,
    ) -> dict:
        """정제한 한 열의 유사도 비교 카드를 연다. 알고리즘은 사용자가 카드에서 선택한다.
         group_column_id는 요청한 경우에만 같은 값끼리 비교할 조건 열이다. 계산이나 셀 수정은 하지 않는다."""
        settings = SimilaritySelection(
            column_id=target(column_id), group_column_id=group_column_id,
        )
        settings.check_workspace(workspace)
        return {
            "intent": "similarity",
            "task_type": None,
            "operation": None,
            "similarity": settings.model_dump(),
            "answer": "어떤 방식으로 유사도를 비교할까요? 카드의 설명과 샘플을 보고 알고릐즘을 선택해 주세요. "
                      "아직 계산하거나 셀을 변경하지 않았습니다."
        }

    @tool
    def open_cleaning_help(column_id: str | None = None) -> dict:
        """정제 방법을 모르거나 방법 선택을 요청하면 도움 카드를 연다. 분석은 시작하지 않는다."""
        ids = resolve_columns(workspace, [column_id]) if column_id is not None else None
        return {
            "intent": "cleaning_help",
            "analysis_column_ids": ids,
            "answer": "정제 도움에서 유사도 검사, 모델명 추출, AI 의견 중 필요한 기능을 선택하세요.",
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
    ) -> dict:
        """사용자가 AI/LLM 의견이나 데이터 분석 조언을 명시적으로 요청했을 때 사용한다."""
        ids = resolve_advice_columns(workspace, column_ids)

        return {
            "intent": "recommendation",
            "task_type": None,
            "operation": None,
            "similarity": None,
            "analysis_column_ids": ids,
            "answer": "대상 열의 전체 데이터를 읽어 조언을 준비하겠습니다.",
        }

    tools = [answer_question, ask_user, start_task, open_cleaning_help, open_investigation]
    if workspace:
        tools.extend([
            set_value,
            update_matching_rows,
            remove_words,
            preprocess,
            replace_text,
            split_text,
            map_values,
            group_values,
            find_model_candidates,
            inspect_similarity,
            open_group_review,
            recommend_preprocessing,
        ])

    return tools










