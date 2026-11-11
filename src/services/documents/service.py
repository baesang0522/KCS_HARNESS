import asyncio
import json
from pathlib import Path
import sys

from services.errors import DocumentError, NotFoundError
from services.documents.schemas import ReferenceDocument

MAX_UPLOAD_BYTES = 25 * 1024 * 1024
MAX_DOCUMENTS = 10
MAX_CONVERSATION_TEXT_BYTES = 16 * 1024 * 1024
EXTRACTION_TIMEOUT_SECONDS = 180


def find_document(conversation, document_id: str) -> ReferenceDocument:
    document = conversation.documents.get(document_id)
    if document is None:
        raise NotFoundError("첨부자료를 찾을 수 없습니다. 같은 대화에서 다시 첨부하세요.")
    return document


def check_capacity(conversation, document=None):
    if len(conversation.documents) >= MAX_DOCUMENTS:
        raise DocumentError("한 대화에는 PDF를 최대 10개까지 첨부할 수 있습니다. 사용하지 않는 자료를 제거하세요.")
    if document:
        documents = [*conversation.documents.values(), document]
        size = sum(len(page.text.encode("utf-8")) for item in documents for page in item.pages)
        if size > MAX_CONVERSATION_TEXT_BYTES:
            raise DocumentError("대화의 첨부 본문이 16MB를 넘습니다. 사용하지 않는 자료를 제거하세요.")


async def extract_in_process(source: Path, output: Path, slots) -> list[dict]:
    async with slots:
        process = await asyncio.create_subprocess_exec(
            sys.executable, "-m", "services.documents.extractor", str(source), str(output),
            cwd=Path(__file__).resolve().parents[2],
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
        )
        try:
            try:
                await asyncio.wait_for(process.wait(), timeout=EXTRACTION_TIMEOUT_SECONDS)
            except TimeoutError:
                raise DocumentError("PDF 읽기 시간이 3분을 넘었습니다. 파일을 나눠 다시 첨부하세요.") from None
            if process.returncode != 0 or not output.exists():
                raise DocumentError("PDF 추출을 완료하지 못했습니다. 파일을 확인하고 다시 시도하세요.")
            result = json.loads(output.read_text(encoding="utf-8"))
            if "error" in result:
                raise DocumentError(result["error"])
            return result["pages"]
        finally:
            if process.returncode is None:
                try:
                    process.kill()
                except ProcessLookupError:
                    pass
                await process.wait()
