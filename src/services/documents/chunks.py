"""원문 구절 ID를 유지하며 AI 호출 분량만 나눈다. 문서 전체를 자르지 않는다."""
from itertools import islice

from services.recommendation.model_io import available_bytes, batches


def flatten_sources(pages):
    return [{"page_number": page["page_number"], **source}
            for page in pages for source in page["sources"]]


def group_sources(entries):
    pages = {}
    for item in entries:
        pages.setdefault(item["page_number"], []).append({"source_id": item["source_id"], "text": item["text"]})
    return [{"page_number": number, "sources": sources} for number, sources in pages.items()]


def next_source_chunk(entries, offset, prompt, base, schema):
    # Reuse the model transport budget as a batch size, never as a document-size rejection.
    budget = available_bytes(prompt, {**base, "stage": "conditions", "pages": [], "has_more": False}, schema)
    # Count page wrappers too; one short source per page must also fit the request.
    pages = (group_sources([item])[0] for item in islice(entries, offset, None))
    return flatten_sources(next(batches(pages, budget)))
