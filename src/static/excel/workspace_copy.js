"use strict";

(function () {
    // 선택한 원본 열을 Excel 안에서 복사한다. 전체 셀을 서버로 보내지 않는다.
    async function create(source, sheetName, onProgress) {
        window.workspaceSheet.requireExcel("1.9");
        var roles = source.roles;
        var required = roles.map(function (role) {
            return source.mapping && source.mapping[role];
        });
        var references = source.reference_columns || [];
        var indexes = Array.from(new Set(required.concat(
            references.map(function (column) { return column.source_index; })
        ))).sort(function (left, right) { return left - right; });
        if (new Set(required).size !== 3 || indexes.some(function (index) {
            return !Number.isInteger(index) || index < 0 || index >= source.column_count;
        })) {
            throw new Error("필수 열과 추가 열을 다시 확인하세요.");
        }
        if (!Number.isInteger(source.row_count) || source.row_count < 2 ||
            source.row_count > 400001 || indexes.length > 100) {
            throw new Error("작업 시트에 복사할 행·열 개수를 확인하세요.");
        }

        return Excel.run(async function (context) {
            var sheets = context.workbook.worksheets;
            var original = sheets.getItem(source.worksheet_id);
            var existing = sheets.getItemOrNullObject(sheetName);
            var settingKey = "kcs.workspace." + sheetName;
            var saved = context.workbook.settings.getItemOrNullObject(settingKey);
            var headers = original.getRangeByIndexes(
                source.row_start, source.column_start, 1, source.column_count
            );
            existing.load("id");
            saved.load("value");
            headers.load("text");
            original.load("name");
            await context.sync();
            if (!existing.isNullObject) {
                if (!saved.isNullObject && saved.value &&
                    saved.value.worksheet_id === existing.id && saved.value.table_id) {
                    existing.activate();
                    await context.sync();
                    return saved.value;
                }
                throw new Error(sheetName + " 시트가 이미 있습니다. 부분 복사 결과를 확인하세요.");
            }
            if (indexes.some(function (index) {
                return headers.text[0][index] !== source.headers[index];
            })) {
                throw new Error("원본 열 구성이 바뀌었습니다. 범위를 다시 가져오세요.");
            }

            var sheet = sheets.add(sheetName);
            var dataRows = source.row_count - 1;
            try {
                sheet.load("id,name");
                var names = ["원본 행 번호"].concat(indexes.map(function (index) {
                    return (source.headers[index] || "열 " + (index + 1)).slice(0, 255);
                }));
                var header = sheet.getRangeByIndexes(0, 0, 1, names.length);
                header.numberFormat = [names.map(function () { return "@"; })];
                header.values = [names.map(function (name) { return "'" + name; })];
                header.format.columnWidth = 140;
                await context.sync();

                // ponytail: 한 묶음은 약 20,000셀. 실측에 따라 묶음 크기를 조정한다.
                var chunkRows = Math.max(1, Math.min(2000, Math.floor(20000 / names.length)));
                for (var offset = 0; offset < dataRows; offset += chunkRows) {
                    var count = Math.min(chunkRows, dataRows - offset);
                    indexes.forEach(function (index, outputIndex) {
                        var input = original.getRangeByIndexes(
                            source.row_start + 1 + offset,
                            source.column_start + index, count, 1
                        );
                        var output = sheet.getRangeByIndexes(offset + 1, outputIndex + 1, count, 1);
                        output.copyFrom(input, "Formats");
                        output.copyFrom(input, "Values");
                    });
                    sheet.getRangeByIndexes(offset + 1, 0, count, 1).values =
                        Array.from({length: count}, function (_, index) {
                            return [source.row_start + offset + index + 2];
                        });
                    await context.sync();
                    if (onProgress) onProgress(offset + count, dataRows);
                }

                // 표 정렬 시 원본 행 연결도 함께 움직인다. 열 ID는 이름 변경에도 유지된다.
                var table = sheet.tables.add(
                    sheet.getRangeByIndexes(0, 0, source.row_count, names.length), true
                );
                table.load("id");
                table.columns.load("items/id,items/name,items/index");
                var data = sheet.getRangeByIndexes(1, 1, dataRows, indexes.length);
                data.load("address");
                await context.sync();
                var columns = indexes.map(function (index, outputIndex) {
                    var reference = references.find(function (item) {
                        return item.source_index === index;
                    });
                    var column = table.columns.items[outputIndex + 1];
                    return {
                        column_id: column.id,
                        column_index: column.index,
                        header: column.name,
                        source_index: index,
                        source_column_index: source.column_start + index,
                        source_header: source.headers[index],
                        role: roles.find(function (role) {
                            return source.mapping[role] === index;
                        }) || "reference",
                        description: reference ? reference.description : ""
                    };
                });
                var workspace = {
                    task_type: source.task_type,
                    worksheet_id: sheet.id,
                    sheet_name: sheet.name,
                    table_id: table.id,
                    source_row_column_id: table.columns.items[0].id,
                    source: {
                        worksheet_id: source.worksheet_id,
                        sheet_name: original.name,
                        address: source.address
                    },
                    row_count: dataRows,
                    columns: columns,
                    target: {
                        worksheet_id: sheet.id, sheet_name: sheet.name,
                        address: data.address, row_start: 1, row_count: dataRows,
                        column_count: columns.length, columns: columns
                    }
                };
                // 열 설명을 통합문서 설정에 함께 보관한다. LLM 호출은 하지 않는다.
                context.workbook.settings.add(settingKey, workspace);
                context.workbook.settings.add("kcs.workspace.current", workspace);
                sheet.getRange("A:A").columnHidden = true;
                sheet.activate();
                data.select();
                await context.sync();
                return workspace;
            } catch (error) {
                throw new Error(
                    sheetName + " 시트에 일부 결과가 남아 있을 수 있습니다. " +
                    "원본은 변경하지 않았습니다. " + error.message
                );
            }
        });
    }

    window.workspaceCopy = {create: create};
})();
