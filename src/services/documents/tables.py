"""번호가 있는 연속 표의 셀 좌표를 보존한다. 텍스트가 없는 열도 버리지 않는다."""
import re


def numbered_tables(page, previous=None):
    import pymupdf

    result, regions = [], []
    for table in page.find_tables(use_layout=False).tables:
        raw = [[page.get_text('text', clip=pymupdf.Rect(cell)).strip() if cell else ''
                for cell in row.cells] for row in table.rows]
        if not raw:
            continue
        first = raw[0]
        header = bool(re.fullmatch(r'순번|번호|no\.?', first[0].strip(), re.I))
        if header and all(first):
            headers = first
            # Header cells retain empty columns on following pages, even if the detector merges them.
            boundaries = [table.rows[0].cells[0][0]] + [cell[2] for cell in table.rows[0].cells]
            body = table.rows[1:]
        elif previous and first[0].isdigit() and int(first[0]) == previous['last'] + 1 and (
                page.number == previous['page'] + 1 and
                abs(table.bbox[0] - previous['bounds'][0]) < 2 and
                abs(table.bbox[2] - previous['bounds'][-1]) < 2):
            headers, boundaries, body = previous['headers'], previous['bounds'], table.rows
        else:
            continue
        rows = []
        for row in body:
            cells = [page.get_text('text', clip=pymupdf.Rect(left, row.bbox[1], right, row.bbox[3])).strip()
                     for left, right in zip(boundaries, boundaries[1:])]
            if any(cells):
                rows.append(cells)
        # A non-numeric row may be a merged heading or a new table; leave it to the ordinary reader.
        if not rows or any(not row[0].isdigit() for row in rows):
            continue
        result.append({'headers': headers, 'rows': rows})
        regions.append(table.bbox)
        previous = {'headers': headers, 'bounds': boundaries, 'last': int(rows[-1][0]), 'page': page.number}
    return result, regions, previous


def table_markdown(table):
    def cell(text):
        return text.replace('|', r'\|').replace('\n', '<br>')
    rows = [table['headers'], ['---'] * len(table['headers']), *table['rows']]
    return '\n'.join('|' + '|'.join(cell(value) for value in row) + '|' for row in rows)


def page_with_tables(page, tables, regions):
    import pymupdf

    parts = [(rect[1], rect[0], table_markdown(table)) for rect, table in zip(regions, tables)]
    for block in page.get_text('blocks'):
        if len(block) > 6 and block[6] != 0:
            continue
        center = pymupdf.Point((block[0] + block[2]) / 2, (block[1] + block[3]) / 2)
        if not any(center in pymupdf.Rect(rect) for rect in regions):
            parts.append((block[1], block[0], block[4].strip()))
    return '\n\n'.join(text for _, _, text in sorted(parts) if text)


def is_model_table(table):
    # Wide catalogues list one model per non-empty cell, with its class in the column header.
    return len(table.headers) > 1 and all(re.search(r'강종|규격|모델|일반재', h) for h in table.headers[1:])


def split_model_cell(value):
    # Parenthesized English aliases such as AR400(NM400) belong to the model name.
    note = re.search(r'[\[(（]\s*[가-힣]|※', value)
    return (' '.join(value[:note.start()].split()), value[note.start():].strip()) if note else (' '.join(value.split()), '')


def split_company_name(name):
    match = re.fullmatch(r'\s*(.+?)\s*[（(](.+)[)）]\s*', name, re.S)
    if match and re.search(r'[가-힣]', match[1]) and re.search(r'[A-Za-z]', match[2]) and not re.search(r'[가-힣]', match[2]):
        return ' '.join(match[1].split()), ' '.join(match[2].split())
    return None
