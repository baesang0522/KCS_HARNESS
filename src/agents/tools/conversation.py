"""대화 응답·질문과 목표 실행 제어 도구."""
from langchain_core.tools import tool

def build_conversation_tools(task_context: dict):
    workspace = task_context.get("workspace")

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


    return {item.name: item for item in [
        answer_question, ask_user, start_agent, resume_agent
    ]}
