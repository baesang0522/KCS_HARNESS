"""정제·비교 미리보기를 구성하는 도구."""
from typing import Literal
import re
from langchain_core.tools import tool
from services.formula.schemas import FormulaOutput
from services.operations.schemas import Mapping, Operation, OperationOutput, Rule, RowFilter, extraction_column_id
from services.similarity import SimilaritySettings
from services.group_review import GroupReviewRequest
from services.operations.dimensions import DimensionRules, Dimension, Unit, PRODUCTS, DimensionParser
from services.workspace import resolve_columns

def build_operations_tools(task_context: dict):
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
                             operator: Literal["equals", "not_equals", "contains", "blank", "not_blank", "gt", "gte", "lt", "lte"],
                             value: str, destination_column_id: str, assigned_value: str,
                             scope: Literal["current", "all"] = "current") -> dict:
        """명확한 단일 조건에 맞는 행의 기존 열 값만 변경하는 미리보기를 준비한다.
        조건 열과 반영할 기존 열의 실제 ID를 각각 전달한다. 같은 열도 가능하다.
        그중에서/현재 대상 안에서는 scope=current, 전체 작업표에서 다시 찾기는 scope=all이다.
        범위 지정이 없으면 current를 사용한다. 현재 범위와 새 조건은 함께 적용한다.
        문자열 포함은 contains, 전체 값 일치는 equals이며 공백·대소문자를 구분한다.
        숫자 초과는 gt, 이상은 gte, 미만은 lt, 이하는 lte다. 빈칸·숫자가 아닌 값은 제외한다.
        맞지 않는 행은 유지한다. 비슷한 회사 판단, 새 열 생성, 복합 조건에는 사용하지 않는다.
        """
        run = task_context.get("agent_run") or {}
        request = "\n".join([task_context.get("user_request") or "", run.get("user_request") or "", run.get("user_reply") or ""])
        previous = ((run.get("observation") or {}).get("source") or {}).get("operation") or {}
        supplier_matching = previous.get("kind") == "match_suppliers" or (
            re.search(r"유사도|매칭", request) and re.search(r"회사|거래처|그룹", request))
        if supplier_matching and assigned_value.upper() in {"Y", "N"} and not re.search(
                r"(?<![A-Za-z0-9_])" + re.escape(assigned_value) + r"(?![A-Za-z0-9_])", request, re.IGNORECASE):
            raise ValueError("사용자 원문에는 Y/N 값 변경 요청이 없습니다. 거래처 그룹 매칭에 판정값 변경을 추가하지 마세요. 요청한 매칭이 완료됐다면 answer_question으로 결과를 보고하세요.")
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
        extraction_mode: Literal["pdf", "alphanumeric", "labelled"] | None = "pdf",
            output: OperationOutput | None = None,
    ) -> dict:
        """기본은 확인한 PDF 모델명을 모델규격명 열에서 찾아 모델명·PDF 분류를 새 열에 함께 추출한다.
        일치 후보 중 대소문자·연속 공백을 통일한 이름이 가장 긴 모델만 추출한다. 최장 길이 동률·동일 모델의 다른 PDF 분류는 함께 보존한다.
        미검출은 빈칸이며 라벨 추출을 자동 실행하지 않는다. 사용자가 명시하면 alphanumeric/labelled를 사용한다.
        명시한 column_id를 역할 변경 없이 사용한다. 생략했을 때만 model_spec 역할의 유일한 열을 사용한다.
        null은 패턴 추천이다. 다른 열과 비교하는 조건부 추출은 formula다. 자동 적용하지 않는다."""
        expected = column_id if column_id is not None else extraction_column_id(workspace)
        return prepare_operation(
            output=output,
            kind="extract",
            column_ids=[expected],
            extraction_mode=extraction_mode,
        )


    @tool
    def parse_dimensions(product: str | None = None, column_id: str | None = None,
                         fields: list[Dimension] | None = None, order: list[Dimension] | None = None,
                         unit: Unit | None = None, delimiter: str | None = None, after: str | None = None,
                         labels: dict[Dimension, str] | None = None, reuse_rules: bool = True,
                         condition: RowFilter | None = None,
                         scope: Literal["current", "all"] = "all",
                         output: OperationOutput | None = None) -> dict:
        """모델규격명에서 치수를 읽어 mm 수치와 파싱 상태를 기존 미리보기로 보낸다.
        품목을 모르면 product를 생략해 질문한다. 대화/PDF에서 확인한 품목만 전달한다.
        철판/강관/환봉은 기본 순서, 그 외 품목은 명시된 order 또는 labels가 필요하다.
        사용자 요청만 order/fields/unit/delimiter/after/labels에 전달한다. 모른다는 답은 기본값을 사용한다.
        unit은 단위 없는 값의 단위다. fields는 뽑을 항목, order는 입력 숫자 순서다.
        예: thickness만 추출, order=[width,length,thickness], after=SIZE:, labels={thickness:THK:}.
        같은 입력 열의 미리보기/적용된 규칙을 재사용한다. 새 품목이나 reuse_rules=false면 초기화한다.
        after=""는 시작 표기 해제, labels={}는 사용자 표기 해제, order=[]는 기본 순서 복귀다.
        조건부 두께 추출도 이 도구다. condition에 행 조건을 전달하며 일반 수식으로 대체하지 않는다.
        기본 scope=all은 필터·숨김과 무관한 작업표 전체다. 사용자가 현재 후보 안으로 제한한 경우만 current다.
        명시한 column_id는 역할 변경 없이 사용한다. 기존 결과 열 갱신은 fields 한 항목과 output을 지정한다.
        조건 밖 기존 값은 유지한다. 기존 열 갱신의 파싱 상태는 미리보기에서 확인한다.
        임의 정규식/코드는 받지 않는다. 미검출·모호함은 숫자를 비우며 자동 적용하지 않는다."""
        expected = column_id
        if expected is None and workspace:
            sources = [c for c in workspace["columns"] if c.get("role") == "model_spec"]
            if len(sources) == 1:
                expected = str(sources[0]["column_id"])
        previous = {}
        if reuse_rules:
            pending = (workspace or {}).get("pending_operation") or {}
            if pending.get("kind") == "dimensions" and pending.get("column_ids") == [expected]:
                previous = pending.get("dimensions") or {}
            else:
                previous = task_context.get("execution_history", {}).get("dimension_rules", {}).get(expected, {})
        if product and previous.get("product") and product.lower().strip() != previous["product"].lower().strip():
            if PRODUCTS.get(product.lower().strip(), product) != PRODUCTS.get(previous["product"].lower().strip(), previous["product"]):
                previous = {}
        settings = dict(previous)
        settings.update({key: value for key, value in dict(product=product, fields=fields, order=order,
                        unit=unit, delimiter=delimiter, after=after, labels=labels).items() if value is not None})
        if not settings.get("product"):
            return {"intent": "clarify", "answer": "어떤 물품 데이터야? 철판·강관·환봉 같은 품목을 알려줘. 표기 순서를 몰라도 괜찮아."}
        if expected is None:
            return {"intent": "clarify", "answer": "규격 원문이 들어 있는 열 이름을 알려줘."}
        if settings.get("order") == []:
            settings["order"] = None
        if not PRODUCTS.get(settings["product"].lower().strip()) and not settings.get("order") and not settings.get("labels"):
            return {"intent": "clarify", "answer": settings["product"] + "의 기본 치수 표기는 아직 지원하지 않아. 원문의 규격 예시와 뽑을 항목을 알려줘. 순서나 항목 표기를 알면 같이 말해줘."}
        rules = DimensionRules.model_validate(settings)
        DimensionParser(rules)  # 서로 다른 치수에 같은 표기를 지정하는 충돌은 미리 차단한다.
        result = prepare_operation(kind="dimensions", column_ids=[expected], dimensions=rules,
                                   condition=condition, condition_scope=scope, output=output)
        result["answer"] = rules.summary() + " 실제 원문과 추출 결과를 미리보기로 보여줄게."
        return result


    @tool
    def change_output(output: OperationOutput) -> dict:
        """현재 채팅의 정제 또는 수식 미리보기 저장 위치만 바꿔 다시 계산한다. 적용은 하지 않는다.
        기존 열은 실제 column_id를 지정한다. 정제의 새 열만 name/anchor/side를 지원한다.
        수식은 오른쪽 새 열(mode=new) 또는 입력과 겹치지 않는 기존 열을 지원하며 이름 변경은 start_task로 다시 준비한다."""
        pending = workspace and workspace.get("pending_operation")
        if not pending:
            job = task_context.get("active_formula_job")
            if not job or job.get("status") != "PREVIEW_READY":
                raise ValueError("변경할 미리보기가 없습니다. 작업을 다시 요청하세요.")
            output = FormulaOutput.model_validate(output.model_dump())
            output_ids = [v for v in [output.column_id, output.anchor] if v]
            if output_ids:
                resolve_columns(workspace, output_ids)
            return {"intent": "formula_output", "formula_output_action": {"type": "formula_output", "formula_job_id": job["formula_job_id"], "output": output.model_dump()}, "answer": "수식 결과 저장 위치를 확인할게요. 지정한 기존 열은 계산 결과값으로 갱신합니다."}
        return prepare_operation(**{**pending, "output": output})


    @tool
    def match_suppliers(column_id: str | None = None, output: OperationOutput | None = None,
                        method: Literal["auto", "levenshtein", "sequence"] = "auto", threshold: float = 90) -> dict:
        """확인한 PDF 기준 거래처 n개와 현재 범위의 고유 해외거래처 N개를 비교한다.
        threshold는 사용자가 지정한 기준 점수(0~100, 소수 허용), 미지정은 90이다. 최고 점수가 threshold 이상일 때만 한국어 그룹명을 부여하고 동점은 저장 목록의 뒤 항목을 택한다.
        미지정은 auto: Levenshtein으로 먼저 비교하고 threshold 미만만 SequenceMatcher로 보완해 한 번에 미리보기한다.
        알고리즘 선택을 사용자에게 묻지 않는다. 특정 방식 지정 시에만 method=sequence 또는 levenshtein을 전달한다.
        기존 그룹·점수 열이 있으면 재사용하고 그룹이 빈 행만 비교한다. 채워진 그룹과 점수는 유지한다.
        대소문자·연속 공백을 통일해 비교한다. 기준 목록은 서버가 읽으며 AI가 매핑을 만들지 않는다.
        기존 결과가 없으면 새 그룹·점수 열의 변경 미리보기다. 확인 후 적용하며 threshold 미만은 미분류다."""
        return prepare_operation(kind="match_suppliers", column_ids=[target(column_id)], output=output, similarity_method=method, similarity_threshold=threshold)


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


    return {item.name: item for item in [
        set_value, update_matching_rows, remove_words, preprocess, replace_text, split_text, map_values, group_values, find_model_candidates, parse_dimensions, change_output, match_suppliers, inspect_similarity, open_group_review
    ]}
