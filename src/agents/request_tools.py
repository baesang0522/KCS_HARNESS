"""현재 작업 문맥에 맞는 도구를 기존 순서로 등록한다."""
from agents.tools.conversation import build_conversation_tools
from agents.tools.workspace import build_workspace_tools
from agents.tools.operations import build_operations_tools


def build_request_tools(task_context: dict):
    workspace = task_context.get("workspace")
    available = {
        **build_conversation_tools(task_context),
        **build_workspace_tools(task_context),
        **build_operations_tools(task_context),
    }
    tools = [available["answer_question"], available["ask_user"], available["start_task"], available["open_investigation"], available["review_document"]]
    if workspace and not task_context.get("agent_execution"):
        tools.extend([available["start_agent"], available["resume_agent"]])
    if workspace:
        tools.extend([
            # 묶음 검토 보류(2026-11-18): 재사용 여부 검토 후 불필요하면 삭제. 기존 저장 정보는 보존.
            # available["set_value"],
            available["change_scope"],
            available["change_output"],
            available["set_column_role"],
            available["update_matching_rows"],
            available["remove_words"],
            available["preprocess"],
            available["replace_text"],
            available["split_text"],
            available["map_values"],
            available["group_values"],
            available["find_model_candidates"], available["parse_dimensions"],
            available["inspect_similarity"], available["match_suppliers"],
            # available["open_group_review"],
            available["recommend_preprocessing"],
        ])

    return tools
