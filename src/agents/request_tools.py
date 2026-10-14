from typing import Literal
from langchain_core.tools import tool
from services.operations.schemas import Mapping, Operation, Rule


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
        if not set(operation.input_column_ids) <= known_ids:
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
                "model_normalization", "counterparty_cleanup", "formula"
            ],
    ) -> dict:
        """새 업무를 시작하거나 수식을 요청한다. 기존 정제 작업에는 사용하지 않는다."""
        return {
            "intent": "start_task",
            "task_type": task_type,
            "operation": None,
            "answer": "작업할 범위를 선택하고 설정을 확인해 주세요.",
        }

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
        """공백 정리·전각 변환·대소문자 변환 또는 복수 전처리를 순서대로 설정한다."""
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
        """문자열 분리를 설정한다. delimiter=null은 공백, part=last는 마지막 단어 추출이다."""
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
    ) -> dict:
        """같은 기준의 행에 대표값을 적용하도록 설정한다. 기준 행이 미정이면 카드에서 입력한다."""
        return card(
            kind="group",
            column_ids=column_ids,
            value_column_id=value_column_id,
            source_row=source_row,
            representative=representative,
        )

    tools = [answer_question, ask_user, start_task]
    if workspace:
        tools.extend([
            remove_words,
            preprocess,
            replace_text,
            split_text,
            map_values,
            group_values,
        ])
    return tools










