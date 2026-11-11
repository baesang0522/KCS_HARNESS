"""별도 프로세스에서 실행한다. 중지 시 프로세스와 임시 파일을 함께 정리한다."""
import json
from pathlib import Path
import sys

MAX_TEXT_BYTES = 8 * 1024 * 1024


def extract_pdf(path: Path) -> list[dict]:
    import pymupdf
    import pymupdf4llm

    with pymupdf.open(path) as document:
        if not document.is_pdf:
            raise ValueError("PDF 파일만 첨부할 수 있습니다.")
        if document.needs_pass:
            raise ValueError("암호가 설정된 PDF입니다. 암호를 해제한 파일을 첨부하세요.")
        pages = []
        total_bytes = 0
        # 페이지 수는 제한하지 않는다. 한 번에 한 페이지만 변환해 중간 메모리 사용을 줄인다.
        for index in range(document.page_count):
            text = pymupdf4llm.to_markdown(
                document, pages=[index], use_ocr=False,
                write_images=False, embed_images=False,
            ).strip()
            readable = bool(document[index].get_text().strip() and text)
            if not readable:
                text = ""
            total_bytes += len(text.encode("utf-8"))
            if total_bytes > MAX_TEXT_BYTES:
                raise ValueError("추출한 본문이 8MB를 넘습니다. PDF를 나눠 첨부하세요.")
            pages.append({"page_number": index + 1, "text": text, "readable": readable})
        if not any(page["readable"] for page in pages):
            raise ValueError("읽을 수 있는 텍스트가 없습니다. 스캔·사진 PDF의 OCR은 아직 지원하지 않습니다.")
        return pages


def main():
    try:
        result = {"pages": extract_pdf(Path(sys.argv[1]))}
    except ValueError as error:
        result = {"error": str(error)}
    except Exception:
        result = {"error": "PDF 내용을 읽지 못했습니다. 손상되지 않은 PDF인지 확인하세요."}
    Path(sys.argv[2]).write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    main()
