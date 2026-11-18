"use strict";
(function () {
    function key(values) { return JSON.stringify(values); }
    function normalize(value, enabled) { return enabled ? value.trim().replace(/\s+/g, " ").toUpperCase() : value; }
    function catalog(rows, width) {
        var items = new Map();
        rows.forEach(function (row) {
            var values = row.values.slice(0, width), id = key(values);
            if (!values[0].trim()) return;
            if (!items.has(id)) items.set(id, {key: id, values: values, ids: [], excel_row: row.excel_row});
            items.get(id).ids.push(row.identity);
        });
        return Array.from(items.values()).sort(function (a, b) { return b.ids.length - a.ids.length; });
    }
    function changed(group, rows, width) {
        return group.members.some(function (member) {
            return member.ids.some(function (id) {
                var row = rows.get(id);
                return !row || key(row.values.slice(0, width)) !== key(member.values);
            });
        });
    }
    function reconcile(review, rows) {
        var byId = new Map(rows.map(function (row) { return [row.identity, row]; }));
        review.groups.forEach(function (group) {
            if (changed(group, byId, review.column_ids.length)) group.status = "review";
        });
    }
    function group(review, selected, name, id) {
        name = name.trim();
        if (!name || name.length > 200) throw new Error("대표명을 1~200자로 입력하세요.");
        if (!selected.length) throw new Error("묶을 값을 선택하세요.");
        var ids = new Set(selected.flatMap(function (item) { return item.ids; }));
        if (review.groups.some(function (g) { return g.id !== id && g.members.some(function (m) { return m.ids.some(function (row) { return ids.has(row); }); }); })) {
            throw new Error("이미 다른 묶음에 속한 행이 있습니다. 해당 묶음에서 먼저 제외하거나 묶음을 해제하세요.");
        }
        return {id: id, name: name, status: "draft", members: selected.map(function (item) {
            return {values: item.values.slice(), ids: item.ids.slice()};
        })};
    }
    function pair(a, b) { return key([a, b].sort()); }
    function candidates(items, base, sameContext, normalized, rejected) {
        return items.filter(function (item) {
            return item.key !== base.key && !rejected.includes(pair(base.key || key(base.values), item.key)) &&
                (!sameContext || base.values.slice(1).every(function (value, i) {
                    return value.trim() && normalize(value, normalized) === normalize(item.values[i + 1], normalized);
                }));
        });
    }
    window.groupReviewModel = {key: key, normalize: normalize, catalog: catalog, changed: changed,
        reconcile: reconcile, group: group, pair: pair, candidates: candidates};
})();
