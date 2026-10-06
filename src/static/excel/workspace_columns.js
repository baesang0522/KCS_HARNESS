"use strict";

(function () {
    // 열 선택과 설명 입력만 관리한다. 실제 데이터 읽기·쓰기는 별도다.
    window.createWorkspaceColumns = function (selects, container, roles) {
        var source = null;
        var extras = new Map();
        var controls = [];
        var busy = false;
        var changeHandler = null;

        function columnName(index) {
            var name = "";
            for (var value = index + 1; value > 0;) {
                value -= 1;
                name = String.fromCharCode(65 + value % 26) + name;
                value = Math.floor(value / 26);
            }
            return name;
        }

        function columnLabel(index) {
            return columnName(source.column_start + index) + "열 · " +
                (source.headers[index] || "(머리글 없음)");
        }

        function getMapping() {
            return selects.map(function (select) {
                return select.value === "" ? -1 : Number(select.value);
            });
        }

        function getExtraColumns() {
            if (!source) return [];
            var required = new Set(getMapping());
            return source.headers.reduce(function (result, header, index) {
                var entry = extras.get(index);
                if (entry && entry.selected && !required.has(index)) {
                    result.push({
                        source_index: index,
                        column_index: source.column_start + index,
                        header: header,
                        description: entry.description.trim()
                    });
                }
                return result;
            }, []);
        }

        function setBusy(value) {
            busy = value;
            selects.forEach(function (select) { select.disabled = busy; });
            controls.forEach(function (control) {
                control.checkbox.disabled = busy;
                control.description.disabled = busy || !control.entry.selected;
            });
        }

        function notifyChange() {
            if (changeHandler) changeHandler();
        }

        function renderExtras() {
            container.textContent = "";
            controls = [];
            if (!source) return;
            var required = new Set(getMapping());

            source.headers.forEach(function (_, index) {
                if (required.has(index)) return;
                if (!extras.has(index)) {
                    extras.set(index, {selected: false, description: ""});
                }
                var entry = extras.get(index);
                var card = document.createElement("div");
                card.className = "work-extra-column";
                var label = document.createElement("label");
                label.className = "work-extra-choice";
                var checkbox = document.createElement("input");
                checkbox.type = "checkbox";
                checkbox.checked = entry.selected;
                label.appendChild(checkbox);
                label.appendChild(document.createTextNode(columnLabel(index)));
                card.appendChild(label);

                var details = document.createElement("div");
                details.hidden = !entry.selected;
                var descriptionLabel = document.createElement("label");
                var description = document.createElement("textarea");
                description.id = "work-extra-description-" + index;
                descriptionLabel.htmlFor = description.id;
                descriptionLabel.textContent = "열 설명 (선택)";
                description.rows = 2;
                description.maxLength = 1000;
                description.className = "work-extra-description";
                description.placeholder =
                    "예: ERP에 등록된 모델명 / USD 기준의 개당 단가";
                description.value = entry.description;
                description.setAttribute("aria-describedby", "work-extra-hint");
                details.appendChild(descriptionLabel);
                details.appendChild(description);
                card.appendChild(details);
                container.appendChild(card);

                checkbox.addEventListener("change", function () {
                    entry.selected = checkbox.checked;
                    details.hidden = !entry.selected;
                    description.disabled = busy || !entry.selected;
                    notifyChange();
                });
                description.addEventListener("input", function () {
                    entry.description = description.value;
                    notifyChange();
                });
                controls.push({
                    checkbox: checkbox, description: description, entry: entry
                });
            });

            if (!controls.length) {
                container.textContent = "추가로 선택할 열이 없습니다.";
            }
            setBusy(busy);
        }

        function clear() {
            source = null;
            extras.clear();
            controls = [];
            container.textContent = "";
            selects.forEach(function (select) { select.textContent = ""; });
        }

        function showSelection(selection) {
            clear();
            source = selection;
            selects.forEach(function (select, roleIndex) {
                var placeholder = document.createElement("option");
                placeholder.value = "";
                placeholder.textContent = "열을 선택하세요";
                select.appendChild(placeholder);
                var matches = [];
                source.headers.forEach(function (header, index) {
                    var option = document.createElement("option");
                    option.value = String(index);
                    option.textContent = columnLabel(index);
                    select.appendChild(option);
                    if (roles[roleIndex].labels.indexOf(header.replace(/\s+/g, "")) >= 0) matches.push(index);
                });
                // 중복 머리글이나 이름이 다른 열은 사용자가 직접 지정한다.
                select.value = matches.length === 1 ? String(matches[0]) : "";
            });
            renderExtras();
        }

        return {
            showSelection: showSelection,
            clear: clear,
            getMapping: getMapping,
            getExtraColumns: getExtraColumns,
            setBusy: setBusy,
            bind: function (handler) {
                changeHandler = handler;
                selects.forEach(function (select) {
                    select.addEventListener("change", function () {
                        renderExtras();
                        notifyChange();
                    });
                });
            }
        };
    };
})();
