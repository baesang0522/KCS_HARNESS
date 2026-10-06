"use strict";
(function () {
    window.createMappingEditor = function () {
        function el(id) { return document.getElementById("op-" + id); }
        var items = [], pairs = [], changed = function () {};
        function renderValues() {
            var query = el("value-search").value.toUpperCase(), select = el("source-values");
            select.textContent = "";
            var matches = items.filter(function (item) { return item.key.includes(query) || item.example.toUpperCase().includes(query); });
            matches.slice(0, 100).forEach(function (item) {
                var option = document.createElement("option"); option.value = item.key;
                option.textContent = JSON.stringify(item.example) + " · " + item.count + "행";
                option.title = item.key; select.appendChild(option);
            });
            el("value-count").textContent = "전체 " + items.length + "개 그룹 · 검색 " + matches.length + "개 중 최대 100개 표시";
        }
        function renderPairs() {
            var container = el("mappings"); container.textContent = "";
            pairs.forEach(function (pair, index) {
                var row = document.createElement("div"), label = document.createElement("label");
                label.textContent = JSON.stringify(pair.source) + " → 대표값";
                var input = document.createElement("input"); input.type = "text"; input.maxLength = 32767; input.value = pair.target;
                input.addEventListener("input", function () { pair.target = input.value; changed(); });
                label.appendChild(input); row.appendChild(label);
                var remove = document.createElement("button"); remove.type = "button"; remove.textContent = "매핑 삭제";
                remove.addEventListener("click", function () { pairs.splice(index, 1); renderPairs(); changed(); });
                row.appendChild(remove); container.appendChild(row);
            });
        }
        el("value-search").addEventListener("input", renderValues);
        return {
            bind: function (onChange, status) {
                changed = onChange;
                el("add-mapping").addEventListener("click", function () {
                    var selected = Array.from(el("source-values").selectedOptions), target = el("representative").value;
                    if (!selected.length || !target.trim()) { status("실제 값 그룹과 대표값을 지정하세요."); return; }
                    if (pairs.length + selected.filter(function (option) { return !pairs.some(function (p) { return p.source === option.value; }); }).length > 1000) {
                        status("한 번에 최대 1,000개 그룹을 매핑할 수 있습니다."); return;
                    }
                    selected.forEach(function (option) {
                        var pair = pairs.find(function (p) { return p.source === option.value; });
                        if (pair) pair.target = target; else pairs.push({source: option.value, target: target});
                    });
                    renderPairs(); changed(); status("매핑 목록을 확인하고 변경 내용 확인을 누르세요.");
                });
            },
            catalog: function (data) { items = data.items; renderValues(); },
            set: function (value) { pairs = value.map(function (p) { return {source: p.source, target: p.target}; }); renderPairs(); },
            get: function () {
                if (!pairs.length || pairs.some(function (p) { return !p.target.trim(); })) throw new Error("원본 그룹과 대표값을 지정하세요.");
                return pairs.map(function (p) { return {source: p.source, target: p.target}; });
            },
            reset: function () { items = []; pairs = []; el("value-search").value = el("representative").value = ""; renderValues(); renderPairs(); }
        };
    };
})();
