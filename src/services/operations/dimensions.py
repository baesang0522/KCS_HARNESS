"""제한된 치수 표기만 읽고 해석이 모호한 행의 수치 결과는 비워 둔다."""
import re
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

Dimension = Literal['thickness', 'width', 'length', 'diameter', 'height', 'depth']
Unit = Literal['mm', 'cm', 'm', 'in']
NAMES = dict(thickness='두께', width='폭', length='길이', diameter='외경', height='높이', depth='깊이')
PROFILES = {
    'plate': ['thickness', 'width', 'length'],
    'pipe': ['diameter', 'thickness', 'length'],
    'bar': ['diameter', 'length'],
}
PRODUCTS = {name: profile for profile, names in {
    'plate': ['plate', 'steel plate', '철판', '강판', '후판', '스테인리스 강판'],
    'pipe': ['pipe', 'tube', '강관', '원형관', '파이프'],
    'bar': ['round bar', '원형봉', '환봉'],
}.items() for name in names}
LABELS = dict(thickness=['THICKNESS', 'THK', '두께', 'T'], width=['WIDTH', '폭', '너비', 'W'],
              length=['LENGTH', 'LEN', '길이', 'L'], diameter=['DIAMETER', 'DIA', 'OD', '외경', '직경', 'Ø', 'Φ'],
              height=['HEIGHT', '높이', 'H'], depth=['DEPTH', '깊이'])
FACTORS = {'mm': Decimal(1), 'cm': Decimal(10), 'm': Decimal(1000), 'in': Decimal('25.4')}
UNITS = {'mm': 'mm', '㎜': 'mm', '밀리미터': 'mm', 'cm': 'cm', '㎝': 'cm', '센티미터': 'cm',
         'm': 'm', '미터': 'm', 'in': 'in', 'inch': 'in', 'inches': 'in', '인치': 'in', '"': 'in'}
NUMBER = r'(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?|\.\d+)'
UNIT_PATTERN = '|'.join(map(re.escape, sorted(UNITS, key=len, reverse=True)))
ATOM = NUMBER + r'\s*(?:' + UNIT_PATTERN + r')?'
VALUE = re.compile(r'\s*(' + NUMBER + r')\s*([^\d\s,;:×*]*)', re.I)


class DimensionRules(BaseModel):
    model_config = ConfigDict(extra='forbid')
    product: str = Field(min_length=1, max_length=200)
    order: list[Dimension] | None = None
    fields: list[Dimension] | None = None
    unit: Unit | None = None
    delimiter: str | None = Field(default=None, min_length=1, max_length=20)
    after: str | None = Field(default=None, max_length=100)
    labels: dict[Dimension, str] = Field(default_factory=dict)

    @property
    def profile(self):
        return PRODUCTS.get(' '.join(self.product.lower().split()))

    @property
    def resolved_order(self):
        return self.order if self.order is not None else PROFILES.get(self.profile, [])

    @property
    def selected_fields(self):
        return self.fields or self.resolved_order or list(self.labels)

    @model_validator(mode='after')
    def validate_rules(self):
        if not self.product.strip():
            raise ValueError('어떤 물품인지 알려주세요.')
        for values in [self.order, self.fields]:
            if values is not None and (not values or len(values) != len(set(values))):
                raise ValueError('치수 항목과 순서는 중복 없이 지정하세요.')
        if not self.resolved_order and not self.labels:
            raise ValueError('이 품목의 기본 치수 순서는 아직 지원하지 않습니다. 항목별 표기 또는 순서를 알려주세요.')
        if any(not value.strip() or len(value) > 100 for value in self.labels.values()):
            raise ValueError('찾을 항목 표기는 1~100자로 지정하세요.')
        if self.delimiter and (not self.delimiter.strip() or re.search(r'[\d.,+\-]', self.delimiter)):
            raise ValueError('숫자·소수점·부호와 겹치지 않는 구분자를 지정하세요.')
        if self.fields and not set(self.fields) <= set(self.resolved_order) | set(self.labels):
            raise ValueError('요청한 치수 항목의 순서나 항목 표기를 지정하세요.')
        return self

    def summary(self):
        order = '×'.join(NAMES[field] for field in self.resolved_order) or '항목명 기준'
        details = [f'품목: {self.product}', f'{"사용자 지정 순서" if self.order else "품목별 기본 순서"}: {order}',
                   f'단위 없는 값: {self.unit or "mm"}{" 가정" if not self.unit else " 지정"}', '결과 단위: mm']
        if self.delimiter:
            details.append(f'구분자: {self.delimiter}')
        if self.after:
            details.append(f'읽기 시작 표기: {self.after}')
        if self.labels:
            details.append('사용자 항목 표기: ' + ', '.join(NAMES[k] + '=' + v for k, v in self.labels.items()))
        return ' · '.join(details) + '. 기본 순서는 관행에 따른 가정이며 국제표준 준수를 보장하지 않아. 확인 필요 행의 숫자는 비워 둬.'


class DimensionParser:
    def __init__(self, rules):
        self.rules = rules
        self.separator = re.escape(rules.delimiter) if rules.delimiter else r'[xX×*]'
        self.tuples = re.compile(r'(?<![\w.,/+\-])' + ATOM + r'(?:\s*' + self.separator + r'\s*' + ATOM + r')+(?![\w.,/+\-])', re.I)
        labels = {field: [rules.labels[field]] if field in rules.labels else names for field, names in LABELS.items()}
        self.labels = {label.upper(): field for field, names in labels.items() for label in names}
        if len(self.labels) != sum(len(names) for names in labels.values()):
            raise ValueError('같은 항목 표기를 서로 다른 치수에 지정할 수 없습니다.')
        names = [re.escape(label) + (r'(?!\w)' if re.search(r'\w$', label) else '')
                 for label in sorted(self.labels, key=len, reverse=True)]
        self.label_pattern = re.compile(r'(?<!\w)(' + '|'.join(names) + r')\s*[:=]?\s*', re.I)

    def parse(self, original):
        rules = self.rules
        text = original.translate({**{i: i - 0xFEE0 for i in range(0xFF01, 0xFF5F)}, 0x3000: 32})
        if rules.after:
            markers = list(re.finditer(re.escape(rules.after), text, re.I))
            if not markers:
                return self.result({}, '미검출', '')
            if len(markers) > 1:
                return self.result({}, '확인 필요 · 시작 표기 여러 개', text)
            text = text[markers[0].end():].lstrip().split('\n', 1)[0].split(';', 1)[0]
        tuples = list(self.tuples.finditer(text))
        labels = list(self.label_pattern.finditer(text))
        fragments, labelled, reason = [], {}, None
        assumed_unit = False
        for i, label in enumerate(labels):
            # 치수 묶음 안의 단위나 모델 코드 일부를 항목명으로 다시 읽지 않는다.
            if any(match.start() <= label.start() < match.end() for match in tuples):
                continue
            segment = text[label.end():labels[i+1].start() if i+1 < len(labels) else len(text)]
            match = VALUE.match(segment)
            if not match:
                continue
            field = self.labels[label[1].upper()]
            raw_unit = match[2].lower()
            fragments.append(text[label.start():label.end()+match.end()].strip())
            if raw_unit and raw_unit not in UNITS:
                reason = '단위·범위 표기 확인'
                continue
            if field in labelled:
                reason = '같은 치수 여러 개'
            value = Decimal(match[1].replace(',', '')) * FACTORS[UNITS.get(raw_unit, rules.unit or 'mm')]
            if value <= 0 or re.match(r'\s*(?:[~≤≥<>±/\-]|이상|이하|초과|미만|to\b)', segment[match.end():], re.I):
                reason = '수치·범위 표기 확인'
            labelled[field] = value
            assumed_unit |= not raw_unit and rules.unit is None
        if len(tuples) > 1:
            return self.result({}, '확인 필요 · 치수 묶음 여러 개', '\n'.join(match[0] for match in tuples))
        parsed = {}
        if tuples:
            candidate = tuples[0][0].strip()
            fragments.append(candidate)
            before, after = text[:tuples[0].start()], text[tuples[0].end():]
            if re.search(r'(?:[~≤≥<>±]|[<>]=|\bto)\s*$', before, re.I) or re.match(r'\s*\(?\s*(?:[~≤≥<>±]|이상|이하|초과|미만|to\b)', after, re.I):
                reason = '범위·공차 표기 확인'
            if re.match(r'\s*(?:ft|feet|foot|um|µm|μm|nm|yd|yard|kg|g|lbs?|oz|mm[²³23]|cm[²³23]|m[²³23]|㎛|㎚|㎟)(?!\w)', after, re.I) or re.match(r'\s*\(\s*(?:' + UNIT_PATTERN + r')(?!\w)', after, re.I):
                reason = '단위 표기 확인'
            pieces = re.split(self.separator, candidate, flags=re.I)
            if len(pieces) != len(rules.resolved_order):
                reason = '치수 개수·순서 확인'
            else:
                parts = [VALUE.fullmatch(piece.strip()) for piece in pieces]
                if not all(parts):
                    reason = '치수 표기 확인'
                else:
                    explicit = {UNITS.get(part[2].lower()) for part in parts if part[2]}
                    if None in explicit or len(explicit) > 1 and any(not part[2] for part in parts):
                        reason = '단위 확인'
                    else:
                        inherited = next(iter(explicit)) if len(explicit) == 1 else rules.unit or 'mm'
                        assumed_unit |= not explicit and rules.unit is None
                        for field, part in zip(rules.resolved_order, parts):
                            parsed[field] = Decimal(part[1].replace(',', '')) * FACTORS[UNITS.get(part[2].lower(), inherited)]
        if not parsed and not labelled and not reason:
            return self.result({}, '미검출', '')
        if any(field in parsed and parsed[field] != value for field, value in labelled.items()):
            reason = '항목 표기와 치수 묶음 충돌'
        parsed.update(labelled)
        # Excel은 수치 유효숫자 15자리까지만 보존하므로 그 이상을 조용히 반올림하지 않는다.
        if any(len(value.normalize().as_tuple().digits) > 15 or abs(value) >= Decimal('1e308') for value in parsed.values()):
            reason = 'Excel 수치 정밀도 확인'
        if any(value <= 0 for value in parsed.values()):
            reason = '양수가 아닌 치수'
        if rules.profile == 'plate' and 'thickness' in parsed and any(parsed['thickness'] >= parsed[k] for k in ['width', 'length'] if k in parsed):
            reason = '두께·폭·길이 관계 확인'
        if rules.profile == 'pipe' and {'diameter', 'thickness'} <= parsed.keys() and parsed['thickness'] * 2 >= parsed['diameter']:
            reason = '외경·두께 관계 확인'
        if not set(rules.selected_fields) <= parsed.keys():
            reason = reason or '요청한 치수 누락'
        if reason:
            return self.result({}, '확인 필요 · ' + reason, '\n'.join(fragments))
        assumptions = []
        if tuples and rules.order is None:
            assumptions.append('기본 순서')
        if assumed_unit:
            assumptions.append('mm 가정')
        return self.result(parsed, '추출' + (' · ' + '·'.join(assumptions) if assumptions else ''), '\n'.join(fragments))

    def result(self, values, status, fragment):
        return [self.number(values[k]) if k in values else '' for k in self.rules.selected_fields] + [status], fragment

    @staticmethod
    def number(value):
        text = format(value, 'f')
        return text.rstrip('0').rstrip('.') if '.' in text else text
