"use strict";
(function () {
    window.createFormulaUI = function (messages) {
        var handlers = {}, offer = null;
        function reset() { if (offer) offer.disable(); offer = null; }
        return {
            open: function () {}, reset: reset,
            showPreview: function (instruction, selection, preview, target) {
                reset();
                var text = '수식 적용 예정 · ' + target.row_count.toLocaleString() + '행\n입력: ' + (selection.input_columns || []).map(function (c) { return c.header; }).join(', ') + ' · ' + selection.address + '\n저장 위치: ' + target.address + '\n요청: ' + instruction + '\n아직 셀은 변경하지 않았어. 적용하면 수식을 계산한 뒤 결과값으로 저장해. 실제 계산 오류는 적용 중 검사해.';
                if (target.overwrite === 'allow') text += '\n지정한 기존 열의 값을 계산 결과값으로 덮어써.';
                if (target.has_formulas) text += '\n이 범위의 기존 수식도 결과값으로 교체돼.';
                if (selection.workspace_id) text += '\n필터로 제외되거나 숨겨진 행도 위 입력 범위에 포함되면 계산해. 기존 필터 조건은 유지돼.';
                if ((selection.reference_sheets || []).length) text += '\n참조: ' + selection.reference_sheets.map(function (sheet) { return sheet.address; }).join(', ');
                offer = messages.confirm(text, {apply: handlers.apply, cancel: function () { reset(); if (handlers.cancel) handlers.cancel(); messages.say('수식 적용을 취소했어. 셀은 변경하지 않았어.'); }}, ['결과 열', '범위', '수식'], preview.plan.actions.map(function (a) { return [a.output_label, a.target_range, a.formula]; }));
            },
            setStatus: function (text) { document.getElementById('notice').textContent = text; },
            setApplied: reset,
            setBusy: function () { messages.busy(); },
            bind: function (value) { handlers = value; }
        };
    };
})();
